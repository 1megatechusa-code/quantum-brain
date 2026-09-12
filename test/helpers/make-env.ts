import { vi } from "vitest";
import { D1Mock } from "./d1-mock";
import type { Env } from "../../src/env";

export function makeVectorizeMock(overrides: Partial<VectorizeIndex> = {}): VectorizeIndex {
  return {
    query: vi.fn().mockResolvedValue({ matches: [] }),
    insert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    deleteByIds: vi.fn().mockResolvedValue({ mutationId: "m" }),
    upsert: vi.fn().mockResolvedValue({ mutationId: "m" }),
    getByIds: vi.fn().mockResolvedValue([]),
    describe: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as VectorizeIndex;
}

export function makeAIMock(): Ai {
  return {
    run: vi.fn().mockImplementation(async (model: string) => {
      // Every bge-* model here is an embedding call (bge-small is the
      // shipped default; bge-base/large/m3 are config-selectable) — anything
      // else is assumed to be an LLM chat completion, below.
      if (model.startsWith("@cf/baai/bge"))
        return { data: [new Array(384).fill(0.1)] };
      return new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"response":"3"}\n\n'));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      });
    }),
  } as unknown as Ai;
}

export function makeTestDb() { return new D1Mock(); }

export function makeKVMock(): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

// Stateful in-memory KV for tests where reads must see prior writes (the
// integrations flow) — makeKVMock above always returns null.
export function makeMemoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, String(value)); },
    delete: async (key: string) => { store.delete(key); },
    list: async (opts: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter(k => !opts.prefix || k.startsWith(opts.prefix))
        .map(name => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

/** In-memory R2 mock — stateful (unlike makeKVMock) because file-route tests round-trip an upload through get() in the same test. */
export function makeR2Mock(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata }>();
  return {
    put: vi.fn().mockImplementation(async (key: string, value: unknown, options?: { httpMetadata?: R2HTTPMetadata }) => {
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(0);
      store.set(key, { bytes, httpMetadata: options?.httpMetadata });
      return { key } as unknown as R2Object;
    }),
    get: vi.fn().mockImplementation(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      const bytes = entry.bytes;
      return {
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        httpMetadata: entry.httpMetadata,
        size: bytes.length,
      } as unknown as R2ObjectBody;
    }),
    delete: vi.fn().mockImplementation(async (key: string) => { store.delete(key); }),
  } as unknown as R2Bucket;
}

export function makeTestEnv(db?: D1Mock, overrides: Partial<Env> = {}): Env {
  return {
    DB: (db ?? new D1Mock()) as unknown as D1Database,
    VECTORIZE: makeVectorizeMock(),
    AI: makeAIMock(),
    AUTH_TOKEN: "test-token",
    OAUTH_KV: makeKVMock(),
    FILES: makeR2Mock(),
    ...overrides,
  };
}
