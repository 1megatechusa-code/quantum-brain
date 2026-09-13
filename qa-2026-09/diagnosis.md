# Quantum Brain — QA diagnosis, 2026-09-13

Branch: `qa-fixes-2026-09`. Read-only pass: no code, data, or deploy changes were made.
Live evidence below comes from **read-only** `wrangler vectorize query/info/list-metadata-index`
and `wrangler d1 execute --remote` SELECTs against the `quantum-brain` D1 and the
`second-brain-vectors` Vectorize index this Worker is bound to (`wrangler.jsonc`).
Head7 (the owner's personal brain) turned out to live in this same Worker/D1/index (see the addendum at the end); its rows and vectors were only ever READ, never modified.

---

## TL;DR

| # | Bug | Root cause | Where | Severity |
|---|-----|-----------|-------|----------|
| A0 | **(Hidden, shared)** Every identified recall's dense/semantic arm returns **zero** vectors | Vectorize query is sent with `filter: { workspace_id: { $in: [...] } }` but **no metadata index exists on `workspace_id`**. Vectorize silently returns no matches for a positive filter on an un-indexed property; it does not error, so the "fall back to unfiltered" latch never trips and `semanticUnavailable` stays `false`. Recall has been **keyword-only in disguise** for every MCP call. | `src/vectorize/scope.ts` `queryVectorizeScoped`; `src/recall/search.ts:255-283`; index provisioning (`package.json` `vectors:create`, no `create-metadata-index` step anywhere) | **Critical** — underlies 2 and 3, degrades 1, and also kills capture-time duplicate/contradiction detection and capture-time auto-links |
| 1 | `hops` "does nothing" | Graph expansion *runs*, but a neighbour is only shown if it passes a **lexical evidence gate** (`scoreLinkedEvidence`): it must contain ≥2 exact query tokens or a rare exact token, cover ≥20% of query-token IDF, score ≥0.5, and add ≥0.1 coverage over the result it would displace. A semantically-dissimilar, lexically-unrelated neighbour is rejected as `no-linked-evidence` **by design**. Also: `topK < 3` reserves **0** related slots, 3–5 reserves 1, ≥6 reserves 2. Tool description over-promises. | `src/recall/neighborhood.ts:110-170`, `relatedSlotLimit` `:49`; `src/recall/search.ts:485-547`; description in `src/mcp/server.ts:577` | High (contract mismatch), not a wiring bug |
| 2 | Paraphrase queries return zero | A0 (no dense arm) + the embedding input is the *distilled* 1–3 rare-word string, not the sentence (`DEFAULT_EMBEDDING_QUERY_MODE = "distilled"`) + keyword arm and candidate hydration do **not** exclude `status:deprecated` rows, so deprecated rows fill the topK MMR slots and are then dropped at final hydration → empty result | `src/recall/query-profile.ts:8,113-119`; `src/recall/search.ts:36-73` (keywordSearch, no deprecated filter), `:349-357` (rcRows, no deprecated filter), `:404` (deprecated filter applied only here, after slot selection) | High |
| 3 | "100% match" on an unrelated result | Scores are RRF **rank** scores (absolute similarity discarded at fusion), then **normalised by the max** so the top result is always 1.0. The percentage is "rank 1", never confidence. A0 makes it worse: with no dense arm the "top" is just the newest keyword substring hit. | `src/recall/rrf.ts`; `src/recall/search.ts:627-628`; `src/recall/render.ts:60,69` | High (misleading), trivial to fix the display |
| 4 | Second relation type "destroys" the first | **Not data loss** — both rows are in D1 (verified). `getConnections` walks through `expandGraph`, which de-duplicates **by neighbour id** (one edge per neighbour), *then* applies the `type` filter. Which type survives = SQLite scan order among equal-weight (1.0) explicit edges, which is invisible to the caller. | `src/graph/traverse.ts:188-215` (visited/dedupe), `:254-255` (type filter after dedupe) | High |
| 5 | `supersedes` does not deprecate the target | Only the **system** contradiction path calls `deprecateEntry` before drawing `supersedes` (`src/capture/entry.ts:248-261`). The explicit MCP/REST `link` path just inserts the edge. The tool description claims otherwise; a comment in `traverse.ts:245-247` also claims otherwise; `insight/candidates.ts:401-403` correctly documents that it does **not**. | `src/mcp/server.ts:754-791`, `src/routes/graph.ts:17-60`, `src/graph/edges.ts:178-194` | Medium (contract mismatch) |
| 6 | `link()` echoes ids reversed | Deterministic, **storage-level**, and only for `relates_to`: the one undirected type is canonicalised to `(min(id), max(id))` by string comparison before insert, and the reply echoes the stored order. Verified: 24/24 `relates_to` rows in D1 have `source_id < target_id`. Harmless for an undirected edge, but unexplained in the reply and `connections()` shows no direction, so it *looks* like a swap. It also feeds bug 4's "which type wins". | `src/graph/edges.ts:145,191` | Low (cosmetic) — but it should never happen for a directed type; if it did, that is a separate bug |
| 7 | `append()` accumulates vectors | **By design**, and **not orphaned**: an append under `CHUNK_MAX_CHARS` embeds *only the addition* as a new `<id>-update-<ts>` vector (the old vectors still index the original text, which is still in the entry) and records it in `vector_ids`, so `forget()` deletes all of them. Cost is one extra vector per append until the entry crosses 1600 chars, at which point it re-embeds whole and retires the old set. Short update vectors are down-weighted 0.2× in rerank. | `src/capture/store.ts:271-380` (short path `:333-371`, long path `:305-331`), `src/recall/math.ts:92-94` | Low — cost/quality trade-off, not a leak |

**Group A verdict:** bugs 1, 2, 3 are *three different mechanisms* — but all three are currently observed
through one distorting lens, **A0**. Fix A0 first; then re-test 1–3 before touching their own code, because
the symptom you measured for each is partly A0's.

---

## Live evidence (read-only)

### A0 — the workspace filter silently empties the dense arm

```
$ wrangler vectorize list-metadata-index second-brain-vectors
  You haven't created any metadata indexes on this account.

$ wrangler vectorize info second-brain-vectors
  dimensions 384 · vectorCount 104

# probe vector v = [0.05]*384, top-k 3
unfiltered                                       → 3 matches (scores ~0.009, i.e. any vector returns topK)
--filter '{"workspace_id":{"$in":["ws-b928…"]}}' → "Could not find any relevant vectors"   ← exact value that IS in metadata
--filter '{"workspace_id":"ws-b928…"}'   ($eq)   → "Could not find any relevant vectors"
--filter '{"workspace_id":{"$ne":"zzz"}}'        → matches (negative filters pass everything)
```

- No error is thrown, so `queryVectorizeScoped` (`src/vectorize/scope.ts:77-95`) sets
  `workspaceFiltersSupported = true` and returns `[]`. The unfiltered fallback only fires on a thrown error
  whose message contains "filter".
- `recallEntries` then has `results.matches = []`, `semanticUnavailable = false` → no notice to the caller,
  and the widen-on-low-score branch (`search.ts:288`) can't fire on an empty list.
- Every MCP call has an identity (`src/mcp/handler.ts:34`) → `wsFilter` is always set → this is the
  **100% path** for the product, not an edge case. Only `tag`-filtered recall (which uses `getByIds` +
  local cosine) and identity-less cron callers actually get semantic scores today.
- Same filter, same silent emptiness, in `checkDuplicateAndContradiction`
  (`src/capture/duplicate.ts:77-79`, `singleWorkspaceFilter`) → duplicate flagging, contradiction
  detection, and capture-time `inferEdgesOnWrite` never see a neighbour. Consistent with the live graph:
  only 4 `inferred` edges exist, all from the append/update path (which queries unfiltered).
- Vectors *are* stamped correctly (`workspace_id` present in metadata) and the index holds exactly the 104
  vectors D1's `vector_ids` account for (1+27+48+28) — so this is **not** a stale-vector or shared-index
  problem; the index just has no metadata index to filter on. Per Cloudflare docs, vectors upserted before
  a metadata index exists are not indexed on that property, so creating the index alone is not enough —
  the 104 vectors need re-upserting — by id with unchanged values, NOT via `POST /migration/reembed` (see tension 7).

### Bug 4 — both edges exist; the reader hides one

```sql
-- pairs carrying two types (D1, read-only)
551acab3… → f4ab0bda…   relates_to + supersedes
a19a38ea… → a24f384a…   relates_to + follows
a19a38ea… → 54a6eeb6…   supersedes + drawn_from
a19a38ea… → a0564e21…   caused_by  + about_person
a19a38ea… → 50f0d196…   decided    + part_of_project
af3a83f1… → c2375c94…   decided    + follows
```

Replaying `expandGraph`'s edge scan for seed `a19a38ea…` (`ORDER BY weight DESC`, all weights 1.0) returns
rows in **rowid (insertion) order**, so the loop at `traverse.ts:209-215` keeps the *older* edge per
neighbour and drops the newer one; `getConnections` then filters on `viaType` (`:255`) and finds nothing
for the dropped type. Which edge is "older" in scan order additionally depends on whether the `relates_to`
row was canonically flipped (bug 6): a flipped row is found by the `target_id IN` arm of the OR, which the
planner visits *after* the `source_id IN` arm — so from one end of the pair the typed edge wins, from the
other end `relates_to` wins. That is the "no pattern" you saw.

### Bug 6 — canonicalisation is real, but only for the undirected type

```
type          provenance  n   source_id < target_id
relates_to    explicit    24  24     ← always canonicalised
relates_to    inferred     4   4
decided       explicit     2   1     ← directed types stored as requested
drawn_from    explicit     5   3
supersedes    explicit     2   1
…
```

---

## Per-bug detail

### A0 — no metadata index on `workspace_id` (root cause behind Group A)

**Mechanism.** `src/recall/search.ts:255` builds `wsFilter = workspaceFilter(identity, …)` →
`{ workspace_id: { $in: readScopeWorkspaces(identity) } }`. `queryVectorizeScoped` sends it. Vectorize
returns `{ matches: [] }` with no error because the property has no metadata index. Nothing downstream can
tell "nothing similar" from "filter unsatisfiable".

**Why it went unnoticed.** Unit/integration tests mock Vectorize (`makeVectorizeMock`) and never exercise a
real filter; `GET /health` reports `workspaceFilter.supported = true` because the latch is set on the
*absence of an error*, not on the presence of results; keyword search is good enough on a small brain to
mask the loss.

**Collateral on the write path.** `captureEntry` → `checkDuplicateAndContradiction` → same filter → no
neighbours → `dup.status` is always `unique`, contradictions never detected, `supersedes(system)` never
drawn, no capture-time auto-links.

### 1 — `hops` is wired, but gated on lexical overlap with the query

Path: `search.ts:381-395` picks graph roots → `expandGraph` (`:399`) → `scoreLinkedEvidence` per neighbour
(`:490-504`) → only `eligible` neighbours enter `selectedRelated` (`:544-547`) → at most
`relatedSlotLimit(topK)` of them (`neighborhood.ts:49-52`: 0 for topK<3, 1 for 3–5, 2 for ≥6).

`scoreLinkedEvidence` rejects when:
- `linkedCoverage === 0` → `no-linked-evidence` (neighbour shares no query token, even as a substring);
- not (`exactHighIdf` or ≥2 exact token matches) or `linkedCoverage < 0.2` or `score < 0.5` → `weak-neighborhood`;
- `unionCoverage < replacementCoverage + 0.1` → `no-evidence-gain`.

So "a linked, semantically-dissimilar neighbour" is exactly the input this gate exists to reject. The
existing tests encode this: every hops fixture gives the neighbour text that repeats the query
(`test/integration/multi-hop.test.ts:81-93`, "Direct match related context"). The tool description
("also surfaces related memories linked in the graph") promises graph expansion; the code delivers
"linked *evidence* for the query". Also note the seeds come from `rootFusedMatches`, which under A0 is
keyword-only, so root selection is weaker than designed too. The diagnostics that would have shown you the
rejection reasons (`internal.diagnostics.rejections`) exist only on the REST route, not on MCP.

### 2 — paraphrase misses: three contributors, A0 dominant

1. **A0**: the semantic arm is empty, so any query without a *substring* hit on the stored text finds
   nothing through the intended channel.
2. **Distilled embedding input** (`query-profile.ts:8`, `:119`): even once A0 is fixed, the text embedded
   is `distilled.query` — the ≤3 rarest whitespace words of the question (`distill.ts:137-143`), e.g.
   `"user have pets"` rather than `"does the user have any pets"`. With `bge-small-en-v1.5` that shifts
   the vector toward a bag of words; conversational phrasing with common words is the case it hurts most.
   `"hybrid"`/`"semantic"` modes already exist behind `internal.embeddingQueryMode` but no caller sets them.
3. **Deprecated rows crowd the slots**: `keywordSearch` (`search.ts:36-73`) and the candidate-signal
   hydration (`:349-357`) have no `status:deprecated` exclusion; `mmrRerank` picks `topK` candidates from
   that list (`:373`); only the *final* hydration (`:404`) drops deprecated rows. Result: when the best
   keyword hits are deprecated (which your test brain deliberately has), you get fewer than topK — or zero —
   results while perfectly good candidates ranked 6th–15th were never considered. Deprecated entries have
   their vectors deleted, so this only bites the keyword arm — which under A0 is the only arm.

   On the specific `"pets"` vs `"pet"` case: the keyword arm *does* generate the stem `"pet"`
   (`query-profile.ts:54`) and would LIKE-match it — but `lexicalFusedMatches` (built from the distilled
   tokens, `"pets"`, `search.ts:317`) wins over `rootFusedMatches` whenever it is non-empty (`:318`), and
   in it the pet entry has zero keyword weight. It survives only if it also contains a common distilled
   word like `"user"`, and then it competes with every other `"user"` row by recency. That is the
   "works for exact wording, unreliable for paraphrase" signature.

### 3 — false "100%"

`rrfFuse` (`rrf.ts`) converts dense/keyword *ranks* to `1/(60+rank)` — cosine similarity is discarded at
this point. After rerank/MMR, `search.ts:627-628` does `m.score = m.score / maxScore`, so `matches[0].score`
is 1.0 by construction; `render.ts:60` prints it as `100% match`. There is no absolute threshold anywhere
between candidate generation and presentation (`CANDIDATE_SCORE_THRESHOLD` in `constants.ts:40` is unused
by recall). Deprecating the true best match cannot lower anything: the next-best rank simply becomes 1.0.

### 4 — one edge per neighbour

`expandGraph` (`traverse.ts:183-215`) builds `candidates` for every edge row, but the `visited` set keyed
by node id (`:209-215`) lets only the first candidate per neighbour through. It was written for recall's
"reach the node" use, where one edge is enough. `getConnections` (`:254-255`) reuses it, then filters by
type — so the type filter can only ever see the one edge that survived. Storage is intact; `unlink` (order-
and type-aware) and `buildGraph` (`:425-428`, keys by `source|target|type`) are unaffected.

### 5 — explicit `supersedes` is inert

`createEdge` (`edges.ts:178-194`) inserts a row and nothing else. The deprecate-then-link sequence lives
only in the contradiction branch of `captureEntry` (`entry.ts:248-261`). The two surfaces that claim
otherwise: the MCP `link` description (`server.ts:767`) and the comment at `traverse.ts:245-247`.
`insight/candidates.ts:401-403` documents the real behaviour. Recall never consults edges when deciding
what is deprecated (`search.ts:404` reads only `tags`), so a superseded-but-not-deprecated target keeps
surfacing.

### 6 — `relates_to` canonical ordering

`edgeInsertStatement` (`edges.ts:145`) and `createEdge` (`:191`) swap `source/target` when
`isSymmetric(type) && source > target` (JS string `>` on UUIDs, i.e. hex-lexicographic — it *is* alphabetical
on the ids, which is easy to misjudge by eye across two 36-char strings). It makes the UNIQUE constraint
work for an undirected pair (A–B and B–A collapse to one row) — a reasonable design that just isn't
announced in the reply. Since `relates_to` is undirected the storage swap is semantically harmless. If you
ever saw a **directed** type echoed reversed, that is not this and should be re-tested in isolation.

### 7 — append is additive on purpose

Short path (`store.ts:333-371`): embed `addition` only, `VECTORIZE.insert` one `-update-<ts>` vector with
`isUpdate: true`, push its id onto `vector_ids`. Long path (`:305-331`, `newContent.length > 1600`):
`reembedOrDegrade` whole entry → `deleteStaleVectors`. Your 3-vs-1 observation is exactly this. Nothing is
orphaned (D1 `vector_ids` tracks all of them; `forgetEntry`/`deprecateEntry` delete by that list). The
trade-off the authors took: an append costs one embed instead of re-embedding the whole entry, and the
addition gets its own searchable vector. Costs: ~1 vector per append, stale `tags` snapshot inside the
update vector's metadata, and rerank has to special-case short update chunks (0.2× penalty). One real
wrinkle, confirmed: `POST /migration/reembed` (`runBatch`) skips `deleteStaleVectors` by design and
resets `vector_ids` to the chunk ids, so running it against the *same* index would orphan every
`-update-<ts>` vector. That is a constraint on how P0's re-index is done (tension 7), not a bug in
`append` itself.

---

## Are bugs 1–3 one root cause?

**No — but they currently share one amplifier.**

- **A0** is a single infrastructure defect that removes the semantic arm from every MCP recall. It fully
  explains the *severity* of 2 and 3 as observed, and it degrades 1's root selection.
- **1** is a design/contract mismatch in `neighborhood.ts` that would persist with a perfect dense arm.
- **2** additionally has two code causes of its own (distilled embedding input; deprecated rows consuming
  MMR slots before the deprecated filter runs).
- **3** is a presentation/scoring-model bug (rank-normalised scores) that would persist with a perfect
  dense arm — though with A0 fixed, a real cosine score is at least *available* to display.

Prioritisation consequence: **fix A0 before writing a line for 1–3**, then re-run the original three
scenarios. Some of what you measured will move on its own; what remains is the real backlog for 1–3.

---

## Prioritised fix plan (nothing implemented yet)

Each step names the test to run afterwards. "Live test" = against the deployed Worker via MCP; "unit" =
`npx vitest run <file>` on this branch.

### P0 — A0: make the workspace filter actually filter

**Fix (ops + code, in this order):**
1. `wrangler vectorize create-metadata-index second-brain-vectors --property-name workspace_id --type string`
   (one-time account action; cannot be done from code). Note Vectorize caps metadata indexes per index —
   this is the only property that needs one.
2. Re-upsert all 104 vectors so they are indexed on that property. **Not** via `POST /migration/reembed`
   (see tension 7 — it would orphan the append vectors); use a one-off script that walks `entries`,
   `getByIds` each row's `vector_ids`, and `upsert`s the same vectors back unchanged. No embedding spend,
   no id changes, and `vector_ids` stays exact.
3. Code: `queryVectorizeScoped` should treat *"filtered query returned 0 matches while the index reports
   `vectorCount > 0`"* as a degrade signal — or, cheaper and safer, add a startup/health probe that runs one
   filtered query for a known vector id and flips the `/health` `workspaceFilter` state and the KV marker
   when it comes back empty. Without this, the same silent failure will recur on any fresh deploy that
   forgets step 1.
4. Add `create-metadata-index` to `package.json` (`vectors:create` → two commands) and to the README verify
   step.

**Confirm:** `wrangler vectorize query second-brain-vectors --vector <any> --filter '{"workspace_id":{"$in":["<ws>"]}}'`
returns matches. Live: `recall("does the user have any pets")` returns the pet entry. Live: `remember` a
near-duplicate of an existing entry and see `Tagged as duplicate-candidate` (duplicate detection coming back
is the cleanest proof the write path sees vectors again).

### P1 — Bug 3: stop reporting a rank as a confidence

**Fix:** carry the best absolute signal per match through the pipeline (dense cosine when it exists,
else a bounded keyword-coverage score) as a separate `confidence` field; keep the fused score for
ordering; render `confidence`, and render nothing (or "keyword match") when only the keyword arm hit.
Don't drop the max-normalisation for ordering purposes — MMR relies on relative scores.

**Confirm (unit):** new test in `test/unit/render-recall.test.ts`: two matches with cosine 0.91 / 0.42
render as 91% / 42%, not 100% / 46%. **Live:** deprecate the true best match, re-run the query — the new
top result must show a visibly lower number than the original top did.

**Tension:** any *display* threshold introduced here ("hide below X%") reintroduces zero-result cases for
the paraphrase queries P0/P2 are trying to rescue. Show the number; don't gate on it yet.

### P2 — Bug 2 (residual after P0): deprecated rows and the embedding input

**Fix (a):** add `AND tags NOT LIKE '%"status:deprecated"%'` (the existing `INDEXABLE_SQL` constant in
`lifecycle.ts:54`) to `keywordSearch` and to the candidate-signal hydration so deprecated rows never occupy
MMR slots. (Keep the final-hydration filter as belt-and-braces.)
**Fix (b):** switch `DEFAULT_EMBEDDING_QUERY_MODE` to `"hybrid"` (embed the sentence *and* the distilled
terms) — the mode already exists; run `test/integration/recall-root-quality-benchmark.test.ts` and the
hidden-validation benchmark before/after, since those fixtures were tuned under `"distilled"`.

**Confirm (unit):** seed 6 entries where the 5 best keyword hits are `status:deprecated` and the 6th is
live; `recall(topK 5)` must return the 6th. **Live:** the paraphrase set you used today, run twice — once
after P0 (baseline), once after P2 — and count zero-result queries; P2 must not increase it.

**Tension:** (b) changes ranking for exact-phrasing queries that currently work. The benchmark tests are the
guard; if they regress, keep `"distilled"` for queries with ≥1 identifier-shaped token and use `"hybrid"`
otherwise.

### P3 — Bug 4: one edge per (neighbour, type) in `connections`

**Fix:** give `getConnections` its own 1-hop SQL (`SELECT … FROM edges WHERE (source_id = ? OR target_id
= ?) [AND type = ?] AND <scope>`) and hydrate endpoints once — do **not** change `expandGraph`'s dedupe,
which recall and `/graph` rely on for node budgeting. Include a `direction` field
(`outgoing`/`incoming`/`undirected`) in the `Connection` shape so bug 6 becomes visible instead of
suspicious.

**Confirm (unit):** extend `test/integration/connections.test.ts`: `pushEdge(a,b,relates_to)` +
`pushEdge(a,b,caused_by)`; `GET /connections?id=a` returns 2 rows, `?type=relates_to` returns 1,
`?type=caused_by` returns 1 — and the same from `id=b`. **Live:** the pair
`551acab3… / f4ab0bda…` already carries `relates_to` + `supersedes`; `connections()` on either id with
each type filter must return one row each.

### P4 — Bug 5: make explicit `supersedes` do what it says (or say what it does)

Product decision first — two valid options:
- **(i)** honour the description: in the MCP `link` handler and `POST /link`, when `type === "supersedes"`
  and `provenance === "explicit"`, call `deprecateEntry(target)` before `createEdge` (same order as
  `entry.ts:248-261`), gated by `assertCanMutateEntry` on the target since this is now a mutation of it;
  reply text must say the target was deprecated. Add the same to `unlink`? No — un-deprecating on unlink
  is a separate, riskier choice; leave it manual via `set_status`.
- **(ii)** change the description to "does *not* change the target's status; call `set_status` to
  deprecate it", and fix the `traverse.ts:245` comment.

Recommendation: **(i)**, because the insight pass and recall's `edgeIntentCompatibility` already treat
`supersedes` as authoritative. **Confirm (unit):** `test/integration/link.test.ts`: after
`POST /link {type: supersedes}`, target's tags contain `status:deprecated` and `vector_ids` is `[]`.
**Live:** `link(new, old, supersedes)` then `recall(<old's exact text>)` must not return `old`.

**Tension:** with (i), a mistaken `supersedes` now *destroys the target's vectors* (`deprecateEntry`
deletes them); recovery is `set_status canonical` + `POST /vectorize-pending`. Worth saying in the reply.
Also interacts with P3: after (i), `connections()` on the source must still list the deprecated target —
it does today (`includeDeprecated: true`), keep that in the new query.

