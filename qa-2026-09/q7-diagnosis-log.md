# Q7 diagnosis log — rerank/MMR drop (diagnosis only, no fix)

Date: 2026-09-15 · Branch: `qa-fixes-2026-09` · Diagnosis only — **no code changed** in this session.
Production runs `f599556` (deployed 2026-09-15T09:24:37Z, version `f26b0448-…`), primary-wins merge.
The uncommitted `src/recall/search.ts` larger-of merge and the 4th `recall-fusion-quality` case remain
uncommitted and are NOT in this build.

Companion to `p1-p2-fix-log.md` (open item 1). Starting evidence, taken as given from that log: the
blue-jay row ("The user has a pet blue jay named Johnny.") is fetched by the keyword arm, returned by the
dense arm at cosine 0.52, ranks 3 at `topK: 15`, and is absent at `topK: 5`, `6` and `9`. Prior mock
reproductions did not converge.

## Root cause (confirmed on live data, not a mock)

**`mmrRerank` (`src/recall/math.ts:127-149`) runs in a regime where the diversity term dominates
relevance, because RRF rank scores are too compressed for `MMR_LAMBDA = 0.7`.** A relevant row that is
semantically similar to an already-selected row (blue-jay ↔ "The user's dog's name is Joker") is
leapfrogged in greedy pick order by many *less relevant but less similar* rows. It only enters the
selection once `topK` is large enough for the greedy walk to reach it — and then `directMatches` is
re-sorted by score (`src/recall/search.ts:561`), which is why it shows at "rank 3" at topK 15 while being
absent at 5–9. The rank reported at topK 15 says nothing about its MMR pick position.

The arithmetic. Dense candidates score `1/(RRF_K + rank)` with `RRF_K = 60` (`src/recall/rrf.ts:13`):
rank 1 → 0.0164, rank 20 → 0.0125, rank 50 → 0.0091 — **the whole 50-row dense pool spans only ~1.8× in
relevance**. After normalising to `maxRel`, `0.7 · rel` varies by ≈ 0.25 across the pool, while
`0.3 · cosine` varies by ≈ 0.10–0.21 for bge-small-en-v1.5 (live pairwise cosines below run 0.34–0.81;
`search.ts` already notes the model "rarely scores unrelated text below ~0.3"). A similarity difference of
0.25 between two candidates is therefore worth more than the difference between RRF rank 1 and rank ~40.
In that regime MMR is effectively "pick whatever is least like what is already selected".

## Evidence

### 1. The signature reproduced live on the deployed build

Query `does the user have any pets`, via the `quantum-brain-product` connector (read-only `recall`,
`hops: 0` — the MCP default, `DEFAULT_HOPS: 0`), workspace `ws-1925db93…`:

| score rank at topK 15 | at topK 5 |
|---|---|
| 1–4 Joker · Stripe-decision · alligator · apple-pie | identical |
| **5 e2e-isolation (46%)** | **absent** |
| 6 falcon-tundra (45%) | absent |
| 7 pelican (45%) | **present, slot 5** |

With `hops: 0` the related-slot and evidence-slot code does not run, so the final list is exactly
`mmrRerank(pool, 0.7, topK)` re-sorted by score. An entry inside the top 5 by score at topK 15 being
replaced at topK 5 by the topK-15 #7 is, unambiguously, MMR greedy order diverging from score order —
the same shape as Q7.

### 2. Replay of the code's MMR formula over the real stored vectors

The eight rows above were fetched read-only with `wrangler vectorize get-vectors quantum-brain-vectors`
(384-dim) and their pairwise cosines computed offline:

```
                  Joker StripeD Alligat ApplePi E2E-sub  Falcon Pelican  EntryC
Joker             1.000   0.398   0.566   0.410   0.398   0.406   0.397   0.422
StripeDecision    0.398   1.000   0.354   0.586   0.667   0.559   0.585   0.563
Alligator         0.566   0.354   1.000   0.340   0.364   0.402   0.420   0.350
ApplePie          0.410   0.586   0.340   1.000   0.496   0.697   0.546   0.810
E2E-sub2          0.398   0.667   0.364   0.496   1.000   0.525   0.541   0.496
Falcon            0.406   0.559   0.402   0.697   0.525   1.000   0.674   0.636
Pelican           0.397   0.585   0.420   0.546   0.541   0.674   1.000   0.554
EntryC            0.422   0.563   0.350   0.810   0.496   0.636   0.554   1.000
```

Feeding the observed score order (as `1/(60+rank)`) and these vectors through the same greedy loop as
`mmrRerank` — with and without the live multipliers (Joker ×1.04 importance × 1.45 tag boost, Stripe
×1.2) — produces the live topK-5 pick set exactly: `Joker, Stripe, Alligator, ApplePie, Pelican`.
At pick 5, e2e loses to pelican because its max-similarity to the already-selected Stripe row is
**0.667** (penalty 0.200) against pelican's 0.585 (0.176), while e2e's two-rank score advantage is worth
only ≈ 0.006 in MMR units. Alligator (score rank 3, 0.566 to Joker) is already the *lowest* MMR candidate
of all seven at pick 2 — the blue-jay shape, one row over.

