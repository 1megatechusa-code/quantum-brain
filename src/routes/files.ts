import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentity, type Identity } from "../lib/identity";
import { getReadableEntry } from "../lib/entry-access";
import { resolveConfig } from "../config";
import { effectiveWriteTarget, readTeamParam, scopeWrite, type WriteContext } from "../lib/scope";
import { validInputTags } from "../tags/system";
import { storeFile, resolveFile, MAX_FILE_BYTES } from "../files/store";

/**
 * POST /files and GET /files?id= — the real #8 file storage capability.
 * Mirrors the MCP `upload_file` tool the same way every other route/tool
 * pair in src/routes does: same underlying storeFile/resolveFile, so the two
 * surfaces cannot drift on what a file upload means or where it lands. This
 * route has no MAX_MCP_FILE_BYTES ceiling of its own — an HTTP client streams
 * the body directly, so only storeFile's own MAX_FILE_BYTES applies.
 */

/** Same shape as capture.ts's writeContextFor — kept local rather than shared because the inputs differ (headers here, JSON body there) and the two would otherwise need a needless parameter object just to look shared. */
async function writeContextFor(
  env: Env,
  identity: Identity,
  workspace?: string | null,
  team?: string | null,
): Promise<WriteContext | Response> {
  const orgDefault = (await resolveConfig(env)).TEAM_DEFAULT_WORKSPACE;
  if (workspace !== undefined && workspace !== null && workspace !== "personal" && workspace !== "company") {
    return json({ ok: false, error: 'X-Workspace must be "personal" or "company"' }, 400);
  }
  const resolvedTarget = effectiveWriteTarget(identity, workspace ?? undefined, orgDefault);
  const teamRead = readTeamParam(team ?? undefined, identity, resolvedTarget);
  if (teamRead.error) return json({ ok: false, error: teamRead.error }, 400);
  return { workspaceId: scopeWrite(identity, resolvedTarget, teamRead.teamId), actorId: identity.userId };
}

export async function handleFilesRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname !== "/files") return null;

  if (request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const filename = request.headers.get("X-Filename")?.trim();
    if (!filename) return json({ ok: false, error: "X-Filename header is required" }, 400);
    const summary = request.headers.get("X-Summary")?.trim() || undefined;
    const mimeType = request.headers.get("Content-Type")?.trim() || "application/octet-stream";
    const tagsHeader = request.headers.get("X-Tags")?.trim();
    const tags = tagsHeader ? tagsHeader.split(",").map(t => t.trim()).filter(Boolean) : undefined;
    if (tags && !validInputTags(tags)) return json({ ok: false, error: "X-Tags entries must be NUL-free" }, 400);

    const writeCtx = await writeContextFor(env, auth, request.headers.get("X-Workspace"), request.headers.get("X-Team"));
    if (writeCtx instanceof Response) return writeCtx;

    // Read fully before validating size against MAX_FILE_BYTES: a Content-Length
    // header can lie or be absent, so the actual byte count is what storeFile
    // checks. A request over the Worker's own body-size ceiling never reaches
    // here at all — that limit is enforced by the platform, not this code.
    const bytes = new Uint8Array(await request.arrayBuffer());

    const result = await storeFile(env, ctx, writeCtx, { bytes, filename, mimeType, summary, tags, source: "api" });
    if (!result.ok) {
      const status = result.code === "too_large" ? 413 : result.code === "empty" ? 400 : 502;
      return json({ ok: false, error: result.error, code: result.code }, status);
    }
    return json({ ok: true, id: result.id, filename: result.filename, size: result.size, maxBytes: MAX_FILE_BYTES }, 201);
  }

  if (request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;

    const id = url.searchParams.get("id")?.trim();
    if (!id) return json({ ok: false, error: "id is required" }, 400);

    const entry = await getReadableEntry(env, auth, id, "id, workspace_id, actor_id, tags");
    if (!entry) return json({ ok: false, error: `No entry found with ID: ${id}` }, 404);

    let tags: string[] = [];
    try { tags = JSON.parse(entry.tags ?? "[]"); } catch { tags = []; }
    const resolved = await resolveFile(env, tags);
    if ("code" in resolved) {
      return json({ ok: false, error: resolved.error, code: resolved.code }, resolved.code === "not_a_file" ? 400 : 404);
    }

    return new Response(resolved.body, {
      status: 200,
      headers: {
        "Content-Type": resolved.meta.mimeType,
        "Content-Length": String(resolved.meta.size),
        "Content-Disposition": `attachment; filename="${resolved.meta.filename.replace(/"/g, "'")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
}
