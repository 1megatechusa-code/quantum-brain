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

/** A dense arm that answers every query with the same fixed hits (id + cosine). */
function envWithDense(sqlite: SqliteD1, hits: { id: string; score: number }[]): Env {
  return makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    VECTORIZE: makeVectorizeMock({
      query: vi.fn().mockResolvedValue({
        matches: hits.map(h => ({ id: h.id, score: h.score, metadata: { parentId: h.id }, values: new Array(384).fill(0.1) })),
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

    const ids = res.matches.map(m => m.id);
    expect(ids).toContain("bluejay");
    // The dense hits are still there — merging must add, not replace.
    expect(ids).toContain("joker");
    expect(ids).toContain("gator");
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
