# A0 fix log — new Vectorize index with `workspace_id` metadata index (Option B)

Date: 2026-09-14 · Branch: `qa-fixes-2026-09` · Cloudflare account `0f31c83d8f928ef06f0f6649fd9406bf`
Worker: `quantum-brain` → https://quantum-brain.1megatechusa.workers.dev · D1: `quantum-brain`

Companion to `diagnosis.md` (finding A0). This document records what was done; it does not repeat the
diagnosis.

## What was created

| Resource | Detail |
|---|---|
| Vectorize index **`quantum-brain-vectors`** | 384 dims, cosine. Created 2026-09-14 ~09:19 UTC. |
| Metadata index on it | `workspace_id`, type `String`. Created 2026-09-14 09:21 UTC (mutation `89cbbcdc-…`), **before** any vector was written, so every vector is indexed on it. |
| `qa-2026-09/copy-vectors.mjs` | The migration script (committed in `99b31e2`). |

Verified with `wrangler vectorize list-metadata-index quantum-brain-vectors` → `workspace_id · String`.

## Re-upsert method

`node qa-2026-09/copy-vectors.mjs snapshot | upsert | verify | delta`. Everything goes through the
wrangler CLI (already authenticated on this machine); the script reads and handles no API token.

1. **Authoritative id list** from D1: `SELECT id, workspace_id, vector_ids FROM entries` → 104 vector ids
   across 90 entries (a 91st entry is `status:deprecated` with `vector_ids = []`, correctly unindexed).
2. **Values + metadata** fetched from `second-brain-vectors` **by id** (`get-vectors`, batches of 20 — the
   same ceiling `VECTORIZE_GET_BY_IDS_BATCH` the Worker uses). The script refuses to write a snapshot if any
   D1 id is missing from the source index or if a vector's stored `workspace_id` disagrees with D1's row.
   Result: fetched 104/104, missing 0, workspace mismatches 0.
3. **Snapshot** written as NDJSON to the session scratchpad (contains memory content; never in the repo).
   Pure copy — `id`, `values`, `metadata` exactly as stored. The only field dropped is the `namespace: null`
   decoration wrangler prints on fetched vectors, which is not stored data.
4. **Upsert** into `quantum-brain-vectors` (`wrangler vectorize upsert --file … --batch-size 100`): two
   mutations (100 + 4), `vectorCount` reached 104 within ~15 s.

`POST /migration/reembed` was deliberately **not** used: it skips `deleteStaleVectors` and regenerates
chunk ids only, which would have orphaned every append (`-update-<ts>`) vector.

## Verification (before cutover)

`copy-vectors.mjs verify` — every D1 id fetched back from the new index and compared to the snapshot:

```
D1 ids: 104; present in quantum-brain-vectors: 104; missing: 0; value diffs: 0; metadata diffs: 0
per workspace: ws-b928a083… (Head7) 48 · ws-ea8bf940… 28 · ws-1925db93… 27 · ws-01f02608… 1
```

Filtered queries directly against the new index (wrangler `query --vector-id <a Head7 chunk> --filter …`):