### 3. Blue-jay projection

The blue-jay vector no longer exists (see limitations), so alligator–Joker (0.566) is the proxy; blue-jay
uses the same "the user … pet …" template as Joker and is almost certainly higher. For a rank-3 row at
similarity ≈ 0.65 to pick 1: with Joker's ×1.45 tag boost setting `maxRel`, every row of RRF rank ≤ ~15
whose similarity to the selected set is ≤ 0.40 out-scores it in MMR; without the boost, every row of
rank ≤ ~10. It therefore lands at greedy pick ~10–16: absent at topK 5–9, present at 15, re-sorted to
rank 3. This matches the 2026-09-14 observation exactly.

## Amplifiers — real, but not the root

- **Tag boost on the competitor.** `inferQueryTags` maps the query to `dog / joker / personal`
  (×1.45, `TAG_BOOST_STEP` 0.15 × 3 overlaps). Joker becomes `maxRel`, compressing every other row's
  `rel` and widening the drop window from ~10 to ~15 picks. The earlier hypothesis named the right row
  but the boost is not required for the drop.
- **Keyword-only rows are exempt from the diversity penalty.** `maxSim` is computed only
  `if (cand.values)` (`math.ts:138`); rows fetched only by the keyword arm carry no vector. In the
  09-14 run the keyword-only TradeBanger row was pick 1 *and* `maxRel`, with an unnormalised IDF-sum
  weight (`rrf.ts:14`, ≈ 6× any dense score), pushing every dense row's `0.7 · rel` below ≈ 0.17 —
  below the penalty for merely resembling Joker.
- **Primary-wins merge** (deployed) discards blue-jay's root-list `pet`-stem credit. The uncommitted
  larger-of change would raise its score enough to survive *in that specific corpus* — a legitimate fix
  for lost stem credit — but it does not touch the MMR regime: any dense-only relevant row similar to
  pick 1 still drops.

## Ruled out

- **Dense pool varying with topK.** `vectorizeTopK = min(3 · topK, 50)` (`search.ts:329`), but the
  widen-to-50 re-query fires whenever the top cosine is below `RECALL_WIDEN_THRESHOLD` (0.85); live top
  cosine for this query is ≈ 0.6, so the pool is identical at every topK.
- **Related / evidence slots.** `relatedSlotLimit`, `graphSeedLimit` and the evidence replacement at
  `search.ts:643` are all gated on `hops > 0`; the MCP path passes `hops: 0`.
- **Vectors missing on the scoped Vectorize path.** `src/vectorize/scope.ts:60,81` pass
  `returnValues: true`; the penalty is active in production.

## Why the mock reproductions never converged

`envWithDense` (`test/integration/recall-fusion-quality.test.ts:35`) gives **every** dense hit the same
vector, `new Array(384).fill(0.1)`. Pairwise cosine is exactly 1.0, so the diversity penalty is a flat
0.3 for every dense row after the first and cannot reorder dense rows relative to each other. The
mechanism is unrepresentable in that fixture. Separately, the uncommitted 4th case seeds `user` in 5 of
its 21 rows, so `user` likely survives distillation and hands blue-jay keyword weight even under
primary-wins — which is why the case could not be made to fail against the old merge.

## Limitations, stated plainly

- **The blue-jay row no longer exists in live D1.** It was a `minibench_v2` seed and all nine were
  deleted on 2026-09-14 (`list_recent(tag: minibench_v2)` is empty; a D1 `LIKE '%blue jay%'` scan
  returns 0 rows; 82 entries total). It was not re-seeded — that is a write. Q7 is confirmed through its
  structural twin on the current corpus, not the literal row.
- Live `recall` calls incremented `recall_count` on the rows they returned (Joker 21 → 23, etc.) — the
  product's normal side effect, the same as prior sessions' live tests.
- The first `wrangler d1 execute --remote` returned a transient `7403`; the retry was clean and every
  D1 statement was a `SELECT`.
- The blue-jay–Joker cosine is inferred from the alligator–Joker proxy, not measured.

## What Part 2 should target

1. **The MMR relevance/diversity scale mismatch — the actual fix.** In order of preference:
   (a) normalise `rel` by min–max (or rank position) over the pool instead of `score / maxRel`, so
   relevance genuinely spans [0, 1]; (b) raise `MMR_LAMBDA` (config, 0.7) toward ~0.85–0.9 — a
   one-line mitigation that leaves the asymmetry below in place; (c) apply MMR only within score bands
   or protect the top N by score.
2. **The `cand.values` exemption.** Keyword-only rows should be penalised through a text proxy, or the
   penalty made symmetric; otherwise fix 1 still leaves keyword-only rows privileged.
3. **Keep the larger-of merge** — it repairs a genuine stem-credit loss — but its test needs distinct,
   varying vectors and no incidental `user` keyword credit before it proves anything.
4. **Any Part 2 test must use a fixture with distinct vectors.** The eight live vectors above are a
   ready-made set. A fill-0.1 fixture passes on any MMR change and proves nothing.
