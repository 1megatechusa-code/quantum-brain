# P2c / P2a / P1 fix log — ranking and confidence cleanup (post-A0)

Date: 2026-09-14 · Branch: `qa-fixes-2026-09` · Commits: `f91a8dc` (P2c), `adcafbd` (P2a), `6dbdebc` (P1)
Not pushed, not merged, **not deployed** — production still runs the A0 build (`349d92f0`).

Companion to `diagnosis.md` (bugs 2 and 3) and `a0-fix-log.md`. The three defects here are the ones the
post-A0 mini-benchmark isolated (7/8, with Q7 failing and Q4/Q5b/Q7 showing a false "100%").

## What changed

### P2c — fusion union (`src/recall/search.ts`, `mergeFusedMatches`)

`recallEntries` builds two fused candidate lists: **lexical** (ranked on the distilled query tokens) and
**root** (ranked on the wider retrieval vocabulary: evidence tokens, identifier probes, deterministic
stems such as `pets → pet`). It used the lexical list whenever it was non-empty and discarded the root
list. Any row that matched the query only through a stem or probe was fetched by the keyword arm and
never scored; and at `hops: 0` the evidence-slot rescue that could have re-admitted it does not run.

Now: union keyed by parent id. Every lexical entry keeps its score and position (ordering among
already-present candidates is unchanged); a parent present only in the root list is appended with its
root score and competes in the rerank like any other candidate.

**Contract change, deliberate:** a root-arm-only row is no longer confined to the last slot. One
existing test pinned the old behaviour (`recall-root-selection` "supplemental-anchor"): a row matching
three of the four query words that the lexical arm had distilled away now leads the result; the direct
hits keep their relative order. Expectation updated and the reason recorded in the test.

**Before/after on the failing example** (`does the user have any pets`, target "The user has a pet blue
jay named Johnny."): before — target absent from top 5 and top 10, dense arm returned dog/alligator only,
keyword arm fetched the row via the `pet` stem and fusion dropped it; after — target in the top 5
alongside the dense hits (`recall-fusion-quality.test.ts` "P2c", real SQLite, dense arm mocked to the
live results).

### P2a — deprecated rows out of the keyword arm (`src/recall/search.ts`, `keywordSearch`)

`deprecateEntry` deletes a row's vectors, so the dense arm never sees a deprecated memory, but its text
stays in `entries` and the LIKE scan matched it. Those rows took `topK` slots through fusion → rerank →
MMR and were dropped at the final hydration, so a query whose best keyword hits were deprecated came
back short or empty with live answers ranked just outside the window.

Now: `keywordSearch` ANDs `INDEXABLE_SQL` (`tags NOT LIKE '%"status:deprecated"%'`, the single
definition of "still in the index" from `src/capture/lifecycle.ts`) into the scan — the same verdict the
graph walk already applies to its candidates via `readableAndDeprecatedAmong`. The final-hydration
filter stays as belt-and-braces. Eight statement pins in `team-recall-scoping.test.ts` updated.

**Before/after on the failing example** (five deprecated rows carrying the query's rare term verbatim and
newer than the one live row): before — `[]` (all five slots taken then discarded); after — `["live"]`,
and the issued SQL carries the clause (`recall-fusion-quality.test.ts` "P2a").

### P1 — absolute confidence (`math.ts`, `search.ts`, `types.ts`, `render.ts`, `routes/recall.ts`, `public/js/recall.js`)

The number shown as `(NN% match)` was `score / max(score)` — the top match is 1 by construction, so
rank 1 always read "100%". Fusion had also thrown away the only absolute signal available: RRF
overwrote the Vectorize cosine with a rank-based value.

Now:
- `VectorizeMatch.similarity` carries the dense arm's cosine through fusion.
- `RecallMatch.confidence` (0–1, absolute, independent of the rest of the result set) = the larger of
  that cosine and the **unweighted** share of the retrieval vocabulary the text contains (exact token 1,
  substring ¼); a graph-expanded match reports its linked-evidence score.
- MCP text renders `confidence`; `GET /recall` adds `confidence` (0–100) beside the unchanged
  rank-relative `score`; the dashboard prefers `confidence` when present. `score` stays for ordering and
  the full-text allowance — what it was always for.

Two judgement calls, recorded so they can be revisited:
1. **Unweighted coverage.** The first cut used corpus-IDF-weighted coverage and produced the opposite of
   the intent: a query word that appears in *no* memory gets the largest IDF, so a row holding the one
   identifying term of a verbose question scored below a row holding nothing. "Contains N of the M
   words searched" is checkable by eye and does not have that failure mode.
2. **Raw cosine.** bge-small-en-v1.5 rarely scores unrelated text below ~0.3, so "30%" is its floor, not
   a third of the way to a match. No rescaling was applied because the floor is model-specific and
   `EMBEDDING_MODEL` is configurable; the number is the model's own similarity and is documented as
   such. If a rescale is wanted later it belongs in config next to the model choice.

**Before/after on the failing examples** (`recall-fusion-quality.test.ts` "P1", Q4-shaped): an
unrelated dense hit at cosine 0.31 leading the result — before: "(100% match)"; after: "(31% match)",
still rank 1 (`score` 1), so ordering is untouched. A genuine dense match at 0.88 reports ≥ 0.88. The
keyword-only answer reports a bounded coverage in (0, 1).

## Regression suite

| Run | Result | Notes |
|---|---|---|
| Baseline (A0 build, earlier today, quiet machine) | 3638 / 5 / 7 | 4 Windows-only + DST flake |
| Recall/graph/scoping targeted files after the three fixes | all green | 13 files, incl. both root-quality benchmarks and the hidden-validation set |
| Full suite after the three fixes | 3625 / **21** / 7 | see below |

The 21: the 4 known Windows-only failures, the DST flake, and **16 tests in `repo-hygiene` (4) and
`claude-code-hooks-contract` (12)** — every one a 5–12 s timeout on a subprocess spawn. Measured during
that run: `node -e 1` took 4.5 s and one `git check-ignore` 4.2 s, so any test that shells out blows its
5 s ceiling. Neither suite imports the recall code (`repo-hygiene` checks `.gitignore` via git;
`hooks-contract` runs the hook scripts as child processes against a mock Worker), and both passed on
this tree's parents earlier in the day. Recorded as **environmental**, to be re-run on a quiet machine
before merge. `npx tsc --noEmit` is clean.

## Mini-benchmark re-run — see "Verification status" below

The live Worker does not carry these commits (deploying is outside this task's guardrail), so a live
re-run through the MCP connector would only re-measure the A0 build (7/8). A local `wrangler dev`
instance with local D1/KV and the Vectorize binding marked `remote: true` (the only binding that has no
local emulation) was set up to run the new code against real embeddings without touching production
D1 or the production Worker. The full 8-question driver (facts verbatim, the same distractors the live
workspace had, the same 10 phrasings) is `bench.mjs` in the scratchpad; it seeds, queries, scores and
deletes in one pass.

## Verification status

- **Code-level, per fix:** done — each failing example reproduced against real SQLite with the dense
  arm mocked to what Vectorize returned in the benchmark, failing on the pre-fix code and passing after.
- **Full 8-question re-run on the new code:** **not completed at time of writing.** See the session
  report for the reason and the two ways to finish it (deploy on go-ahead and re-run live via the
  connector, or re-run the local instance once the machine is responsive).
