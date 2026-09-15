/**
 * QA 2026-09 — the three ranking/confidence defects the post-A0 mini-benchmark
 * isolated (qa-2026-09/p1-p2-fix-log.md). Each case reproduces the live
 * failure it is named for, against real SQLite, with the dense arm mocked to
 * return exactly what Vectorize returned in the benchmark run:
 *
 *   P2c  "does the user have any pets" — the keyword arm stems pets→pet and
 *        fetches the blue-jay row, but fusion threw that hit away whenever the
 *        distilled-token fusion had anything at all.
 *   P2a  a status:deprecated row with strong keyword overlap took a topK slot
 *        and was dropped at hydration, pushing a live answer out.
 *   P1   the top result's score was divided by itself, so an irrelevant rank-1
 *        read "100% match".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recallEntries } from "../../src/recall/search";
import { renderRecallText } from "../../src/recall/render";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV, makeVectorizeMock } from "../helpers/make-env";
import type { Env } from "../../src/env";

function makeCtx() {
  const pending: Promise<any>[] = [];
  return { ctx: { waitUntil: (p: Promise<any>) => pending.push(p) } as any as ExecutionContext };
}

/**
 * Every hit's vector has a controlled geometry, so the MMR diversity penalty is
 * real (QA 2026-09, Q7). The previous fixture gave every hit the same
 * `fill(0.1)` vector: every pair was cosine 1.0, the penalty was one flat
 * constant for all dense rows, and no diversity drop could ever be reproduced.
 *
 * By default a hit shares one axis with every other hit at weight sqrt(FLOOR)
 * and sits on its own private axis for the rest, so any two default hits are
 * exactly FLOOR-similar — bge-small's unrelated-text floor (live unrelated
 * pairs measured 0.34–0.42 on 2026-09-15). Options, per hit:
 *   near:   { id, cos } — built on that earlier hit's vector plus a private
 *           axis: exactly `cos` to its anchor, FLOOR·cos to everything else.
 *   mutual: c — additionally shares a cluster axis, so all `mutual: c` hits are
 *           c-similar to each other (c ≥ FLOOR) and FLOOR to the rest.
 */
const FLOOR = 0.4;
const DIM = 64;
type DenseHit = { id: string; score: number; near?: { id: string; cos: number }; mutual?: number };
function vectorsFor(hits: DenseHit[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  hits.forEach((h, i) => {
    const v = new Array<number>(DIM).fill(0);
    const own = 1 + i; // axis 0 is shared, DIM-1 is the cluster axis
    if (h.near) {
      const anchor = out.get(h.near.id);
      if (!anchor) throw new Error(`near: ${h.near.id} must be listed before ${h.id}`);
      for (let d = 0; d < DIM; d++) v[d] = h.near.cos * anchor[d];
      v[own] += Math.sqrt(1 - h.near.cos ** 2);
    } else {
      const cluster = Math.max(0, (h.mutual ?? FLOOR) - FLOOR);
      v[0] = Math.sqrt(FLOOR);
      v[DIM - 1] = Math.sqrt(cluster);
      v[own] = Math.sqrt(1 - FLOOR - cluster);
    }
    out.set(h.id, v);
  });
  return out;
}

/** A dense arm that answers every query with the same fixed hits (id + cosine + geometry). */
function envWithDense(sqlite: SqliteD1, hits: DenseHit[]): Env {
  const vectors = vectorsFor(hits);
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: hits.map(h => ({ id: h.id, score: h.score, metadata: { parentId: h.id }, values: vectors.get(h.id) })),
      }),
    }),
  });
}

