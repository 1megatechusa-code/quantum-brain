import type { Env } from "../env";
import { resolveConfig, type Config } from "../config";
import { storeEntry } from "../capture/store";
import { auditEvent } from "../lib/audit";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../lib/scope";

/**
 * Real file storage for the #8 capability (design validated 2026-09-12,
 * built for real here). remember() only ever accepted text, so a file lives
 * in R2 under a key this module controls, and the `entries` row beside it
 * carries a short, human-written SUMMARY as its content plus a handful of
 * `file-*` tags pointing at the object — never the file's bytes. That summary
 * is what recall() actually searches: a file is findable the same way any
 * other memory is, because it IS one, with a pointer riding along in its tags.
 *
 * Deliberately bypasses captureEntry's duplicate/contradiction pipeline and
 * calls storeEntry directly (the same primitive captureEntry itself calls
 * once its own checks pass). A file upload is not a claim that competes with
 * an existing memory for truth — "this summary sounds like one you already
 * have" is a false and confusing reason to refuse to store someone's file —
 * so there is nothing here for that pipeline to usefully adjudicate.
 */

/** Tag marking an entry as a file pointer rather than a plain memory. */
export const FILE_TAG = "file";
const FILE_KEY_PREFIX = "file-key:";
const FILE_NAME_PREFIX = "file-name:";
const FILE_MIME_PREFIX = "file-mime:";
const FILE_SIZE_PREFIX = "file-size:";

/**
 * R2 PUT accepts far larger objects than this, and Workers itself can stream
 * a much bigger request body — the ceiling here is deliberately conservative
 * for a v1: it is comfortably inside a single Worker invocation's memory and
 * CPU budget with room to spare, and every caller so far (photos, PDFs,
 * exported documents) fits it many times over. Raise it once something real
 * needs to exceed it, rather than sizing against a synthetic worst case now.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * The MCP tool's ceiling is far tighter than the HTTP route's: a base64
 * upload rides inside one MCP tool-call JSON payload, base64 inflates bytes
 * by ~4/3, and the whole payload still has to fit in the calling model's
 * context alongside everything else in the conversation. 4 MB decoded
 * (~5.3 MB encoded) covers the common case — images, short PDFs, exported
 * notes — without risking a call so large it gets truncated or rejected
 * before this code ever sees it. POST /files has no such ceiling of its own
 * (it inherits MAX_FILE_BYTES) because an HTTP client streams the body
 * directly; there is no JSON-in-a-prompt tax to pay.
 */
export const MAX_MCP_FILE_BYTES = 4 * 1024 * 1024; // 4 MB

/** Characters kept from the caller's filename; everything else becomes `_`. */
const FILENAME_SAFE = /[^A-Za-z0-9._-]/g;
const MAX_FILENAME_CHARS = 200;

/** Strips path separators and control characters so a filename can never escape its R2 prefix or corrupt a tag. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(FILENAME_SAFE, "_").slice(0, MAX_FILENAME_CHARS);
  return cleaned || "file";
}

/** The R2 object key for one uploaded file. `id` is the entry's own id, so the two are always found together. */
export function fileR2Key(workspaceId: string, id: string, filename: string): string {
  // workspaceId can legitimately be "" (pre-tenancy / owner-only brains) — kept
  // as a real path segment rather than special-cased, so every key still sorts
  // and lists cleanly under files/<workspace>/... including that one.
  return `files/${workspaceId}/${id}/${sanitizeFilename(filename)}`;
}

export interface FileMeta {
  r2Key: string;
  filename: string;
  mimeType: string;
  size: number;
}

function fileTagsFor(meta: FileMeta): string[] {
  return [
    FILE_TAG,
    `${FILE_KEY_PREFIX}${meta.r2Key}`,
    `${FILE_NAME_PREFIX}${meta.filename}`,
    `${FILE_MIME_PREFIX}${meta.mimeType}`,
    `${FILE_SIZE_PREFIX}${meta.size}`,
  ];
}

/** Reads the file-* tags back off an entry. Returns null when the entry isn't a file entry (no `file` tag) or the pointer is malformed. */
export function parseFileTags(tags: string[]): FileMeta | null {
  if (!tags.includes(FILE_TAG)) return null;
  const find = (prefix: string) => tags.find(t => t.startsWith(prefix))?.slice(prefix.length);
  const r2Key = find(FILE_KEY_PREFIX);
  const filename = find(FILE_NAME_PREFIX);
  const mimeType = find(FILE_MIME_PREFIX);
  const sizeRaw = find(FILE_SIZE_PREFIX);
  const size = sizeRaw !== undefined ? Number(sizeRaw) : NaN;
  if (!r2Key || !filename || !mimeType || !Number.isFinite(size)) return null;
  return { r2Key, filename, mimeType, size };
}

export interface StoreFileInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  /** Human-written description — this is what recall() actually matches on. Falls back to the filename when omitted. */
  summary?: string;
  source: string;
  /** Extra tags to ride alongside the file-* ones (e.g. caller-supplied categorisation). `file` is always added regardless. */
  tags?: string[];
  /** Overrides MAX_FILE_BYTES for this call — the MCP tool passes MAX_MCP_FILE_BYTES. */
  maxBytes?: number;
}

