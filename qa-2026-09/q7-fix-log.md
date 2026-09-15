# Q7 fix log — position-scaled MMR, symmetric diversity penalty, fixture rebuild

Date: 2026-09-15 · Branch: `qa-fixes-2026-09` · Commit: `0277f84` (on top of the diagnosis log `4991dac`)
Local only — **not pushed, not merged, not deployed**. Production still runs `f599556`
(2026-09-15T09:24:37Z, version `f26b0448-…`): primary-wins merge, score/maxRel MMR.

Companion to `q7-diagnosis-log.md` (Part 1). This is Part 2: the fix, its tests, and what was measured
along the way. Files changed: `src/recall/math.ts`, `src/recall/search.ts`, `test/unit/mmr.test.ts`,
`test/integration/recall-fusion-quality.test.ts`. `src/config.ts` untouched.

## What changed

### 1. `mmrRerank` — relevance is rank position, not `score / maxRel` (`src/recall/math.ts`)

Fused scores are RRF ranks, `1/(60+rank)`, so the whole 50-row dense pool spans ~1.8×; with
`score / maxRel` every candidate sat within ~0.25 of the top while `0.3·cosine` varied by 0.10–0.21, and
the diversity term outweighed rank 1 vs rank ~40. A keyword-only row on top (IDF-sum weight ~6× any dense
score) compressed the dense rows further still.

Relevance is now the candidate's **position in the score-ranked pool, spread over a fixed scale of 50**
(`MMR_RANK_SCALE` — the widest dense window recall fetches, the 50-vector widen query):

```
span = max(pool.length, MMR_RANK_SCALE) - 1
rel(i) = 1 - i / span
```

One rank costs `0.7/50 = 0.014`; a near-duplicate (cosine 0.95 vs the 0.4 floor) ~12 ranks; a same-topic
row (0.65) ~5 — instead of 26 and 12 under the old formula. The scale is fixed rather than `pool.length`
on purpose: a 5-row pool keeps every candidate near rel 1, which is the old behaviour for tiny brains and
unit fixtures — four near-duplicates and one distinct row must still yield the distinct row (the existing
`mmr.test.ts` case; pure `1 - i/(n-1)` fails it).

**Why rank position rather than min–max.** Min–max is just as crushed by a keyword-only outlier at the
top. In the 2026-09-14 live shape (TradeBanger at 0.11, dense rows at 0.009–0.025) min–max puts every
dense row at rel ≤ 0.15 — the same anti-relevance regime the diagnosis found.

### 2. The `cand.values` exemption (`math.ts`)

`maxSim` used to be computed only `if (cand.values)`, and only against selected rows that had vectors.
Keyword-only candidates (appended by `fuseDenseAndKeyword`, never scored by Vectorize) therefore paid no
diversity penalty at all and out-picked any dense row at the floor. Now a pair with a missing vector on
either side is charged `MMR_UNKNOWN_SIMILARITY = 0.4` — bge-small-en-v1.5's unrelated-text floor (live
unrelated pairs measured 0.34–0.42 on 09-15). "Assume unrelated", the footing a dense row at the floor
already had. Symmetric in both directions.

### 3. Larger-of fusion merge (`src/recall/search.ts`) — reviewed, kept

`mergeFusedMatches` takes the larger of a parent's two fused scores (lexical vs root list). This was the
uncommitted mid-debugging change; it is correct and independent of the MMR fix: a row the dense arm
returned is in BOTH lists, and only the root list credits its `pet` stem — primary-wins discarded that
credit. Only the stale call-site comment was rewritten. In the replay of the live shape (below) the
stem credit is what carries blue-jay into the top 5: greedy pick #2 with it, #8 without.

### 4. Fixture rebuild (`test/integration/recall-fusion-quality.test.ts`)

`envWithDense` gave every dense hit the same `new Array(384).fill(0.1)` vector: pairwise cosine 1.0, a
flat 0.3 penalty for every dense row after the first, so no diversity drop could ever be reproduced —
the reason Part 1's mock reproductions never converged. It now builds 64-dim vectors with a controlled
geometry:

