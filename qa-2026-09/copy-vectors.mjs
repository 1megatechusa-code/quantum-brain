#!/usr/bin/env node
/**
 * Copy every vector D1 knows about from one Vectorize index to another,
 * unchanged — the A0 fix's migration step (qa-2026-09/diagnosis.md, Option B).
 *
 *   node qa-2026-09/copy-vectors.mjs snapshot   # D1 ids → fetch from SOURCE → NDJSON in $OUT
 *   node qa-2026-09/copy-vectors.mjs upsert     # NDJSON → TARGET (idempotent)
 *   node qa-2026-09/copy-vectors.mjs verify     # every D1 id present in TARGET with identical values
 *   node qa-2026-09/copy-vectors.mjs delta      # ids in D1 missing from TARGET (post-cutover reconcile)
 *
 * Everything goes through the wrangler CLI (already authenticated on this
 * machine), so no API token is read or handled here. The id list comes from
 * D1 `entries.vector_ids` — the authoritative record of which vectors exist —
 * and values + metadata come from the SOURCE index by id. Nothing is
 * transformed: the `namespace: null` key wrangler prints on a fetched vector is
 * the only field dropped, because it is output decoration, not stored data.
 *
 * The NDJSON snapshot contains memory content, so OUT defaults to the session
 * scratchpad, never the repo.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const SOURCE = process.env.SOURCE_INDEX ?? "second-brain-vectors";
const TARGET = process.env.TARGET_INDEX ?? "quantum-brain-vectors";
const D1 = process.env.D1_NAME ?? "quantum-brain";
const OUT = process.env.OUT ?? resolve(tmpdir(), "quantum-brain-a0");
const GET_BATCH = 20; // Vectorize getByIds ceiling (VECTORIZE_GET_BY_IDS_BATCH in src/constants.ts)
const SNAPSHOT = resolve(OUT, "vectors.ndjson");
const D1_IDS = resolve(OUT, "d1-ids.json");

const mode = process.argv[2];
if (!["snapshot", "upsert", "verify", "delta"].includes(mode)) {
  console.error("usage: copy-vectors.mjs snapshot|upsert|verify|delta");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

function wrangler(args, { json = true } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} exited ${r.status}`);
  }
  if (!json) return r.stdout;
  const start = r.stdout.indexOf(r.stdout.includes("\n[") || r.stdout.startsWith("[") ? "[" : "{");
  if (start < 0) {
    // wrangler prints a warning instead of JSON when nothing matched.
    return null;
  }
  return JSON.parse(r.stdout.slice(start));
}

/** Authoritative id list: every vector id D1 says exists, with the row's workspace. */
function d1Ids() {
  const rows = wrangler(["d1", "execute", D1, "--remote", "--json", "--command",
    `"SELECT id, workspace_id, vector_ids FROM entries"`])[0].results;
  const out = [];
  for (const r of rows) for (const v of JSON.parse(r.vector_ids)) out.push({ vectorId: v, entryId: r.id, workspaceId: r.workspace_id });
  return out;
}

function fetchByIds(index, ids) {
  const found = [];
  for (let i = 0; i < ids.length; i += GET_BATCH) {
    const batch = ids.slice(i, i + GET_BATCH);
    const got = wrangler(["vectorize", "get-vectors", index, "--ids", ...batch]) ?? [];
    found.push(...got);
  }
  return found;
}

