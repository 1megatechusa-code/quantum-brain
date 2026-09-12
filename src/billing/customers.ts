import type { Env } from "../env";
import { hashToken } from "../lib/identity";

/**
 * Paying customers (Quantum Brain Tier 2).
 *
 * A customer is a `users` row with a personal workspace and NOTHING else: no
 * company membership, so `readableWorkspaces` in src/lib/scope.ts resolves to
 * exactly their own workspace and every existing read and write path isolates
 * them for free. The `customers` row beside it carries the billing facts and
 * the api_key in the clear (the users row holds only its hash, like a team
 * member's token) so a lost key can be resent.
 *
 * Identity is the STRIPE SUBSCRIPTION, not the email address. One subscription
 * is one row, one key, one workspace: a person who buys twice with the same
 * address holds two independent customers, and cancelling one of them can only
 * ever suspend the row carrying that subscription id. The email is kept for
 * correspondence and for one thing more — recognising a CANCELLED customer who
 * comes back, so they get their key and memories back rather than a blank
 * brain. It never merges two live subscriptions.
 *
 * Because of that, the users row stores NO email for a customer: users.email
 * is UNIQUE (team members are keyed by it), and a second subscription under
 * the same address must still get its own users row. The address lives in
 * customers.email only.
 */

export type Plan = "monthly" | "yearly";

export interface CustomerRow {
  id: string;
  api_key: string;
  email: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: string;
  status: string;
  created_at: number;
  cancelled_at: number | null;
  email_sent_at: number | null;
}

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const API_KEY_PREFIX = "qb_";
export const API_KEY_RANDOM_LENGTH = 32;
export const API_KEY_PATTERN = /^qb_[A-Za-z0-9]{32}$/;

/** `qb_` + 32 alphanumerics from the CSPRNG, unbiased (rejection sampling). */
export function generateApiKey(): string {
  let out = "";
  // 62 symbols: accept bytes below 248 (= 4 × 62) so every symbol is equally
  // likely, and draw a fresh batch when rejections leave us short.
  while (out.length < API_KEY_RANDOM_LENGTH) {
    const bytes = new Uint8Array(API_KEY_RANDOM_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= 248) continue;
      out += ALPHANUMERIC[b % ALPHANUMERIC.length];
      if (out.length === API_KEY_RANDOM_LENGTH) break;
    }
  }
  return API_KEY_PREFIX + out;
}