- default: shares one axis with every other hit at weight √0.4 and sits on a private axis for the rest —
  any two default hits are exactly 0.4-similar (the floor);
- `near: { id, cos }` — built on an earlier hit's vector plus a private axis: exactly `cos` to its
  anchor, `0.4·cos` to everything else;
- `mutual: c` — additionally shares a cluster axis, so all `mutual: c` hits are `c`-similar to each other.

The larger-of case gets live geometry (blue-jay 0.7 to Joker, alligator 0.57, business notes mutually
0.85). A new case isolates the rerank (see tests).

## λ = 0.7 vs 0.85 — measured, not guessed

A pure replay of both MMR variants over synthetic pools with the fixture's geometry
(`scratchpad/mmr-probe.mjs`, no project imports), target = the row 0.7-similar to the top hit:

| shape | old λ=0.7 | new λ=0.7 | new λ=0.85 |
|---|---|---|---|
| **A′ — the 09-14 live shape**: keyword-only outlier on top, target dense rank 3, primary-wins | **pick #15** | pick #8 | pick #5 |
| A — same, with larger-of stem credit (target score rank 2) | #2 | #2 | #2 |
| B — pure dense pool, distractors mutually 0.4 / 0.5 / 0.55 / 0.6 | #12 / #9 / #7 / #5 | #9 / #7 / #6 / #5 | #5 / #4 / #4 / #3 |
| D — four 0.92-duplicates of the top at ranks 2–5: duplicates in top 5 | 0 | **0** | **2** |

Row A′ reproduces the observed live behaviour exactly ("present at topK 15, absent at 5–9") under the old
code — the strongest validation of the diagnosis. Raising λ to 0.85 would bring a same-topic row into the
top 5 even in a fully diverse pool, but lets two 0.92-duplicates of the top hit back into the top 5 — a
regression of MMR's stated purpose. **λ stays 0.7; `config.ts` is untouched.**

## Known limitation (documented, not hidden)

At λ = 0.7, with distractors mutually **at** the unrelated floor (~0.4 to everything), a rank-3 row that is
0.7-similar to the top hit still lands at greedy pick ~9 — absent at topK 5, present at 9. This is the
λ trade-off above, not a normalisation defect: closing it costs duplicate suppression. Live pools measure
0.5–0.8 among their unrelated rows (the 09-15 cosine table), which lands the same row at pick 4–6. Where
the target also carries a stem credit (the actual Q7 corpus) it is pick #2 regardless.

## Correction to Part 1

The diagnosis log said the uncommitted larger-of test case "seeds `user` in 5 of its 21 rows, so `user`
likely survives distillation and hands blue-jay keyword weight even under primary-wins — which is why the
case could not be made to fail". **Wrong on both counts.** With `user` at df 5/21 and `have`/`pets`/`any`
rarer, distillation keeps the three rarest and drops `user`, so blue-jay gets no lexical credit; and the
case **does** fail against primary-wins — verified today by stashing `search.ts` and running it against
the committed merge: `expected ['tradebanger', 'joker', …(3)] to include 'bluejay'`. The earlier
session's "could not make it fail" note was stale by the time the fixture reached its committed form.

## Tests

### New / changed

- `test/unit/mmr.test.ts`
  - "candidates without vectors take no diversity penalty" → "…are charged the unrelated-text floor, not
    zero": a keyword-only row and a dense row at the floor are on equal footing; the one position more
    relevant wins.
  - New: "Q7: the row most like the top hit is not leapfrogged…" — the eight live rows of the 09-15
    signature in their observed score order with their real pairwise cosines, reconstructed as vectors by
    Cholesky factorisation of the cosine matrix (so the geometry is exactly the measured one). Requires the
    score-rank-5 row (e2e) to keep its topK-5 slot rather than losing it to rank 7 (pelican).
