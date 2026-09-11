/**
 * Quantum Brain billing, end to end through the Worker against real SQLite.
 *
 * The shape: Stripe says someone paid → the webhook mints a key → that key
 * authenticates like a member's token on REST and on `/mcp/<id>` → the customer
 * sees only their own rows → Stripe says they cancelled → the key stops working
 * → they come back → the same key works again with their memories intact.
 *
 * Stripe and Resend are reached over `fetch`, which is stubbed here and records
 * what was sent; nothing in this file talks to the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../../src/index";
import { apiHandler } from "../../src/mcp/handler";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv, makeMemoryKV } from "../helpers/make-env";
import { resetDatabaseInit, initializeDatabase } from "../../src/db/init";
import { ensureTenantBootstrap } from "../../src/lib/tenancy";
import { signStripePayload } from "../../src/billing/stripe";
import { API_KEY_PATTERN } from "../../src/billing/customers";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<any>) => {} } as ExecutionContext;
const BASE = "http://localhost";
const WEBHOOK_SECRET = "whsec_test_secret";
const OWNER = "test-token";

let sqlite: SqliteD1;
let env: Env;
let outbound: { url: string; init: RequestInit }[] = [];
let stripeSubscriptionPrice = "price_monthly_test";

function stubFetch() {
  outbound = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    outbound.push({ url, init });
    if (url.startsWith("https://api.resend.com/emails")) {
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    if (url.startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
      return new Response(JSON.stringify({ id: "cs_1", customer_details: { email: "buyer@example.com" } }), { status: 200 });
    }
    if (url.startsWith("https://api.stripe.com/v1/checkout/sessions")) {
      return new Response(JSON.stringify({ id: "cs_new", url: "https://checkout.stripe.com/c/pay/cs_new" }), { status: 200 });
    }
    if (url.startsWith("https://api.stripe.com/v1/subscriptions/")) {
      return new Response(JSON.stringify({ id: "sub_x", customer: "cus_x", status: "active", items: { data: [{ price: { id: stripeSubscriptionPrice } }] } }), { status: 200 });
    }
    return new Response("unexpected outbound request in test: " + url, { status: 599 });
  }));
}

const call = (method: string, path: string, token: string | null, body?: unknown) =>
  worker.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);

async function webhook(event: Record<string, unknown>, opts: { secret?: string; header?: string | null } = {}) {
  const body = JSON.stringify(event);
  const header = opts.header === undefined ? await signStripePayload(body, opts.secret ?? WEBHOOK_SECRET) : opts.header;
  return worker.fetch(new Request(`${BASE}/stripe-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(header ? { "Stripe-Signature": header } : {}) },
    body,
  }), env, ctx);
}

function checkoutCompleted(over: Partial<{ email: string; customer: string; subscription: string; plan: string; metadata: Record<string, string> | null }> = {}) {
  const { email = "buyer@example.com", customer = "cus_A", subscription = "sub_A1", plan = "monthly" } = over;
  return {
    id: "evt_" + subscription, type: "checkout.session.completed",
    data: { object: {
      id: "cs_" + subscription, mode: "subscription", payment_status: "paid", status: "complete",
      customer, subscription, customer_details: { email },
      metadata: over.metadata === undefined ? { plan, product: "quantum-brain" } : over.metadata,
    } },
  };
}

function subscriptionDeleted(subscription = "sub_A1", customer = "cus_A") {
  return { id: "evt_del_" + subscription, type: "customer.subscription.deleted", data: { object: { id: subscription, customer, status: "canceled" } } };
}

const emailsSent = () => outbound.filter((o) => o.url.startsWith("https://api.resend.com/"))
  .map((o) => JSON.parse(String(o.init.body)) as { to: string[]; from: string; reply_to?: string; subject: string; text: string; html: string });

const customerRows = async () => (await sqlite.db.prepare(`SELECT * FROM customers ORDER BY created_at`).all()).results as any[];

/** MCP transport is mocked in vitest.setup.ts to answer "mcp"; this drives the real auth in front of it. */
const mcp = (path: string, token: string) =>
  apiHandler.fetch(new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "x" } } }),
  }), env, ctx);