describe("recall fusion and confidence (QA 2026-09 P2c / P2a / P1)", () => {
  let sqlite: SqliteD1;
  beforeEach(async () => {
    resetDatabaseInit();
    sqlite = makeSqliteD1();
    await initializeDatabase(makeTestEnv(undefined, { DB: sqlite.db as unknown as Env["DB"], OAUTH_KV: makeMemoryKV() }));
    sqlite.issued.length = 0;
  });
  afterEach(() => sqlite.close());

  it("P2c: a stem-only keyword hit survives fusion when the distilled arm also matched something", async () => {
    // The live workspace during the benchmark, reduced to what matters: the
    // target row contains "pet" (not "pets") and none of the distilled tokens
    // the query reduces to; the dense arm — bge-small on the distilled string —
    // ranked two OTHER pets above it and never returned it at all.
    sqlite.seed({ id: "bluejay", content: "The user has a pet blue jay named Johnny.", createdAt: 1000 });
    sqlite.seed({ id: "joker", content: "The user's dog's name is Joker.", createdAt: 1001 });
    sqlite.seed({ id: "gator", content: "Has a new pet alligator.", createdAt: 1002 });
    sqlite.seed({ id: "tradebanger", content: "It has never been confirmed whether TradeBanger actually has a GitHub repository — only local development paths are known, and this needs to be verified before any code audit work.", createdAt: 1003 });
    sqlite.seed({ id: "identity", content: "The customer-identity bug was fixed: the system now matches customers by Stripe subscription ID instead of email.", createdAt: 1004 });
    sqlite.seed({ id: "shipping", content: "DynamiteDTF switched its primary shipping carrier to UPS as a business decision.", createdAt: 1005 });
    const env = envWithDense(sqlite, [{ id: "joker", score: 0.62 }, { id: "gator", score: 0.58 }, { id: "identity", score: 0.41 }]);
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "does the user have any pets", topK: 5, synthesize: false }, env, ctx);

    // Sanity: the distilled query carries no word the target contains.
    expect(res.queryUsed).not.toContain("user");
    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("bluejay");
    // The dense hits are still there — merging must add, not replace.
    expect(ids).toContain("joker");
    expect(ids).toContain("gator");
  });

  it("P2c: a row in BOTH lists takes its stronger score — the live-brain shape the first cut missed", async () => {
    // The live workspace, post-A0: the dense arm DOES return the blue-jay row,
    // at a middling cosine, so the lexical list already holds it as a
    // dense-only entry scored 1/(k+rank) — the distilled tokens (have/any/pets)
    // give it no keyword weight. Only the root list credits the "pet" stem. A
    // union that kept the primary (lexical) score for a row present in both
    // lists threw that credit away and left the row behind every unrelated
    // dense hit, exactly as the override had.
    sqlite.seed({ id: "bluejay", content: "The user has a pet blue jay named Johnny.", createdAt: 1000 });
    sqlite.seed({ id: "joker", content: "The user's dog's name is Joker.", createdAt: 1001 });
    sqlite.seed({ id: "coffee", content: "The user prefers their coffee black.", createdAt: 1002 });
    sqlite.seed({ id: "dinner", content: "The user usually eats dinner around 6 PM.", createdAt: 1003 });
    sqlite.seed({ id: "nashville", content: "User is flying to Nashville on Friday for a trade show.", createdAt: 1004 });
    sqlite.seed({ id: "gator", content: "Has a new pet alligator.", createdAt: 1005 });
    // "any" occurs once (below), "have" and "pets" never, "user" five times:
    // distillation keeps the three rarest and drops "user", so the target has
    // NO lexical keyword weight — the live corpus shape.
    sqlite.seed({ id: "tradebanger", content: "It has never been confirmed whether TradeBanger has a GitHub repository; verify before any code audit.", createdAt: 1006 });
    for (let i = 0; i < 14; i++) sqlite.seed({ id: `biz-${i}`, content: `Business note ${i}: DynamiteDTF, Magnific, Stripe, Cloudflare, invoicing.`, createdAt: 2000 + i });
    // Dense arm: the other pet first, the target well down the list behind
    // unrelated business rows. Geometry as the live brain: the two pet rows
    // resemble Joker (alligator–Joker measured 0.566; blue-jay shares more of
    // the template), the business notes are near-identical to each other.
    const env = envWithDense(sqlite, [
      { id: "joker", score: 0.62 }, { id: "biz-0", score: 0.50, mutual: 0.85 }, { id: "biz-1", score: 0.49, mutual: 0.85 },
      { id: "biz-2", score: 0.48, mutual: 0.85 }, { id: "biz-3", score: 0.47, mutual: 0.85 }, { id: "bluejay", score: 0.46, near: { id: "joker", cos: 0.7 } },
      { id: "biz-4", score: 0.45, mutual: 0.85 }, { id: "gator", score: 0.44, near: { id: "joker", cos: 0.57 } },
    ]);
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "does the user have any pets", topK: 5, synthesize: false }, env, ctx);

    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("bluejay");
    // With the stem credited it outranks every business row the dense arm put
    // above it — the root score is what carried it, not its dense rank.
    expect(ids.indexOf("bluejay")).toBeLessThan(ids.indexOf("biz-0") === -1 ? 99 : ids.indexOf("biz-0"));
  });

  it("Q7: MMR — a dense-only row that resembles the top hit is not buried behind a queue of unrelated rows", async () => {
    // The 2026-09-14 live shape with the stem credit taken out of the picture
    // (the target shares no word or stem with the query), so this isolates the
    // rerank: a keyword-only row on common words ("any") leads by an IDF-sum
    // score ~6x any dense score; Joker is dense rank 1; the target is dense
    // rank 3 at cosine 0.7 to Joker; twelve unrelated rows follow, ~0.5 to each
    // other and at the floor to the pets. With relevance as score/maxRel every
    // dense row sat within 0.2 of the keyword row's 1.0 and the 0.3*cosine term
    // decided everything: the target was greedy pick #15 — present at topK 15,
    // absent at 5–9, exactly as observed. Position-scaled relevance makes it
    // pick #8.
    sqlite.seed({ id: "joker", content: "The user's dog's name is Joker.", createdAt: 1000 });
    sqlite.seed({ id: "cage", content: "Johnny sleeps in a cage by the kitchen window and squawks at dawn.", createdAt: 1001 });
    // Live: TradeBanger matched "have" and "any", two common words the query
    // distils to. The query says "household" rather than "user" so that no
    // distractor earns keyword credit and the rerank is the only variable.
    sqlite.seed({ id: "tradebanger", content: "It has never been confirmed whether TradeBanger has a GitHub repository; we have to verify before any code audit.", createdAt: 1002 });
    const topics = ["Magnific credits", "Stripe payouts", "Cloudflare zone", "invoice template", "DTF film stock", "trade show badge", "warehouse shelving", "payroll cutoff", "domain renewal", "support macro", "printer firmware", "shipping labels"];
    for (let i = 0; i < 12; i++) sqlite.seed({ id: `note-${i}`, content: `Note ${i}: ${topics[i]}.`, createdAt: 2000 + i });
    const env = envWithDense(sqlite, [
      { id: "joker", score: 0.62 },
      { id: "note-0", score: 0.56, mutual: 0.5 },
      { id: "cage", score: 0.55, near: { id: "joker", cos: 0.7 } },
      ...Array.from({ length: 11 }, (_, i) => ({ id: `note-${i + 1}`, score: 0.54 - i * 0.01, mutual: 0.5 })),
    ]);
    const { ctx } = makeCtx();

    const query = "does the household have any pets";
    const wide = await recallEntries({ query, topK: 15, synthesize: false }, env, ctx);
    // Sanity: the shape is the live one — keyword-only row on top, and the
    // target is a dense-only candidate (no query word, no "pet" stem).
    expect(wide.matches[0].id).toBe("tradebanger");
    const cage = wide.matches.find(m => m.id === "cage")!;
    expect(cage).toBeDefined();
    for (const t of [...wide.queryTokens, "pet", "household"]) expect(cage.content.toLowerCase()).not.toContain(t);

    const res = await recallEntries({ query, topK: 9, synthesize: false }, env, ctx);
    expect(res.matches.map(m => m.id)).toContain("cage");
  });

  it("P2a: a deprecated row never takes a slot from a live one, and the keyword SQL excludes it", async () => {
    // Five deprecated rows carry the query's rare word verbatim; one live row
    // carries it too. Before the fix the five took every topK=5 slot in MMR and
    // were dropped at hydration — an empty answer with a live match sitting
    // sixth.
    for (let i = 0; i < 5; i++) {
      sqlite.seed({ id: `old-${i}`, content: `Quarterly zephyr report cadence memo ${i}, superseded.`, createdAt: 2000 + i, tags: ["status:deprecated"] });
    }
    sqlite.seed({ id: "live", content: "The zephyr report moved to a monthly cadence.", createdAt: 1000 });
    const env = envWithDense(sqlite, []); // dense arm silent: the keyword arm is the whole candidate source
    const { ctx } = makeCtx();

    const res = await recallEntries({ query: "zephyr report cadence", topK: 5, synthesize: false }, env, ctx);

    expect(res.matches.map(m => m.id)).toEqual(["live"]);
    const keywordSql = sqlite.issued.find(s => s.includes("content LIKE ?") && s.includes("ORDER BY created_at DESC LIMIT"));
    expect(keywordSql).toContain(`tags NOT LIKE '%"status:deprecated"%'`);
  });

  it("P1: confidence is absolute — an irrelevant rank-1 cannot read 100%", async () => {
    // Q4-shaped: the only dense hit is weak (cosine 0.31) and unrelated; the
    // real answer is a keyword-only hit further down.
    sqlite.seed({ id: "marker", content: "Quantum Brain2 serious test marker — codeword: falcon-tundra-82.", createdAt: 1000 });
    sqlite.seed({ id: "domain", content: "The domain getaiskilldrops.com was purchased on Cloudflare, since aiskilldrops.com was already taken by someone else.", createdAt: 999 });
    const weakEnv = envWithDense(sqlite, [{ id: "marker", score: 0.31 }]);
    const { ctx } = makeCtx();

    const weak = await recallEntries({ query: "which web address did we buy for the getaiskilldrops business", topK: 5, synthesize: false }, weakEnv, ctx);
    const marker = weak.matches.find(m => m.id === "marker")!;
    const domain = weak.matches.find(m => m.id === "domain")!;
    expect(marker).toBeDefined();
    expect(domain).toBeDefined();
    // The irrelevant dense hit reports its own cosine, not 1.0.
    expect(marker.confidence).toBeCloseTo(0.31, 2);
    // The keyword-only answer reports the share of the searched vocabulary it
    // contains — bounded, and never inflated to 1 by its rank.
    expect(domain.confidence).toBeGreaterThan(0);
    expect(domain.confidence).toBeLessThan(1);
    // Rank order is untouched: the weak dense hit still leads, it just no
    // longer claims to be a certainty.
    expect(weak.matches[0].id).toBe("marker");
    expect(weak.matches[0].score).toBe(1);

    // A genuinely strong dense match reports a genuinely high number.
    const strongEnv = envWithDense(sqlite, [{ id: "domain", score: 0.88 }]);
    const strong = await recallEntries({ query: "which web address did we buy for the getaiskilldrops business", topK: 5, synthesize: false }, strongEnv, ctx);
    expect(strong.matches[0].id).toBe("domain");
    expect(strong.matches[0].confidence).toBeGreaterThanOrEqual(0.88);

    // The rendered text uses confidence, so "100%" is no longer automatic.
    const text = renderRecallText(weak.matches, "", { queryTokens: weak.queryTokens });
    expect(text).not.toContain("(100% match)");
    expect(text).toContain(`(${Math.round((marker.confidence ?? 0) * 100)}% match)`);
  });
});