### P5 — Bug 6: explain the canonical order

**Fix:** in the `link` reply, when the type is undirected, say so: `Linked X ↔ Y (Related to; undirected —
stored in canonical id order)`, and never claim an arrow. With P3's `direction` field this becomes
self-explanatory. No storage change.

**Confirm (unit):** `link(source=b, target=a, relates_to)` reply contains `↔` and both ids;
`link(source=b, target=a, caused_by)` reply is `b → a`. **Live:** repeat your two reproductions and check
they were both `relates_to`.

### P6 — Bug 7: decide the append policy

Options, cheapest first: **(a)** leave as is and document it ("append adds one searchable vector per
addition; entries >1600 chars are re-embedded whole"); **(b)** cap update vectors at N (e.g. 5) and fall
through to the long path when exceeded; **(c)** always re-embed (simplest storage, costs an embed per chunk
per append and loses the addition-only vector that makes recent updates findable on their own).
Recommendation: (b) — bounded cost, keeps the recency benefit.

**Confirm (unit):** `test/integration/append.test.ts`: 6 appends → `vector_ids.length` ≤ N+1 and the
oldest `-update-` id has been passed to `deleteByIds`. **Live:** your 1-remember-2-appends test → forget
reports 3 vectors; 1-remember-6-appends → forget reports ≤ N+1.

---

## Tension points (where one fix can worsen another)

1. **P0 unfiltered fallback vs. tenancy.** If step 3 of P0 is implemented as "fall back to unfiltered when
   filtered returns nothing", a multi-workspace brain leaks *candidates* across workspaces into the
   `topK×3` window (SQL hydration still drops them, so no data leak — but they crowd out the caller's own
   rows, which is a different flavour of bug 2). Prefer the health-probe form, or namespaces per workspace
   instead of metadata filtering.
2. **Loosening retrieval (P2b, wider topK, lower `RECALL_WIDEN_THRESHOLD`) vs. bug 3.** Every relaxation
   that makes a weak match reachable makes the rank-normalised "100%" more misleading. Land P1 (honest
   confidence) *before* or *with* P2, never after.
3. **Adding a confidence floor (a tempting P1 add-on) vs. bug 2.** A floor is a new way to return zero.
   If one is added, it must be a *display* hint, not a filter, until the paraphrase benchmark is green.
4. **Excluding deprecated rows earlier (P2a) vs. `hops` traversal.** `expandGraph` already refuses to
   *traverse through* deprecated nodes (`traverse.ts:199-206`); excluding them from seeds too is
   consistent. But `connections()` must keep `includeDeprecated: true` (commit `62a9650` fixed exactly this
   regression) — P3's new query must preserve it.
5. **P4(i) `supersedes` deprecates vs. P2/P3.** More deprecated rows → more pressure on P2a's slot problem
   if P2a isn't done; and `connections()` must still show them (P3). Sequence: P3 → P2a → P4.
6. **Making `hops` "show neighbours regardless of evidence" (a naive bug-1 fix) vs. the evidence gate's
   purpose.** The gate exists because ungated neighbours displaced direct matches and produced junk
   (`test/integration/graph-junk-links.test.ts`, `typed-edge-recall.test.ts`). The right shape is a
   *second mode* (e.g. `hops` with `mode: "neighbors"` or a separate tool that returns the graph
   neighbourhood of the top result), plus an honest tool description for the current mode — not removing
   the gate. Also raise `relatedSlotLimit` awareness in the description: `topK ≥ 3` is required for any
   related result at all.
7. **P0 re-upsert vs. bug 7's update vectors.** `POST /migration/reembed` (`src/migration/embedding.ts`
   `runBatch`) is built for moving to a *new* index and **deliberately skips `deleteStaleVectors`**
   (comment at `:234-237`). Run against the *same* index it would overwrite chunk vectors by id but leave
   every `-update-<ts>` vector behind as a true orphan (its id is never regenerated) while `vector_ids` is
   reset to the chunk ids — i.e. it would manufacture the leak bug 7 was accused of. For P0 use a one-off
   re-upsert that reads each entry's existing `vector_ids`, `getByIds` them, and `upsert`s the same
   vectors back unchanged (no embedding spend, no id change), or extend `runBatch` with a
   same-index mode that deletes the old `vector_ids` set.