beforeEach(async () => {
  resetDatabaseInit();
  stubFetch();
  stripeSubscriptionPrice = "price_monthly_test";
  sqlite = makeSqliteD1();
  env = makeTestEnv(undefined, {
    DB: sqlite.db as unknown as Env["DB"],
    OAUTH_KV: makeMemoryKV(),
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    QB_PRICE_MONTHLY: "price_monthly_test",
    QB_PRICE_YEARLY: "price_yearly_test",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "support@getaiskilldrops.com",
    EMAIL_REPLY_TO: "owner@example.com",
    WORKER_BASE_URL: "https://quantum-brain.example.workers.dev",
  });
  await initializeDatabase(env);
  await ensureTenantBootstrap(env);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite?.close();
});

describe("POST /stripe-webhook — signature gate", () => {
  it("refuses an unsigned, mis-signed, or stale request and provisions nothing", async () => {
    expect((await webhook(checkoutCompleted(), { header: null })).status).toBe(400);
    expect((await webhook(checkoutCompleted(), { secret: "whsec_wrong" })).status).toBe(400);
    const stale = await signStripePayload(JSON.stringify(checkoutCompleted()), WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect((await webhook(checkoutCompleted(), { header: stale })).status).toBe(400);
    expect((await customerRows())).toHaveLength(0);
    expect(emailsSent()).toHaveLength(0);
  });

  it("answers 503 when no webhook secret is configured", async () => {
    env.STRIPE_WEBHOOK_SECRET = undefined;
    expect((await webhook(checkoutCompleted())).status).toBe(503);
  });

  it("acknowledges events it does not act on", async () => {
    const res = await webhook({ id: "evt_x", type: "invoice.paid", data: { object: {} } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: "invoice.paid" });
    expect((await customerRows())).toHaveLength(0);
  });
});

describe("checkout.session.completed → a working, isolated customer", () => {
  it("mints a key, stores the customer, and emails the activation details", async () => {
    const res = await webhook(checkoutCompleted({ plan: "yearly" }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ received: true, created: true, emailed: true });

    const [row] = (await customerRows());
    expect(row).toMatchObject({
      id: body.customerId, email: "buyer@example.com", stripe_customer_id: "cus_A",
      stripe_subscription_id: "sub_A1", plan: "yearly", status: "active", cancelled_at: null,
    });
    expect(row.api_key).toMatch(API_KEY_PATTERN);
    expect(row.email_sent_at).toBeGreaterThan(0);

    // The users row carries only the hash, exactly like a team member's token.
    const user = await sqlite.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(row.id).first() as any;
    expect(user).toMatchObject({ email: "buyer@example.com", role: "member", suspended: 0 });
    expect(user.token_hash).not.toContain(row.api_key);
    // One personal workspace, and no company membership: nothing shared leaks in.
    const memberships = (await sqlite.db.prepare(
      `SELECT w.kind FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?`,
    ).bind(row.id).all()).results as { kind: string }[];
    expect(memberships.map((m) => m.kind)).toEqual(["personal"]);

    const [email] = emailsSent();
    expect(email.to).toEqual(["buyer@example.com"]);
    expect(email.from).toContain("support@getaiskilldrops.com");
    expect(email.reply_to).toBe("owner@example.com");
    expect(email.text).toContain(`https://quantum-brain.example.workers.dev/mcp/${row.id}`);
    expect(email.text).toContain(row.api_key);
    expect(email.html).toContain(row.api_key);
    expect(email.text).toContain("Yearly ($25/year)");
  });

  it("falls back to the subscription's price when the session carries no plan metadata (Payment Links)", async () => {
    stripeSubscriptionPrice = "price_yearly_test";
    await webhook(checkoutCompleted({ metadata: null }));
    expect((await customerRows())[0].plan).toBe("yearly");
    expect(outbound.some((o) => o.url === "https://api.stripe.com/v1/subscriptions/sub_A1")).toBe(true);
  });

  it("is idempotent under Stripe's retries: one customer, one email", async () => {
    await webhook(checkoutCompleted());
    const again = await webhook(checkoutCompleted());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, emailed: false });
    expect((await customerRows())).toHaveLength(1);
    expect(emailsSent()).toHaveLength(1);
  });

  it("resends on a retry when the first email attempt failed, and tells Stripe to retry", async () => {
    let fail = true;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (fail && String(input).startsWith("https://api.resend.com/")) { fail = false; return new Response("boom", { status: 500 }); }
      return real(input, init);
    }));
    await expect(webhook(checkoutCompleted())).rejects.toThrow(/Resend 500/);
    expect((await customerRows())).toHaveLength(1);
    expect((await customerRows())[0].email_sent_at).toBeNull();

    const retry = await webhook(checkoutCompleted());
    expect(await retry.json()).toMatchObject({ created: false, emailed: true });
    expect((await customerRows())[0].email_sent_at).toBeGreaterThan(0);
    expect((await customerRows())).toHaveLength(1);
  });

  it("the key authenticates on REST and each customer sees only their own rows", async () => {
    await webhook(checkoutCompleted({ email: "a@example.com", customer: "cus_A", subscription: "sub_A1" }));
    await webhook(checkoutCompleted({ email: "b@example.com", customer: "cus_B", subscription: "sub_B1" }));
    const [a, b] = (await customerRows());
    expect(a.api_key).not.toBe(b.api_key);

    expect((await call("GET", "/list", null)).status).toBe(401);
    expect((await call("GET", "/list", "qb_notarealkey00000000000000000000")).status).toBe(401);

    const captured = await call("POST", "/capture", a.api_key, { content: "Customer A private: my launch date is Friday", tags: ["launch"] });
    expect(captured.status).toBe(200);
    await call("POST", "/capture", b.api_key, { content: "Customer B private: my cat is named Mochi" });

    const aList = (await (await call("GET", "/list?n=50", a.api_key)).json() as any[]).map((e) => e.content);
    const bList = (await (await call("GET", "/list?n=50", b.api_key)).json() as any[]).map((e) => e.content);
    expect(aList).toEqual([expect.stringContaining("Customer A private")]);
    expect(bList).toEqual([expect.stringContaining("Customer B private")]);

    // The owner's own view is untouched by customers' rows: they live in
    // workspaces the owner is not a member of.
    const ownerList = (await (await call("GET", "/list?n=50", OWNER)).json() as any[]).map((e) => e.content);
    expect(ownerList.join(" ")).not.toContain("Customer");
  });

  it("the key authenticates on /mcp/<id>, bare /mcp, and never under another customer's id", async () => {
    await webhook(checkoutCompleted({ email: "a@example.com", customer: "cus_A", subscription: "sub_A1" }));
    await webhook(checkoutCompleted({ email: "b@example.com", customer: "cus_B", subscription: "sub_B1" }));
    const [a, b] = (await customerRows());

    expect((await mcp(`/mcp/${a.id}`, a.api_key)).status).toBe(200);
    expect((await mcp(`/mcp`, a.api_key)).status).toBe(200);
    expect((await mcp(`/mcp/${a.id}`, b.api_key)).status).toBe(401);
    expect((await mcp(`/mcp/${a.id}`, "qb_notarealkey00000000000000000000")).status).toBe(401);
    expect((await mcp(`/mcp/${a.id}/deeper`, a.api_key)).status).toBe(404);
    // The owner's static token still works on the bare route, as it always has.
    expect((await mcp(`/mcp`, OWNER)).status).toBe(200);
  });
});

