import { CHUNK_OVERLAP_CHARS } from "../constants";
import { getStatus } from "../memory/status";
import { getVolatility } from "../memory/volatility";
import { DEFAULTS, type Config } from "../config";

export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  values?: number[] | Float32Array | Float64Array;
  /**
   * The cosine similarity the dense arm reported for this match, kept apart
   * from `score` because fusion overwrites `score` with a rank-based value.
   * Absent on keyword-only candidates. This is what recall reports back to the
   * caller as confidence (QA 2026-09, P1).
   */
  similarity?: number;
}

export interface RerankOptions {
  useRecallFrequency?: boolean;
}

// Recency-decay floors: the minimum fraction of its semantic relevance a memory
// keeps regardless of age (applied in rerankWithTimeDecay). Because decay now
// bottoms out at a floor instead of exp()-ing toward zero, recency becomes a
// tie-breaker rather than a gate — a strong old match can no longer be buried
// under a fresh weak one. Durability sets the floor via volatility: (preferred)
// or legacy proxies (canonical / importance / task). Time-triggered staleness
// warnings use stale:as-of tags set by the nightly pass.
export const RECENCY_FLOOR = 0.6;
export const RECENCY_FLOOR_DURABLE = 0.9;
export const RECENCY_FLOOR_VOLATILE = 0.15;

// MMR diversity: how much the final top-K trades relevance for variety. Higher =
// more relevance-focused, lower = more diverse. 0.7 keeps the top hit intact while
// stopping near-duplicate (usually recent) memories from taking every slot.
export const MMR_LAMBDA = 0.7;

// MMR relevance is a candidate's POSITION in the score-ranked pool, spread over
// the widest dense window recall fetches (the 50-vector widen query), not its
// score as a fraction of the top score (QA 2026-09, Q7). Fused scores are RRF
// ranks, 1/(60+rank): the whole 50-row pool spans only ~1.8x, so score/maxRel
// put every candidate within ~0.25 of each other while 0.3*cosine varied by
// 0.10-0.21 — the diversity term outweighed rank 1 vs rank ~40, and MMR became
// "pick whatever is least like what is already selected". A keyword-only row
// at the top (IDF weight ~6x any dense score) made it worse. Position on a
// fixed 50-wide scale is immune to both: one rank costs 0.7/50 = 0.014, so a
// near-duplicate (cosine 0.95 vs the 0.4 floor) costs ~12 ranks and a same-
// topic row (0.65) ~5, instead of 26 and 12. A pool smaller than the scale
// keeps everyone near 1 — the old behaviour for tiny brains and unit fixtures,
// where four near-duplicates and one distinct row must still yield the
// distinct row.
export const MMR_RANK_SCALE = 50;

// The similarity charged when either side of a pair has no vector — the
// keyword-only candidates fuseDenseAndKeyword appends, which Vectorize never
// scored. bge-small-en-v1.5 rarely scores unrelated text below ~0.3 and live
// unrelated pairs measure 0.34-0.42, so this is "assume unrelated", the same
// footing a dense row at the floor gets. It replaces an exemption: unknown
// used to mean 0, which let a keyword-only row out-pick every dense row that
// merely resembled the top hit (QA 2026-09, Q7).
export const MMR_UNKNOWN_SIMILARITY = 0.4;

export function getRecencyFloor(tags: string[], imp: number, config: Readonly<Config> = DEFAULTS): number {
  if (getStatus(tags) === "canonical" || imp >= 4) return config.RECENCY_FLOOR_DURABLE;
  const vol = getVolatility(tags);
  if (vol === "durable") return config.RECENCY_FLOOR_DURABLE;
  if (vol === "volatile") return config.RECENCY_FLOOR_VOLATILE;
  if (vol === "state") return config.RECENCY_FLOOR;
  if (tags.includes("task")) return config.RECENCY_FLOOR_VOLATILE;
  return config.RECENCY_FLOOR;
}