---

## Things checked and ruled out

- ~~Vector index is not shared with another product~~ **Superseded by the addendum below: Head7 is a tenant of this same Worker/D1/index.** Original note: `vectorCount` 104 == Σ `json_array_length(vector_ids)`
  across this D1's workspaces, and a 50-row sample shows only this D1's workspace ids. (The bound index
  name is still the upstream default `second-brain-vectors`; if Head7 ever binds the same name on this
  account they *will* collide — rename before that happens.)
- `UNIQUE(source_id, target_id, type)` is what the schema and `db/init.ts` both declare; there is no
  runtime index narrowing it to `(source_id, target_id)`. Bug 4 is purely read-side.
- No `DELETE FROM edges` runs on the explicit link path. The only typed-replaces-generic delete
  (`edges.ts:363-368`) targets `provenance = 'inferred'` and `type = 'relates_to'` only.
- `forgetEntry` cascades edges and vectors correctly; the 3-vs-1 vector count you observed is real and
  intended (bug 7).
- `wrangler` is authenticated on this machine (OAuth, account `0f31c83d…`) — the earlier note that it was
  not is stale.

## Baseline test run (this branch, unchanged code)

`npx vitest run` — **252 files passed / 4 failed / 1 skipped; 3638 tests passed / 4 failed / 7 skipped**
(348 s). The 4 failures are the known Windows-only environment failures (backslash paths and the
missing `.github/workflows/ci.yml` — e.g. `test/unit/scope-checker.test.ts` asserting on `ci.yml`), not
product regressions; they pre-date this branch. Nothing in the suite exercises a real Vectorize filter,
which is why A0 was never caught.