if (mode === "snapshot") {
  const ids = d1Ids();
  writeFileSync(D1_IDS, JSON.stringify(ids, null, 2));
  console.log(`D1: ${ids.length} vector ids across ${new Set(ids.map(x => x.entryId)).size} entries`);
  const vectors = fetchByIds(SOURCE, ids.map(x => x.vectorId));
  const byId = new Map(vectors.map(v => [v.id, v]));
  const missing = ids.filter(x => !byId.has(x.vectorId));
  const wsMismatch = ids.filter(x => byId.has(x.vectorId) && byId.get(x.vectorId).metadata?.workspace_id !== x.workspaceId);
  console.log(`${SOURCE}: fetched ${vectors.length}/${ids.length}; missing ${missing.length}; workspace mismatches ${wsMismatch.length}`);
  if (missing.length) console.log("  missing:", missing.map(x => x.vectorId).join(", "));
  if (wsMismatch.length) console.log("  mismatches:", wsMismatch.map(x => `${x.vectorId} d1=${x.workspaceId} idx=${byId.get(x.vectorId).metadata?.workspace_id}`).join("\n  "));
  if (missing.length || wsMismatch.length) {
    console.error("Refusing to write a snapshot that does not match D1 — review the lines above.");
    process.exit(1);
  }
  // Pure copy: id, values, metadata exactly as stored. Only the printed
  // `namespace: null` decoration is left out.
  const lines = ids.map(x => { const v = byId.get(x.vectorId); return JSON.stringify({ id: v.id, values: v.values, metadata: v.metadata }); });
  writeFileSync(SNAPSHOT, lines.join("\n") + "\n");
  const perWs = {};
  for (const x of ids) perWs[x.workspaceId] = (perWs[x.workspaceId] ?? 0) + 1;
  console.log(`snapshot written: ${SNAPSHOT} (${lines.length} vectors)`);
  console.log("per workspace:", JSON.stringify(perWs, null, 2));
}

if (mode === "upsert") {
  if (!existsSync(SNAPSHOT)) throw new Error(`no snapshot at ${SNAPSHOT}; run snapshot first`);
  const n = readFileSync(SNAPSHOT, "utf8").split("\n").filter(Boolean).length;
  console.log(`upserting ${n} vectors into ${TARGET} from ${SNAPSHOT}`);
  console.log(wrangler(["vectorize", "upsert", TARGET, "--file", `"${SNAPSHOT}"`, "--batch-size", "100"], { json: false }));
}

if (mode === "verify" || mode === "delta") {
  const ids = d1Ids();
  const inTarget = new Map(fetchByIds(TARGET, ids.map(x => x.vectorId)).map(v => [v.id, v]));
  const missing = ids.filter(x => !inTarget.has(x.vectorId));
  if (mode === "delta") {
    console.log(`D1 ids: ${ids.length}; present in ${TARGET}: ${ids.length - missing.length}; missing: ${missing.length}`);
    for (const m of missing) console.log("  missing:", m.vectorId, "entry", m.entryId, "ws", m.workspaceId);
    process.exit(missing.length ? 1 : 0);
  }
  // verify: values and metadata must be byte-identical to the snapshot taken from SOURCE.
  const snap = new Map(readFileSync(SNAPSHOT, "utf8").split("\n").filter(Boolean).map(l => { const v = JSON.parse(l); return [v.id, v]; }));
  let valueDiff = 0, metaDiff = 0;
  const perWs = {};
  for (const x of ids) {
    const t = inTarget.get(x.vectorId); const s = snap.get(x.vectorId);
    if (!t || !s) continue;
    if (JSON.stringify(t.values) !== JSON.stringify(s.values)) valueDiff++;
    if (JSON.stringify(t.metadata) !== JSON.stringify(s.metadata)) metaDiff++;
    const ws = t.metadata?.workspace_id ?? "(none)";
    perWs[ws] = (perWs[ws] ?? 0) + 1;
  }
  console.log(`D1 ids: ${ids.length}; present in ${TARGET}: ${ids.length - missing.length}; missing: ${missing.length}; value diffs: ${valueDiff}; metadata diffs: ${metaDiff}`);
  console.log("per workspace in target:", JSON.stringify(perWs, null, 2));
  for (const m of missing) console.log("  missing:", m.vectorId);
  process.exit(missing.length || valueDiff || metaDiff ? 1 : 0);
}