export function getHalfLifeMs(tags: string[]): number {
  if (tags.includes("task")) return 7 * 24 * 60 * 60 * 1000;
  if (tags.includes("context")) return 180 * 24 * 60 * 60 * 1000;
  if (tags.includes("work")) return 90 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export function rerankWithTimeDecay(
  matches: VectorizeMatch[],
  recallCounts: Map<string, number> = new Map(),
  importanceScores: Map<string, number> = new Map(),
  queryTags: string[] = [],
  contradictionWins: Map<string, number> = new Map(),
  contradictionLosses: Map<string, number> = new Map(),
  d1Tags: Map<string, string[]> = new Map(),
  // Ranking seam: config in, ordering out. Threaded rather than read from
  // module scope so this stays pure and directly assertable without an env.
  config: Readonly<Config> = DEFAULTS,
  options: Readonly<RerankOptions> = {},
): VectorizeMatch[] {
  const now = Date.now();

  return matches
    .map(match => {
      const meta = match.metadata as any;
      const createdAt = meta?.created_at ?? now;
      const parentId = (meta?.parentId ?? match.id) as string;
      const metaTags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];
      const tags: string[] = d1Tags.get(parentId) ?? metaTags;
      const ageMs = now - createdAt;
      const rc = recallCounts.get(parentId) ?? 0;

      const halfLifeMs = getHalfLifeMs(tags);
      const imp = importanceScores.get(parentId) ?? 0;

      const recencyFloor = getRecencyFloor(tags, imp, config);
      const recencyMultiplier = recencyFloor + (1 - recencyFloor) * Math.exp(-ageMs / halfLifeMs);
      const frequencyMultiplier = options.useRecallFrequency === false ? 1 : 1 + Math.log1p(rc);
      const combinedMultiplier = Math.min(1.0, recencyMultiplier * frequencyMultiplier);
      const isShortAppend = match.id.includes("-update-") &&
        typeof meta?.content === "string" && meta.content.length < CHUNK_OVERLAP_CHARS;
      const appendPenalty = isShortAppend ? 0.2 : 1.0;
      const rolledUpPenalty = tags.includes("rolled-up") ? 0.4 : 1.0;

      const wins = contradictionWins.get(parentId) ?? 0;
      const losses = contradictionLosses.get(parentId) ?? 0;
      const net = wins - losses;
      let importanceMultiplier: number;
      if (imp === 0 && net === 0) {
        importanceMultiplier = 1.0;
      } else {
        const base = imp === 0 ? 3 : imp;
        const adj = Math.sign(net) * Math.log1p(Math.abs(net)) * config.CONTRADICTION_IMPORTANCE_STEP;
        const effectiveImp = Math.max(1, Math.min(5, base + adj));
        importanceMultiplier = 0.8 + (effectiveImp / 5) * 0.4;
      }

      const overlap = queryTags.length ? tags.filter(t => queryTags.includes(t)).length : 0;
      const tagBoost = overlap ? Math.min(config.TAG_BOOST_MAX, 1 + overlap * config.TAG_BOOST_STEP) : 1.0;

      return { ...match, score: match.score * combinedMultiplier * appendPenalty * rolledUpPenalty * importanceMultiplier * tagBoost };
    })
    .sort((a, b) => b.score - a.score);
}

export function mmrRerank<T extends VectorizeMatch>(candidates: T[], lambda: number, k: number): T[] {
  if (candidates.length <= 1 || k <= 1) return candidates.slice(0, k);
  const pool = [...candidates].sort((a, b) => b.score - a.score);
  // Position on the fixed scale (see MMR_RANK_SCALE); a pool wider than the
  // scale still spreads evenly over [0, 1].
  const span = Math.max(pool.length, MMR_RANK_SCALE) - 1;
  const rel = new Map<VectorizeMatch, number>(pool.map((m, i) => [m, 1 - i / span]));
  const sim = (a: VectorizeMatch, b: VectorizeMatch) =>
    a.values && b.values ? cosineSim(a.values, b.values) : MMR_UNKNOWN_SIMILARITY;

  const selected: T[] = [pool.shift()!];
  while (selected.length < k && pool.length) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      let maxSim = 0;
      for (const s of selected) maxSim = Math.max(maxSim, sim(cand, s));
      const mmr = lambda * rel.get(cand)! - (1 - lambda) * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    selected.push(pool.splice(bestIdx, 1)[0]);
  }
  return selected;
}