---

# Addendum 2026-09-13 (later the same day) — tenancy facts that change P0

## Correction: Head7 is a tenant of this Worker, not a separate deployment

The "Things checked and ruled out" entry above assumed the personal second brain lived elsewhere. It does not.
Direct inspection (read-only D1 + Vectorize `get-vectors`):

- `users` has 4 rows: 3 customers (`qb-…`, each with a `customers` row) and one **Owner** admin
  `usr-c522ae1c-…`. Every bearer on either MCP path resolves via `users.token_hash`
  (`src/lib/identity.ts:134-152`), so a non-`qb-` token on the bare `/mcp` path can only be the Owner.
- Owner's workspaces: personal **`ws-b928a083-5dd4-47eb-8597-f9ee7d1c19a7`** (= Head7; 36 entries, 48
  `vector_ids`, 17 edges) and company `ws-bbaf722d-…` (0 entries). No legacy `''` rows exist.
- The 48 Head7 vector ids were fetched **by id** from `second-brain-vectors` in 3 batches: **48/48 present**,
  all stamped `workspace_id = ws-b928a083…`. They are *inside* the 104 reconciled earlier
  (1 + 27 + **48** + 28), not additional to it. The one Head7 entry with `vector_ids = []` is
  `status:deprecated` (expected).

