/**
 * The slice of Stripe this Worker needs, over plain fetch. No SDK: the official
 * one drags in Node shims the Worker does not need for three endpoints and one
 * signature check, and every call here is a form-encoded POST or a GET.
 */

/** Stripe's webhook signature tolerance, matching stripe-node's default. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const STRIPE_API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Nested keys the way Stripe's form encoding wants them: a[b][0][c]=v. */
export function encodeForm(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        parts.push(typeof item === "object" && item !== null
          ? encodeForm(item as Record<string, unknown>, `${name}[${i}]`)
          : `${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === "object") {
      parts.push(encodeForm(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripeRequest<T>(secretKey: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? encodeForm(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* non-JSON error body; fall through */ }
  if (!res.ok) {
    throw new StripeError(res.status, data?.error?.message ?? `Stripe ${method} ${path} failed (${res.status})`);
  }
  return data as T;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  mode: string;
  payment_status: string;
  status?: string | null;
  customer: string | null;
  subscription: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  metadata?: Record<string, string> | null;
}

export interface Subscription {
  id: string;
  customer: string;
  status: string;
  items?: { data?: { price?: { id?: string } }[] };
}

export async function createCheckoutSession(
  secretKey: string,
  input: { priceId: string; plan: "monthly" | "yearly"; successUrl: string; cancelUrl: string },
): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>(secretKey, "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: true,
    // Carried onto the session AND the subscription so the webhook can name the
    // plan without a second lookup, and a later subscription event still can.
    metadata: { plan: input.plan, product: "quantum-brain" },
    subscription_data: { metadata: { plan: input.plan, product: "quantum-brain" } },
  });
}

export function getCheckoutSession(secretKey: string, id: string): Promise<CheckoutSession> {
  return stripeRequest<CheckoutSession>(secretKey, "GET", `/checkout/sessions/${encodeURIComponent(id)}`);
}

export function getSubscription(secretKey: string, id: string): Promise<Subscription> {
  return stripeRequest<Subscription>(secretKey, "GET", `/subscriptions/${encodeURIComponent(id)}`);
}

// ── Webhook signatures ────────────────────────────────────────────────────────

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** Compares without short-circuiting on the first differing byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a `Stripe-Signature` header against the RAW request body.
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`; the signed payload is
 * `${t}.${body}`. Any v1 matching accepts (Stripe sends several while a secret is
 * being rolled), and a timestamp older than the tolerance is rejected so a
 * captured request cannot be replayed indefinitely. Returns the reason on
 * failure rather than throwing so the route can log it and answer 400.
 */
export async function verifyStripeSignature(
  header: string | null,
  body: string,
  secret: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || !signatures.length) return { ok: false, reason: "malformed Stripe-Signature header" };

  const ts = Number(timestamp);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${body}`);
  return signatures.some((s) => timingSafeEqual(s, expected))
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/** Test helper twin of verify: produces a header Stripe would have sent. */
export async function signStripePayload(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}
