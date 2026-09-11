import { describe, it, expect } from "vitest";
import { encodeForm, signStripePayload, verifyStripeSignature } from "../../src/billing/stripe";
import { API_KEY_PATTERN, generateApiKey, isPlan } from "../../src/billing/customers";
import { renderActivationEmail } from "../../src/billing/email";
import { customerIdFromPath } from "../../src/mcp/handler";

const SECRET = "whsec_test_secret_value";

describe("Stripe webhook signature", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a header signed with the secret", async () => {
    const header = await signStripePayload(body, SECRET);
    expect(await verifyStripeSignature(header, body, SECRET)).toEqual({ ok: true });
  });

  it("rejects a missing or malformed header", async () => {
    expect(await verifyStripeSignature(null, body, SECRET)).toMatchObject({ ok: false });
    expect(await verifyStripeSignature("garbage", body, SECRET)).toMatchObject({ ok: false, reason: "malformed Stripe-Signature header" });
    expect(await verifyStripeSignature("t=123", body, SECRET)).toMatchObject({ ok: false });
  });

  it("rejects the wrong secret and a tampered body", async () => {
    const header = await signStripePayload(body, SECRET);
    expect(await verifyStripeSignature(header, body, "whsec_other")).toMatchObject({ ok: false, reason: "signature mismatch" });
    expect(await verifyStripeSignature(header, body + " ", SECRET)).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a timestamp outside the tolerance window", async () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const header = await signStripePayload(body, SECRET, stale);
    expect(await verifyStripeSignature(header, body, SECRET)).toMatchObject({ ok: false, reason: "timestamp outside tolerance" });
    // The same header is fine when "now" is within tolerance of it.
    expect(await verifyStripeSignature(header, body, SECRET, { now: stale + 10 })).toEqual({ ok: true });
  });

  it("accepts when any one of several v1 signatures matches (secret rollover)", async () => {
    const good = await signStripePayload(body, SECRET);
    const [t, v1] = good.split(",");
    const header = `${t},v1=deadbeef,${v1}`;
    expect(await verifyStripeSignature(header, body, SECRET)).toEqual({ ok: true });
  });
});

describe("Stripe form encoding", () => {
  it("nests arrays and objects the way Stripe expects", () => {
    const encoded = encodeForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      metadata: { plan: "monthly" },
      skipped: undefined,
    });
    expect(encoded.split("&").sort()).toEqual([
      "line_items%5B0%5D%5Bprice%5D=price_1",
      "line_items%5B0%5D%5Bquantity%5D=1",
      "metadata%5Bplan%5D=monthly",
      "mode=subscription",
    ]);
  });
});

describe("API keys", () => {
  it("are qb_ + 32 alphanumerics and unique", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const key = generateApiKey();
      expect(key).toMatch(API_KEY_PATTERN);
      keys.add(key);
    }
    expect(keys.size).toBe(200);
  });

  it("recognises exactly the two plans", () => {
    expect(isPlan("monthly")).toBe(true);
    expect(isPlan("yearly")).toBe(true);
    expect(isPlan("weekly")).toBe(false);
    expect(isPlan(undefined)).toBe(false);
  });
});

describe("activation email", () => {
  it("carries the connector URL, the key and the setup steps in both bodies", () => {
    const { subject, text, html } = renderActivationEmail({
      to: "a@example.com",
      connectorUrl: "https://qb.example.workers.dev/mcp/qb-0123456789abcdef",
      apiKey: "qb_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
      plan: "yearly",
    });
    expect(subject).toMatch(/Quantum Brain/);
    for (const body of [text, html]) {
      expect(body).toContain("https://qb.example.workers.dev/mcp/qb-0123456789abcdef");
      expect(body).toContain("qb_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef");
      expect(body).toContain("Add custom connector");
      expect(body).toContain("claude_desktop_config.json");
      expect(body).toContain("Yearly ($25/year)");
    }
  });

  it("escapes HTML in values it interpolates", () => {
    const { html } = renderActivationEmail({
      to: "a@example.com", connectorUrl: "https://x/<script>", apiKey: "qb_x", plan: "monthly",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("MCP connector path", () => {
  it("maps the bare route, a customer route, and nothing else", () => {
    expect(customerIdFromPath("/mcp")).toBe("");
    expect(customerIdFromPath("/mcp/")).toBe("");
    expect(customerIdFromPath("/mcp/qb-0123456789abcdef")).toBe("qb-0123456789abcdef");
    expect(customerIdFromPath("/mcp/qb-0123456789abcdef/")).toBe("qb-0123456789abcdef");
    expect(customerIdFromPath("/mcp/a/b")).toBeNull();
    expect(customerIdFromPath("/mcpx")).toBeNull();
  });
});
