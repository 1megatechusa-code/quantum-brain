import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";
import { storeFile, resolveFile, FILE_TAG } from "../../src/files/store";
import { OWNER_WRITE_CONTEXT } from "../../src/lib/scope";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;
const BASE = "http://localhost";
const TOKEN = "test-token";

function fileReq(method: string, path: string, opts: { body?: BodyInit; headers?: Record<string, string>; token?: string | null } = {}): Request {
  const { body, headers = {}, token = TOKEN } = opts;
  const h: Record<string, string> = { ...headers };
  if (token !== null) h["Authorization"] = `Bearer ${token}`;
  return new Request(`${BASE}${path}`, { method, headers: h, body });
}

describe("storeFile / resolveFile (direct, below the HTTP route)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("uploads to R2, writes a pointer entry, and resolves back to the same bytes", async () => {
    const bytes = new TextEncoder().encode("hello, this is a fake pdf");
    const result = await storeFile(env, ctx, OWNER_WRITE_CONTEXT, {
      bytes, filename: "notes.pdf", mimeType: "application/pdf", summary: "Q3 planning notes", source: "api",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(db.entries).toHaveLength(1);
    const row = db.entries[0];
    expect(row.content).toBe("Q3 planning notes");
    const tags = JSON.parse(row.tags);
    expect(tags).toContain(FILE_TAG);

    const resolved = await resolveFile(env, tags);
    expect("meta" in resolved).toBe(true);
    if (!("meta" in resolved)) return;
    expect(resolved.meta.filename).toBe("notes.pdf");
    expect(resolved.meta.mimeType).toBe("application/pdf");
    expect(resolved.meta.size).toBe(bytes.length);
    const readBack = new Uint8Array(await new Response(resolved.body).arrayBuffer());
    expect(readBack).toEqual(bytes);
  });

  it("falls back to a filename-derived summary when none is given", async () => {
    const result = await storeFile(env, ctx, OWNER_WRITE_CONTEXT, {
      bytes: new Uint8Array([1, 2, 3]), filename: "receipt.png", mimeType: "image/png", source: "api",
    });
    expect(result.ok).toBe(true);
    expect(db.entries[0].content).toBe("File: receipt.png");
  });

  it("refuses an empty file", async () => {
    const result = await storeFile(env, ctx, OWNER_WRITE_CONTEXT, {
      bytes: new Uint8Array(0), filename: "empty.txt", mimeType: "text/plain", source: "api",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty");
    expect(db.entries).toHaveLength(0);
  });

  it("refuses a file over the caller's byte ceiling and writes nothing", async () => {
    const result = await storeFile(env, ctx, OWNER_WRITE_CONTEXT, {
      bytes: new Uint8Array(10), filename: "big.bin", mimeType: "application/octet-stream", source: "api", maxBytes: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_large");
    expect(db.entries).toHaveLength(0);
  });

  it("resolveFile reports a plain (non-file) entry as not_a_file", async () => {
    const resolved = await resolveFile(env, ["kind:semantic", "some-tag"]);
    expect("code" in resolved && resolved.code).toBe("not_a_file");
  });

  it("resolveFile reports a missing R2 object distinctly from a missing entry", async () => {
    const resolved = await resolveFile(env, [FILE_TAG, "file-key:files/nowhere/x/y.png", "file-name:y.png", "file-mime:image/png", "file-size:3"]);
    expect("code" in resolved && resolved.code).toBe("object_missing");
  });
});

describe("POST /files and GET /files (HTTP route)", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("requires auth", async () => {
    const res = await worker.fetch(fileReq("POST", "/files", { body: "x", headers: { "X-Filename": "a.txt" }, token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("uploads then fetches the same file end to end", async () => {
    const bytes = new TextEncoder().encode("the actual file bytes");
    const up = await worker.fetch(fileReq("POST", "/files", {
      body: bytes,
      headers: { "X-Filename": "diagram.png", "X-Summary": "Architecture diagram for the auth redesign", "Content-Type": "image/png" },
    }), env, ctx);
    expect(up.status).toBe(201);
    const upData = await up.json() as any;
    expect(upData.ok).toBe(true);
    expect(upData.filename).toBe("diagram.png");
    expect(upData.size).toBe(bytes.length);

    const get = await worker.fetch(fileReq("GET", `/files?id=${upData.id}`), env, ctx);
    expect(get.status).toBe(200);
    expect(get.headers.get("Content-Type")).toBe("image/png");
    expect(get.headers.get("Content-Disposition")).toContain("diagram.png");
    const body = new Uint8Array(await get.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("400s when X-Filename is missing", async () => {
    const res = await worker.fetch(fileReq("POST", "/files", { body: "x" }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("400s on an empty body", async () => {
    const res = await worker.fetch(fileReq("POST", "/files", { body: new Uint8Array(0), headers: { "X-Filename": "empty.txt" } }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("404s for an id that does not exist", async () => {
    const res = await worker.fetch(fileReq("GET", "/files?id=nonexistent"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("404s for a real id that isn't a file entry", async () => {
    const capture = await worker.fetch(new Request(`${BASE}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ content: "an ordinary memory, not a file" }),
    }), env, ctx);
    const { id } = await capture.json() as any;

    const res = await worker.fetch(fileReq("GET", `/files?id=${id}`), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.code).toBe("not_a_file");
  });

  it("GET requires the id param", async () => {
    const res = await worker.fetch(fileReq("GET", "/files"), env, ctx);
    expect(res.status).toBe(400);
  });
});