Consequence: bug A0 affects Head7 exactly as it affects customers, and any A0 fix (metadata index + re-upsert,
or a new index + rebind) necessarily re-indexes Head7's 48 vectors. Recommended staging for Option A:
create the metadata index (additive), re-upsert the 56 customer vectors, verify a `qb-` identity gets
filtered dense results, then re-upsert Head7's 48 — every step id-preserving and value-preserving.

## A1 — the keyword arm is NOT workspace-scoped for multi-term queries (cross-tenant candidate leak)

`keywordSearch` (`src/recall/search.ts:52-70`) builds `content LIKE ? OR content LIKE ? OR …` and appends
` AND workspace_id IN (?)` — but only wraps the OR chain in parentheses when a time filter is present
(`:66`: `const tokenWhere = timeWhere ? \`(${where})\` : where`). SQL precedence (`AND` binds tighter
than `OR`) turns `a OR b OR c AND scope` into `a OR b OR (c AND scope)`: **every LIKE term except the last
is unscoped.**

Proven against the live D1 with the exact statement shape, scope binding = customer `qb-43e0…`'s workspace
`ws-ea8bf940…`:

| statement shape | rows returned | from which workspaces |
|---|---|---|
| A: `LIKE '%Higgsfield%' OR LIKE '%zzz%' AND workspace_id IN (cust)` (production, 2 terms, no time) | **5** | Head7 ×4, other customer ×1 — **0 of the caller's** |
| B: same terms, order swapped (scoped term last) | 0 | — |
| C: `(… OR …) AND created_at >= 0 AND workspace_id IN (cust)` (production, with time filter) | 0 | — |
| D: single term `LIKE '%Higgsfield%' AND workspace_id IN (cust)` | 0 | — |
| E: production, 4 common terms (`user/have/any/pets`) | **25** | Head7 ×10, other customer ×6, caller ×9 |

