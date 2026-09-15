import { describe, it, expect } from "vitest";
import { cosineSim, mmrRerank, MMR_UNKNOWN_SIMILARITY } from "../../src/recall/math";

function m(id: string, score: number, values: number[]) {
  return { id, score, metadata: { parentId: id }, values };
}

/**
 * Unit vectors whose pairwise cosines are the given matrix: the rows of its
 * Cholesky factor (L L^T = G). Real cosines of real vectors are a Gram matrix,
 * so this reproduces measured geometry exactly, up to the 3-decimal rounding
 * of the input (the pivot clamp absorbs it).
 */
function vectorsWithCosines(g: number[][]): number[][] {
  const n = g.length;
  const L = g.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = g[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[j][j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (Math.abs(cosineSim(L[i], L[j]) - g[i][j]) > 5e-3) throw new Error(`cosine matrix not reproduced at ${i},${j}`);
  }
  return L;
}

// Two clusters: several near-duplicate "recent" vectors and one distinct "older" vector.
const DUP = [1, 0, 0];
const DISTINCT = [0, 1, 0];

describe("mmrRerank", () => {
  it("surfaces a distinct item that a plain top-K by score would crowd out", () => {
    const candidates = [
      m("recent1", 0.60, DUP),
      m("recent2", 0.58, DUP),
      m("recent3", 0.57, DUP),
      m("recent4", 0.56, DUP),
      m("distinct", 0.50, DISTINCT),
    ];
    const picked = mmrRerank(candidates, 0.7, 3).map(x => x.id);
    // Plain top-3 by score would be recent1/recent2/recent3 (all duplicates).
    expect(picked[0]).toBe("recent1");        // top hit preserved
    expect(picked).toContain("distinct");     // the distinct item reclaims a slot
  });

  it("keeps the highest-scoring item first", () => {
    const picked = mmrRerank([
      m("b", 0.5, DUP),
      m("a", 0.9, DISTINCT),
    ], 0.7, 2);
    expect(picked[0].id).toBe("a");
  });

  it("candidates without vectors are charged the unrelated-text floor, not zero", () => {
    // Two keyword-only rows: relevance order holds (nothing to compare).
    const picked = mmrRerank([
      { id: "x", score: 0.9, metadata: {} } as any,
      { id: "y", score: 0.8, metadata: {} } as any,
    ], 0.7, 2).map(x => x.id);
    expect(picked).toEqual(["x", "y"]);

    // A keyword-only row and a dense row sitting at the floor (cosine 0.4 to
    // the top hit) are on equal footing: with the dense row one position more
    // relevant, it wins. Under the old exemption the vector-less row scored
    // 0.7*rel - 0 against the dense row's 0.7*rel - 0.12 and out-picked it.
    const FLOOR = MMR_UNKNOWN_SIMILARITY;
    const top = [1, 0, 0];
    const atFloor = [FLOOR, Math.sqrt(1 - FLOOR * FLOOR), 0];
    const withDense = mmrRerank([
      m("top", 0.9, top),
      m("dense", 0.8, atFloor),
      { id: "kw", score: 0.79, metadata: {} } as any,
    ], 0.7, 2).map(x => x.id);
    expect(withDense).toEqual(["top", "dense"]);
  });

  it("Q7: the row most like the top hit is not leapfrogged by a queue of less relevant, less similar rows", () => {
    // The eight rows of the live signature (2026-09-15), in their observed
    // score order, with their real pairwise cosines (bge-small, fetched with
    // `wrangler vectorize get-vectors`). At topK 5 production dropped the #5
    // (e2e, 0.667 to the already-selected Stripe row) for the #7 (pelican,
    // 0.585): with score/maxRel the two-rank gap was worth ~0.006 and the
    // similarity gap 0.024. Position-scaled relevance makes two ranks worth
    // 0.028, so the more relevant row keeps its slot.
    const names = ["joker", "stripe", "alligator", "applePie", "e2e", "falcon", "pelican", "entryC"];
    const cos = [
      [1.000, 0.398, 0.566, 0.410, 0.398, 0.406, 0.397, 0.422],
      [0.398, 1.000, 0.354, 0.586, 0.667, 0.559, 0.585, 0.563],
      [0.566, 0.354, 1.000, 0.340, 0.364, 0.402, 0.420, 0.350],
      [0.410, 0.586, 0.340, 1.000, 0.496, 0.697, 0.546, 0.810],
      [0.398, 0.667, 0.364, 0.496, 1.000, 0.525, 0.541, 0.496],
      [0.406, 0.559, 0.402, 0.697, 0.525, 1.000, 0.674, 0.636],
      [0.397, 0.585, 0.420, 0.546, 0.541, 0.674, 1.000, 0.554],
      [0.422, 0.563, 0.350, 0.810, 0.496, 0.636, 0.554, 1.000],
    ];
    const vectors = vectorsWithCosines(cos);
    const candidates = names.map((id, i) => m(id, 1 / (60 + i + 1), vectors[i]));
    const picked = mmrRerank(candidates, 0.7, 5).map(x => x.id);
    expect(picked).toEqual(["joker", "stripe", "alligator", "applePie", "e2e"]);
  });

  it("returns at most k items and never more than provided", () => {
    const picked = mmrRerank([m("a", 0.9, DUP), m("b", 0.8, DISTINCT)], 0.7, 5);
    expect(picked.length).toBe(2);
  });
});