/** Short, URL-safe customer id: the tail of the connector URL. */
function customerId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `qb-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isPlan(value: unknown): value is Plan {
  return value === "monthly" || value === "yearly";
}

export async function findCustomerById(env: Env, id: string): Promise<CustomerRow | null> {
  return env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first<CustomerRow>();
}

/**
 * The subscription id is the customer's identity: the only lookup the webhook
 * revokes on, and the first thing provisioning checks. Never ''.
 */
export async function findCustomerBySubscription(env: Env, subscriptionId: string): Promise<CustomerRow | null> {
  if (!subscriptionId) return null;
  return env.DB.prepare(`SELECT * FROM customers WHERE stripe_subscription_id = ?`).bind(subscriptionId).first<CustomerRow>();
}

/**
 * A CANCELLED customer who is plausibly the person now subscribing again: the
 * same Stripe customer (Stripe's own resubscribe shape), or failing that the
 * same email under a fresh Stripe customer (Checkout mints one per session).
 * Active rows are never candidates — an active subscription is somebody's
 * working key, and a new purchase is a new customer, not a claim on it. The
 * most recently cancelled wins when several qualify, a Stripe-customer match
 * ahead of an email match.
 */
export async function findReactivatableCustomer(env: Env, stripeCustomerId: string, email: string): Promise<CustomerRow | null> {
  if (!stripeCustomerId && !email) return null;
  return env.DB.prepare(
    `SELECT * FROM customers WHERE status = 'cancelled' AND (stripe_customer_id = ? OR email = ? COLLATE NOCASE)` +
    ` ORDER BY (stripe_customer_id = ?) DESC, cancelled_at DESC, created_at DESC LIMIT 1`,
  ).bind(stripeCustomerId, email, stripeCustomerId).first<CustomerRow>();
}

export interface ActivateInput {
  email: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  plan: Plan;
}

export interface ActivateResult {
  customer: CustomerRow;
  /** true when this call minted the key (new customer). */
  created: boolean;
  /** true when a cancelled (or re-bought) customer was brought back on their existing key. */
  reactivated: boolean;
}

/**
 * Provisions (or reactivates) a customer after a paid checkout.
 *
 * Keyed by the subscription, in this order:
 *   - the same subscription again is a webhook retry → return the row as-is
 *     (idx_customers_stripe_subscription makes this hold even when two
 *     deliveries race: the loser's INSERT fails, Stripe retries, this hits);
 *   - a new subscription from a CANCELLED customer — same Stripe customer, or
 *     same email — is someone coming back → reactivate that row under the new
 *     subscription: the key they already pasted into their client works again
 *     and their memories are still there;
 *   - otherwise mint a key and create the user + workspace + membership +
 *     customer in one D1 batch, so a half-provisioned customer cannot exist.
 *     An ACTIVE row under the same email or Stripe customer is deliberately
 *     not consulted: a second live subscription is a second, isolated customer.
 */
export async function activateCustomer(env: Env, input: ActivateInput): Promise<ActivateResult> {
  const email = input.email.trim().toLowerCase();
  const now = Date.now();

  const bySubscription = await findCustomerBySubscription(env, input.stripeSubscriptionId);
  if (bySubscription) return { customer: bySubscription, created: false, reactivated: false };

  const returning = await findReactivatableCustomer(env, input.stripeCustomerId, email);
  if (returning) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE customers SET status = 'active', cancelled_at = NULL, plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, email = ? WHERE id = ?`,
      ).bind(input.plan, input.stripeCustomerId, input.stripeSubscriptionId, email, returning.id),
      env.DB.prepare(`UPDATE users SET suspended = 0 WHERE id = ?`).bind(returning.id),
    ]);
    const customer = (await findCustomerById(env, returning.id))!;
    return { customer, created: false, reactivated: true };
  }

  const id = customerId();
  const apiKey = generateApiKey();
  const tokenHash = await hashToken(apiKey);
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const name = email.split("@")[0] || "Customer";

  await env.DB.batch([
    // email NULL, not the address — see the header. customers.email carries it.
    env.DB.prepare(
      `INSERT INTO users (id, name, email, role, token_hash, suspended, created_at) VALUES (?, ?, NULL, 'member', ?, 0, ?)`,
    ).bind(id, name, tokenHash, now),
    env.DB.prepare(`INSERT INTO workspaces (id, kind, name, created_at) VALUES (?, 'personal', ?, ?)`).bind(workspaceId, name, now),
    env.DB.prepare(`INSERT INTO memberships (user_id, workspace_id, created_at) VALUES (?, ?, ?)`).bind(id, workspaceId, now),
    env.DB.prepare(
      `INSERT INTO customers (id, api_key, email, stripe_customer_id, stripe_subscription_id, plan, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).bind(id, apiKey, email, input.stripeCustomerId, input.stripeSubscriptionId, input.plan, now),
  ]);

  return {
    customer: {
      id, api_key: apiKey, email, stripe_customer_id: input.stripeCustomerId,
      stripe_subscription_id: input.stripeSubscriptionId, plan: input.plan, status: "active",
      created_at: now, cancelled_at: null, email_sent_at: null,
    },
    created: true,
    reactivated: false,
  };
}

/**
 * Revokes access on cancellation. The customers row is marked cancelled and the
 * users row suspended, which is the flag identity resolution already refuses on
 * (src/lib/identity.ts: `suspended = 0`), so the key stops working on the next
 * request. Memories are kept: a customer who resubscribes gets them back.
 *
 * Takes the row, not an email or Stripe customer id: the caller resolved it by
 * subscription, and this touches that one row's user and nothing else.
 */
export async function cancelCustomer(env: Env, customer: CustomerRow): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE customers SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).bind(now, customer.id),
    env.DB.prepare(`UPDATE users SET suspended = 1 WHERE id = ?`).bind(customer.id),
  ]);
}

export async function markActivationEmailSent(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE customers SET email_sent_at = ? WHERE id = ?`).bind(Date.now(), id).run();
}

/** The URL a customer pastes into their MCP client. */
export function connectorUrl(env: Env, request: Request, customerId: string): string {
  const base = (env.WORKER_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  return `${base}/mcp/${customerId}`;
}