| # | Filter | Result |
|---|---|---|
| 1 | `$in [Head7 ws]` | 5 matches, all Head7, top score 1.000 (the vector itself) |
| 2 | `$in [customer ws-ea8b…]` | 5 matches, **all** that customer, zero Head7 |
| 3 | `$eq customer ws` (the write path's `singleWorkspaceFilter` form) | 5 matches, all that customer |
| 4 | `$in [company ws-bbaf…]` (holds no vectors) | 0 — the filter genuinely filters |
| 5 | Control: same query as #1 against **`second-brain-vectors`** | 0 — old index unchanged, still un-indexed |

Config: `wrangler deploy --dry-run` resolved `env.VECTORIZE (quantum-brain-vectors)`.

## Write freeze and cutover

No freeze mechanism exists in the code (no maintenance flag / read-only mode). All four tenants are the
owner's own accounts (Head7 + three test subscriptions), so the freeze was **operator-declared** — no
`remember`/`append`/`update`/`upload_file`/import from any client — bracketed by `delta` checks on both
sides of the deploy, and timed off the `:30` hourly integration-sync cron and outside the 01:00–02:45 UTC
maintenance window. The deploy was a bare `npx wrangler deploy` (not `scripts/release.mjs`, which pushes
and opens PRs); `scripts/predeploy-guard.mjs` passed.

| Step | UTC | Result |
|---|---|---|
| Pre-deploy `delta` | 2026-09-14T10:03:51Z | 104 D1 ids, 104 present, **0 missing** |
| `wrangler deploy` start | **2026-09-14T10:05:33Z** | — |
| Deploy live | **2026-09-14T10:06:04Z** | Version `349d92f0-49d7-4855-a71d-0351ed0dd5f3`, `env.VECTORIZE (quantum-brain-vectors)` |
| Post-deploy `delta` | 2026-09-14T10:06:16Z | 104 D1 ids, 104 present, **0 missing** — nothing slipped through |
| Old index check | 2026-09-14T10:06 | `second-brain-vectors`: 104 vectors, `processedUpToMutation 7d422b4e-…` @ 2026-09-13T21:32:02Z — **identical to before** |

Effective cutover: **2026-09-14T10:06:04Z**.

## Live smoke test (via the `quantum-brain-product` MCP connector, read-only `recall`)

Workspace: the mini-benchmark test tenant. Before the fix, the first query returned "Nothing found".

| Query | Result |
|---|---|
| `does the user have any pets` (the diagnosis's failing paraphrase) | 3 results; rank 2 = "The user's dog's name is Joker" — shares no word with the query, so only the dense arm can have produced it. Rank 1 (TradeBanger, "100%") is the keyword arm's common-word hits (`any`, `have`) plus bug 3's rank-normalised score — expected, not in A0's scope. |
| `feathered companion at home` (zero lexical overlap by construction) | "The user's dog's name is Joker" · "Has a new pet alligator" · … — pure semantic hits, impossible before the flip. |
| `which songbird is kept as an animal companion` | "Has a new pet alligator" at rank 2; rank 1 unrelated. Ranking quality here is the P1/P2 backlog (rank normalisation, distilled embedding input), not A0. |

A0's acceptance criterion — a previously-zero paraphrase now returns matches, and workspace-filtered dense
retrieval demonstrably works — is met. The blue-jay entry not leading these lists is a ranking-quality
observation to carry into P2, not evidence against the index.

## Regression suite

Expected baseline: 3638 passed / 5 failed / 7 skipped (4 Windows-only + the `calendar` DST 5 s-timeout
flake).

| Run | Tree | Result |
|---|---|---|
| Pre-deploy (binding change applied) | `99b31e2` contents | 3638 / **5** / 7 — baseline |
| Post-deploy | `99b31e2` (deployed) | 3639 / **4** / 7 — baseline minus the DST flake, which made its timeout this time |
| After the stale-name follow-up | `14ce96a` | 3638 / **5** / 7 — baseline |

One earlier post-deploy run was invalid and is not counted: I had started the follow-up edits while it was
still executing, so it saw a half-edited tree (two name-pin tests failed mid-change). It was re-run on the
stashed, exact deployed tree — that is the 3639/4/7 row. A separate earlier pre-deploy run showed 3 extra
timeout failures caused by a stray background process; all passed in isolation and the quiet-machine re-run
is the row recorded.

## Rollback

**`second-brain-vectors` still exists, untouched and undeleted** (verified after cutover: 104 vectors,
same `processedUpToMutation` and timestamp as before this work began; no metadata index was added to it).
Rollback is the one-line flip of `index_name` in `wrangler.jsonc` plus `wrangler deploy`. It is lossless
until the first post-cutover write; after that, vectors written to the new index would have to be copied
back first (`SOURCE_INDEX=quantum-brain-vectors TARGET_INDEX=second-brain-vectors node
qa-2026-09/copy-vectors.mjs snapshot && … upsert`).

## Commits on `qa-fixes-2026-09`

- `99b31e2` — Fix A0: point VECTORIZE at quantum-brain-vectors (workspace_id metadata index) — `wrangler.jsonc`, `qa-2026-09/copy-vectors.mjs`
- `14ce96a` — Retarget index-name fallbacks to quantum-brain-vectors; make `vectors:create` build the metadata index — `package.json`, `src/constants.ts`, `src/vectorize/health.ts`, `public/utils.js`, 3 test files
- (this document) — Add A0 fix log

Not pushed, not merged.

## Follow-ups noticed, not done

- `src/vectorize/scope.ts` still latches "filters supported" on the absence of an error. A health probe
  that runs one filtered query for a known id and flips the `/health` state on an empty answer would make a
  recurrence of A0 visible instead of silent (diagnosis P0 step 3).
- With the dense arm restored, the write path's duplicate/contradiction detection and capture-time
  auto-links are live again for the first time. Worth watching the next few captures for unexpected
  `duplicate-candidate` tags or `supersedes` edges.
- `second-brain-vectors` can be deleted once the rollback window is considered closed; until then it costs
  nothing to keep.