- `test/integration/recall-fusion-quality.test.ts`
  - Fixture rebuilt as above.
  - Larger-of case: live geometry; assertion unchanged (blue-jay in the top 5, above every business row).
  - New: "Q7: MMR — a dense-only row that resembles the top hit is not buried behind a queue of unrelated
    rows" — the 09-14 shape with the stem credit removed (target "Johnny sleeps in a cage…", no query word
    or stem; query "does the household have any pets" so no distractor earns keyword credit), keyword-only
    TradeBanger on `have`+`any` leading, Joker dense rank 1, target dense rank 3 at 0.7 to Joker, twelve
    unrelated rows mutually 0.5. Asserts the live shape (TradeBanger first, target present at topK 15,
    dense-only) and that the target is present at **topK 9** (old code: pick #15; new: #8).

### Discrimination proof — each new case fails on exactly the component it targets

Done by stashing one file at a time and running the new tests against it:

| run | result |
|---|---|
| new tests + **old `math.ts`** (score/maxRel, exemption) | unit: the floor-charge case fails (`['top','kw']`) and the live-cosine case fails (wrong 5-set). Integration: **only** the Q7 MMR case fails (target absent at topK 9); larger-of, P2c, P2a, P1 pass. |
| new tests + **old `search.ts`** (primary-wins merge) | **only** the larger-of case fails (`…to include 'bluejay'`); the Q7 MMR case passes — it is independent of the merge. |
| new tests + new code | unit 5/5, integration 5/5 |

### Targeted recall/rerank suite

28 files, **335 / 335 passed**: `mmr`, `rerank`, `rerank-config`, `rrf-fuse`, `recall-root-selector`,
`recall-root-candidate`, `recall-evidence-rescue`, `recall-neighborhood`, `recall-query-profile`,
`distill-query`, `render-recall`, `recall`, `recall-fusion-quality`, `recall-root-selection`,
`recall-root-quality-benchmark`, `recall-root-quality-hidden-validation`, `graph-aware-recall-benchmark`,
`keyword-recall-quality`, `cjk-recall`, `multi-hop`, `recall-widen-threshold`, `recall-d1-limits`,
`recall-free-tier-budget`, `typed-edge-recall`, `team-recall-scoping`, `default-hops`,
`graph-hop-isolation`, `mcp-recall-insight`. The root-quality benchmarks matter here: `selectGraphRoots`
consumes `mmrRerank` as its "diversity" view, so root selection changed under them and held.

### Full suite

`vitest run` on the fix: **3660 passed · 7 skipped · 5 failed (3672)**, 253 / 258 files.

- 4 failures = the known Windows path-separator baseline (`mcp-tools-contract`, `confirm-sheet-callers`,
  `i18n`, `scope-checker` "is wired into package.json and CI" — `spawnSync("cat", …)`).
- 1 failure = `scope-checker` "exits 0…" timing out at 5 s (11.7 s under full-suite load) — the
  subprocess-spawn timeout class the earlier logs attributed to this machine. Passes in isolation, and
  `npm run check:scope` exits 0 (100 queries, 53 documented exceptions), so the `search.ts` edit
  introduced no scope violation.
- Test count 3670 → 3672: +1 unit case, +1 integration case (one unit case was rewritten, not added).

## Process note

Mid-task a `git checkout -- test/unit/mmr.test.ts`, meant to undo a temporary `sed`, reverted the
session's own edits to that file; they were re-applied and re-run before the commit. The committed file is
the intended version (5/5 on new code; the two new cases fail on the old `mmrRerank`, verified after the
re-apply).

## Not done here

- No deploy, no push. Production still runs `f599556`.
- No live re-run of the 8-question mini-benchmark: the `minibench_v2` seeds (including blue-jay) were
  deleted on 09-14 and re-seeding is a write. The fix is validated by the live-cosine replay and the
  synthetic replay of the live shape, not by the literal row.