export type StoreFileResult =
  | { ok: true; id: string; r2Key: string; size: number; filename: string }
  | { ok: false; code: "too_large" | "empty" | "storage_failed"; error: string };

/**
 * Uploads bytes to R2, then writes the pointer + summary entry — the exact
 * two-part shape src/capture/entry.ts's captureEntry uses for every new
 * memory: a synchronous `INSERT INTO entries` with vector_ids left `'[]'`,
 * committed before this function returns, then embedding fired through
 * ctx.waitUntil so a slow or failed Vectorize call never blocks (or breaks)
 * the write itself. storeEntry, defined in src/capture/store.ts, is NOT that INSERT —
 * despite the name it only re-embeds and UPDATEs vector_ids on a row that
 * already exists, which is why it is the waitUntil half here and not the
 * primitive that creates the row.
 *
 * R2 is written before the entry row, not after: if the entry write then
 * fails, the object is a harmless orphan (worth a sweep later, never worse
 * than that); the reverse order would let an entry point at a file that was
 * never actually written, which resolveFile below would have no way to tell
 * apart from a real R2 outage. On an entry-write failure the object is
 * deleted best-effort so a retried upload does not also leak storage.
 *
 * Deliberately does NOT go through captureEntry: that function's duplicate
 * and contradiction detection exists to adjudicate competing claims about
 * the truth, and a file's summary is not a claim to adjudicate — "this
 * sounds like a memory you already have" is a false and confusing reason to
 * refuse to store someone's file.
 */
export async function storeFile(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  writeCtx: WriteContext = OWNER_WRITE_CONTEXT,
  input: StoreFileInput,
  config?: Readonly<Config>,
): Promise<StoreFileResult> {
  const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
  if (!input.bytes.length) return { ok: false, code: "empty", error: "The file is empty." };
  if (input.bytes.length > maxBytes) {
    return {
      ok: false, code: "too_large",
      error: `File is ${input.bytes.length} bytes, over the ${maxBytes} byte limit for this upload path.`,
    };
  }

  const cfg = config ?? await resolveConfig(env);
  const id = crypto.randomUUID();
  const now = Date.now();
  const filename = sanitizeFilename(input.filename);
  const mimeType = input.mimeType.trim() || "application/octet-stream";
  const r2Key = fileR2Key(writeCtx.workspaceId, id, filename);

  await env.FILES.put(r2Key, input.bytes, { httpMetadata: { contentType: mimeType } });

  const meta: FileMeta = { r2Key, filename, mimeType, size: input.bytes.length };
  const tags = [...fileTagsFor(meta), ...(input.tags ?? [])];
  const content = input.summary?.trim() || `File: ${filename}`;

  try {
    await env.DB.prepare(
      `INSERT INTO entries (id, content, tags, source, created_at, updated_at, vector_ids, workspace_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, content, JSON.stringify(tags), input.source, now, now, "[]", writeCtx.workspaceId, writeCtx.actorId).run();
  } catch (e) {
    // Best-effort: an orphaned R2 object costs storage; a failed delete on top
    // of a failed insert costs nothing further, so its own error is swallowed
    // rather than shadowing the real failure below.
    await env.FILES.delete(r2Key).catch(() => {});
    console.error("storeFile: entry write failed after R2 put, object removed:", e);
    return { ok: false, code: "storage_failed", error: "Could not save the file record. Nothing was kept." };
  }

  // Non-blocking, same as captureEntry: a slow or unreachable Vectorize must
  // not delay (or fail) a file upload that has already committed to D1 and R2.
  // Until this resolves the entry is keyword-findable only, exactly like any
  // other fresh capture in the same window.
  ctx.waitUntil(
    storeEntry(env, id, content, tags, input.source, now, cfg, writeCtx)
      .catch(e => console.error("storeFile: embedding failed (non-fatal):", e))
  );

  auditEvent(env, ctx, { entryId: id, actorId: writeCtx.actorId, event: "created", payload: { file: true, filename, mimeType, size: meta.size } });
  return { ok: true, id, r2Key, size: meta.size, filename };
}

/** Decodes a base64 string (as sent by the MCP `upload_file` tool) into raw bytes. `atob` yields one char per byte, which is exactly what Uint8Array wants here — no TextEncoder involved, that would reinterpret the bytes as UTF-8 and corrupt anything non-ASCII. */
export function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface ResolvedFile {
  meta: FileMeta;
  body: ReadableStream;
}

export type ResolveFileError = { code: "not_a_file" | "object_missing"; error: string };

/** Reads an already-fetched entry's tags and streams the R2 object they point at. The caller is responsible for the readability/scope check on the entry itself (getReadableEntry). */
export async function resolveFile(env: Env, tags: string[]): Promise<ResolvedFile | ResolveFileError> {
  const meta = parseFileTags(tags);
  if (!meta) return { code: "not_a_file", error: "This entry is not a file." };
  const object = await env.FILES.get(meta.r2Key);
  if (!object) return { code: "object_missing", error: "The file record exists but its stored object is gone." };
  return { meta, body: object.body };
}