describe("customer.subscription.deleted → revoked, and resubscribing restores", () => {
  it("marks the customer cancelled, suspends the key, and keeps their memories", async () => {
    await webhook(checkoutCompleted());
    const [row] = (await customerRows());
    await call("POST", "/capture", row.api_key, { content: "kept across cancellation" });

    const res = await webhook(subscriptionDeleted());
    expect(await res.json()).toMatchObject({ received: true, cancelled: true, customerId: row.id });
    const after = (await customerRows())[0];
    expect(after.status).toBe("cancelled");
    expect(after.cancelled_at).toBeGreaterThan(0);

    const refused = await call("GET", "/list", row.api_key);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "suspended" });
    expect((await mcp(`/mcp/${row.id}`, row.api_key)).status).toBe(401);
    expect(await sqlite.db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE workspace_id = (SELECT workspace_id FROM memberships WHERE user_id = ?)`).bind(row.id).first()).toMatchObject({ n: 1 });

    // A second delete for the same subscription is a no-op.
    expect((await webhook(subscriptionDeleted())).status).toBe(200);
    expect((await customerRows())).toHaveLength(1);
  });

  it("ignores a cancellation for a subscription it never provisioned", async () => {
    const res = await webhook(subscriptionDeleted("sub_unknown", "cus_unknown"));
    expect(await res.json()).toMatchObject({ received: true, ignored: "no matching customer" });
  });

  it("reactivates the same customer — same key, same memories — when they subscribe again", async () => {
    await webhook(checkoutCompleted({ subscription: "sub_A1" }));
    const [original] = (await customerRows());
    await call("POST", "/capture", original.api_key, { content: "from my first subscription" });
    await webhook(subscriptionDeleted("sub_A1"));

    // Same Stripe customer, new subscription (Stripe's own "resubscribe" shape).
    const res = await webhook(checkoutCompleted({ subscription: "sub_A2", plan: "yearly" }));
    expect(await res.json()).toMatchObject({ created: false, emailed: true, customerId: original.id });
    expect((await customerRows())).toHaveLength(1);
    const revived = (await customerRows())[0];
    expect(revived).toMatchObject({ api_key: original.api_key, status: "active", cancelled_at: null, plan: "yearly", stripe_subscription_id: "sub_A2" });

    const list = (await (await call("GET", "/list?n=50", original.api_key)).json() as any[]).map((e) => e.content);
    expect(list).toEqual(["from my first subscription"]);
    expect(emailsSent()).toHaveLength(2);
    expect(emailsSent()[1].text).toContain(original.api_key);
  });

  it("reactivates by email when the same person returns as a new Stripe customer", async () => {
    await webhook(checkoutCompleted({ email: "Same@Example.com", customer: "cus_old", subscription: "sub_old" }));
    await webhook(subscriptionDeleted("sub_old", "cus_old"));
    const res = await webhook(checkoutCompleted({ email: "same@example.com", customer: "cus_new", subscription: "sub_new" }));
    expect(await res.json()).toMatchObject({ created: false });
    expect((await customerRows())).toHaveLength(1);
    expect((await customerRows())[0]).toMatchObject({ stripe_customer_id: "cus_new", stripe_subscription_id: "sub_new", status: "active" });
  });
});

describe("GET /subscribe — checkout pages", () => {
  it("serves the plan picker with both plans and no auth", async () => {
    const res = await call("GET", "/subscribe", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("$3");
    expect(html).toContain("$25");
    expect(html).toContain("/subscribe/checkout?plan=monthly");
    expect(html).toContain("/subscribe/checkout?plan=yearly");
  });

  it("creates a Checkout Session for the chosen plan and redirects to it", async () => {
    const res = await call("GET", "/subscribe/checkout?plan=yearly", null);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_new");
    const stripeCall = outbound.find((o) => o.url === "https://api.stripe.com/v1/checkout/sessions")!;
    expect((stripeCall.init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    const form = new URLSearchParams(String(stripeCall.init.body));
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_yearly_test");
    expect(form.get("metadata[plan]")).toBe("yearly");
    expect(form.get("success_url")).toBe("https://quantum-brain.example.workers.dev/subscribe/success?session_id={CHECKOUT_SESSION_ID}");
    expect(form.get("cancel_url")).toBe("https://quantum-brain.example.workers.dev/subscribe");
  });

  it("rejects an unknown plan and reports an unconfigured deployment", async () => {
    expect((await call("GET", "/subscribe/checkout?plan=weekly", null)).status).toBe(400);
    env.STRIPE_SECRET_KEY = undefined;
    expect((await call("GET", "/subscribe/checkout?plan=monthly", null)).status).toBe(503);
  });

  it("the success page names the buyer's email when Stripe can tell us", async () => {
    const res = await call("GET", "/subscribe/success?session_id=cs_1", null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("buyer@example.com");
    // And degrades to a generic page without a session.
    expect(await (await call("GET", "/subscribe/success", null)).text()).toContain("Check your email");
  });

  it("does not expose the webhook to GET", async () => {
    expect((await call("GET", "/stripe-webhook", null)).status).toBe(405);
  });
});