So a customer's ordinary natural-language recall reads Head7's and other customers' `content` into the
Worker's candidate set. What happens next:

- **Final rendered output is protected**: the final hydration (`search.ts:404-441`) is `id IN (…) AND
  workspace_id IN (…)`, so foreign rows are dropped before anything is rendered or synthesised. No foreign
  text reaches an MCP reply. Verified by reading the code path; the SQL-level leak is what the table proves.
- **But foreign rows consume result slots**: they survive fusion (`fuseDenseAndKeyword` carries the keyword
  row's `content` as `metadata.content`), rerank and `mmrRerank(…, topK)` (`:373`) — then vanish at
  hydration. With A0 removing the dense arm, the keyword arm is the *only* arm, so under a 4-tenant brain a
  customer's topK is routinely filled with rows that will be discarded. This is a **third contributor to
  bug 2's zero/short results**, alongside deprecated rows and the distilled embedding — and it is tenant
  count dependent, which is why a solo test brain would never show it.
- Foreign `content` is also used as `localEvidence` for graph-root selection when `hops > 0`
  (`root-candidate.ts:9-12` prefers `metadata.content`); those roots are later dropped by the scoped
  `d1Map`/`candidateSignalById` lookups, and their edges are scoped by `edges.workspace_id`, so nothing
  leaks out — but CPU and ranking decisions are spent on other tenants' text.
- REST `recall` with `diagnostics` would expose foreign **ids** in `keywordIds`/`candidateIds`
  (no content). Low severity, but it is a visible artefact of the same bug.
- Why tests missed it: `test/integration/team-recall-scoping.test.ts:101-169` asserts the exact statement
  string for **single-term** queries only (`content LIKE ? AND workspace_id IN (?)`), and the D1 mock
  (`test/helpers/d1-mock.ts:566`) matches by substring with no precedence semantics.
- Fix is one line: always parenthesise the OR chain (`const tokenWhere = \`(${where})\``), plus a
  multi-term assertion in `team-recall-scoping.test.ts` and, ideally, one test that runs `keywordSearch`
  through the real-SQLite helper (`test/helpers/sqlite-d1.ts`) with two workspaces seeded.
- No other OR-chain + appended-scope statement exists in `src/` (grep: `join(" OR ")` occurs only here;
  the graph edge scans parenthesise their OR in the scoped form and say so in a comment).

**Priority: A1 goes to P0 alongside A0**, and it should land *first* — it is a pure code fix, needs no
account action, and reduces the crowding that makes A0's symptoms worse. It is also a tenancy-correctness
fix on a product that now has three paying customers sharing an index and a table with the owner's brain.

**Tension with A0's "unfiltered fallback" idea (tension 1):** the same crowding mechanism A1 exhibits in
the keyword arm is what an unfiltered dense fallback would add to the semantic arm. Both arms need real
scoping; hydration-only scoping is a safety net, not a substitute.

---

# Fix log

## A1 — keyword-arm workspace scoping — **FIXED on branch `qa-fixes-2026-09` (not deployed)**

**Change** (`src/recall/search.ts`, `keywordSearch`): the `content LIKE ? OR …` chain is now parenthesised
whenever it has more than one term, so the appended `AND created_at …` / `AND workspace_id IN (…)` clauses
apply to every term. Single-term statements are byte-identical to before (nothing to mis-bind), so the
existing exact-string contract pins in `team-recall-scoping.test.ts` still hold. One line of logic plus a
comment explaining the precedence trap.

**Regression test** (`test/integration/team-recall-scoping.test.ts`, "scopes every term of a multi-word
query, not just the last one (A1)"): runs the full `recallEntries` path against the **real-SQLite facade**
(`test/helpers/sqlite-d1.ts`), seeds two foreign rows matching the *first* query word and one own row
matching the *second*, then re-executes the exact statement recall issued with the exact bindings and
asserts on the **rows D1 returns** — not on the final matches, which were always clean. Also pins the
time-bounded, unscoped and single-term shapes. Verified to **fail** against the pre-fix code (the received
statement was the unparenthesised `… LIKE ? OR content LIKE ? AND workspace_id IN (?, ?) …`) and pass after.

**Test-harness follow-through:** 16 substring matchers in `test/helpers/d1-mock.ts` and 7 recall test files
keyed on `WHERE content LIKE`, which the parenthesised statement no longer contains; they now key on
`content LIKE ?` + `ORDER BY created_at DESC LIMIT` (still unique to this statement — the DF aggregate has
no `ORDER BY`). Test-only change; production SQL is unaffected by it.

**Diagnostics question:** no separate fix needed — and the earlier concern was overstated. `diagnostics`
(`RecallInternalOptions.diagnostics`, `src/recall/types.ts:82`) is populated only when a caller passes the
object in; `GET /recall` (`src/routes/recall.ts:136`) and the MCP `recall` tool (`src/mcp/server.ts:586`)
never do. It is a test-only hook, so foreign ids were never reachable over HTTP/MCP. With A1 fixed,
`keywordIds` is scoped anyway; `denseIds` would still show whatever Vectorize returns (relevant only if an
unfiltered fallback is ever adopted for A0 — tension 1).

**Suite:** targeted recall/graph files (10 files, 166 tests) green; full-suite result recorded below.

**Full suite after the fix:** `npx vitest run` → **3638 passed / 5 failed / 7 skipped** (251 files passed,
5 failed). Four of the five are the same Windows-only environment failures as the pre-fix baseline
(`mcp-tools-contract`, `confirm-sheet-callers`, `i18n`, `scope-checker` — backslash paths / missing
`.github/workflows/ci.yml`). The fifth, `test/unit/calendar.test.ts` "stays exact minute by minute across
a DST transition", is a **5000 ms test timeout** on this machine (5.36 s in isolation) and fails identically
on the unmodified tree (`git stash` → same failure), so it is machine speed, not this change — it passed in
the earlier baseline run only because that run happened to be faster. Every test the change could affect
(recall, graph, scoping, d1-mock consumers) is green.
