import type { Env } from "../env";
import { json } from "../lib/http";
import {
  activateCustomer, cancelCustomer, connectorUrl, findCustomerByStripeCustomer, findCustomerBySubscription,
  isPlan, markActivationEmailSent, type Plan,
} from "../billing/customers";
import { sendActivationEmail } from "../billing/email";
import {
  createCheckoutSession, getCheckoutSession, getSubscription, verifyStripeSignature,
  type CheckoutSession, type Subscription,
} from "../billing/stripe";

/**
 * Quantum Brain billing (Phase D): the four public routes.
 *
 *   GET  /subscribe                    plan picker
 *   GET  /subscribe/checkout?plan=…    creates a Stripe Checkout Session, 303s to it
 *   GET  /subscribe/success            "check your email"
 *   POST /stripe-webhook               provisions on payment, revokes on cancellation
 *
 * None of these carry a bearer token — a buyer has no key yet, and Stripe signs
 * its own requests — so they are the ONLY routes in src/routes that skip
 * requireIdentity, and the webhook is the only one that writes. Everything a
 * customer later does with the key goes through the same identity-scoped paths
 * as a team member; nothing here touches entries.
 */

const PRICES: Record<Plan, { label: string; amount: string; per: string; blurb: string }> = {
  monthly: { label: "Monthly", amount: "$3", per: "per month", blurb: "Cancel anytime." },
  yearly: { label: "Yearly", amount: "$25", per: "per year", blurb: "Two months free." },
};

function publicBase(env: Env, request: Request): string {
  return (env.WORKER_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, main: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--accent:#5b5bd6;--accent-fg:#fff}
  @media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--card:#1c1c21;--fg:#f5f5f7;--muted:#a1a1a6;--line:#2c2c33}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  main{max-width:720px;margin:0 auto;padding:48px 20px}
  h1{font-size:28px;margin:0 0 6px}.sub{color:var(--muted);margin:0 0 28px}
  .plans{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:560px){.plans{grid-template-columns:1fr}}
  .plan{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:6px}
  .plan h2{margin:0;font-size:18px}.price{font-size:34px;font-weight:700;margin:4px 0 0}.per{color:var(--muted);font-size:14px}
  .blurb{color:var(--muted);font-size:14px;margin:0 0 14px}
  .btn{display:inline-block;text-align:center;background:var(--accent);color:var(--accent-fg);text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:600;margin-top:auto}
  .btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  ul{padding-left:20px;color:var(--muted);font-size:15px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
  .foot{color:var(--muted);font-size:13px;margin-top:28px;text-align:center}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
</style></head><body><main>${main}<p class="foot">AI Skill Drops · Quantum Brain</p></main></body></html>`;
}

function subscribePage(notice?: string): string {
  const cards = (Object.keys(PRICES) as Plan[]).map((plan) => {
    const p = PRICES[plan];
    return `<div class="plan"><h2>${p.label}</h2><div class="price">${p.amount}</div><div class="per">${p.per}</div>
      <p class="blurb">${p.blurb}</p><a class="btn" href="/subscribe/checkout?plan=${plan}">Subscribe ${p.label.toLowerCase()}</a></div>`;
  }).join("");
  return page("Quantum Brain — Cloud Sync", `
    <h1>Quantum Brain · Cloud Sync</h1>
    <p class="sub">One private brain for every Claude you use — browser, phone, and desktop stay in sync.</p>
    ${notice ? `<p class="card" style="margin:0 0 16px">${escapeHtml(notice)}</p>` : ""}
    <div class="plans">${cards}</div>
    <ul style="margin-top:24px">
      <li>Your connector URL and API key arrive by email within a minute of payment.</li>
      <li>Add it once in claude.ai → Settings → Connectors. No account signup, no code.</li>
      <li>Your memories are stored in a private workspace only your key can reach.</li>
    </ul>`);
}

function successPage(email: string | null): string {
  const where = email ? `We sent it to <strong>${escapeHtml(email)}</strong>.` : "We sent it to the address you used at checkout.";
  return page("Check your email — Quantum Brain", `
    <div class="card">
      <h1>You&rsquo;re in. Check your email 📬</h1>
      <p>Your Quantum Brain activation email is on its way. ${where}</p>
      <p>It contains your personal <strong>connector URL</strong>, your <strong>API key</strong>, and the two-minute setup steps for Claude.ai and Claude Desktop.</p>
      <ul>
        <li>Not there after a few minutes? Check spam or promotions.</li>
        <li>Still nothing? Reply to your Stripe receipt and we&rsquo;ll resend it.</li>
      </ul>
      <a class="btn secondary" href="https://claude.ai/settings/connectors">Open Claude connector settings</a>
    </div>`);
}

async function resolvePlan(env: Env, session: CheckoutSession): Promise<Plan> {
  if (isPlan(session.metadata?.plan)) return session.metadata!.plan as Plan;
  // A session that did not come from /subscribe/checkout (a Payment Link, say)
  // carries no metadata; the subscription's price id still says which plan.
  if (session.subscription && env.STRIPE_SECRET_KEY) {
    try {
      const sub: Subscription = await getSubscription(env.STRIPE_SECRET_KEY, session.subscription);
      const priceId = sub.items?.data?.[0]?.price?.id;
      if (priceId && priceId === env.QB_PRICE_YEARLY) return "yearly";
      if (priceId && priceId === env.QB_PRICE_MONTHLY) return "monthly";
    } catch (e) {
      console.error("plan lookup via subscription failed (defaulting to monthly):", e);
    }
  }
  return "monthly";
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured" }, 503);
  const body = await request.text();
  const verdict = await verifyStripeSignature(request.headers.get("Stripe-Signature"), body, env.STRIPE_WEBHOOK_SECRET);
  if (!verdict.ok) {
    console.warn("stripe webhook rejected:", verdict.reason);
    return json({ ok: false, error: `Invalid signature: ${verdict.reason}` }, 400);
  }

  let event: { id?: string; type?: string; data?: { object?: any } };
  try { event = JSON.parse(body); } catch { return json({ ok: false, error: "Body is not JSON" }, 400); }
  const object = event.data?.object ?? {};

  switch (event.type) {
    case "checkout.session.completed": {
      const session = object as CheckoutSession;
      if (session.mode !== "subscription") return json({ received: true, ignored: "not a subscription checkout" });
      if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
        // Async payment methods complete later via checkout.session.async_payment_succeeded;
        // not offered on these plans, so this is only defensive.
        return json({ received: true, ignored: `payment_status ${session.payment_status}` });
      }
      const email = (session.customer_details?.email || session.customer_email || "").trim();
      const stripeCustomerId = typeof session.customer === "string" ? session.customer : "";
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : "";
      if (!email || !stripeCustomerId) {
        // A retry cannot add what Stripe did not send; answer 200 so it stops, and log loudly.
        console.error("checkout.session.completed without email/customer", { id: session.id, email: !!email, customer: !!stripeCustomerId });
        return json({ received: true, ignored: "missing customer email or id" });
      }

      const plan = await resolvePlan(env, session);
      const { customer, created, reactivated } = await activateCustomer(env, { email, stripeCustomerId, stripeSubscriptionId: subscriptionId, plan });

      // The email is owed when the key was just minted, when a returning
      // customer just resubscribed (they may have lost it), and when a previous
      // attempt never landed — email_sent_at stays NULL, so a Stripe retry of the
      // same event resends rather than re-provisioning.
      const owed = created || reactivated || !customer.email_sent_at;
      let emailed = false;
      if (owed) {
        await sendActivationEmail(env, {
          to: customer.email,
          connectorUrl: connectorUrl(env, request, customer.id),
          apiKey: customer.api_key,
          plan: customer.plan,
        });
        await markActivationEmailSent(env, customer.id);
        emailed = true;
      }
      console.log("quantum-brain customer activated", { id: customer.id, created, plan: customer.plan, emailed });
      return json({ received: true, customerId: customer.id, created, emailed });
    }

    case "customer.subscription.deleted": {
      const sub = object as Subscription;
      const customer = (await findCustomerBySubscription(env, sub.id))
        ?? (await findCustomerByStripeCustomer(env, typeof sub.customer === "string" ? sub.customer : ""));
      if (!customer) return json({ received: true, ignored: "no matching customer" });
      if (customer.status !== "cancelled") await cancelCustomer(env, customer);
      console.log("quantum-brain customer cancelled", { id: customer.id });
      return json({ received: true, customerId: customer.id, cancelled: true });
    }

    default:
      return json({ received: true, ignored: event.type ?? "unknown event" });
  }
}

async function handleCheckout(request: Request, url: URL, env: Env): Promise<Response> {
  const plan = url.searchParams.get("plan");
  if (!isPlan(plan)) return html(subscribePage("Pick a plan to continue."), 400);
  const priceId = plan === "yearly" ? env.QB_PRICE_YEARLY : env.QB_PRICE_MONTHLY;
  if (!env.STRIPE_SECRET_KEY || !priceId) {
    return html(subscribePage("Checkout is not configured on this deployment yet."), 503);
  }
  const base = publicBase(env, request);
  try {
    const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
      priceId, plan,
      successUrl: `${base}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/subscribe`,
    });
    if (!session.url) throw new Error("Stripe returned a session without a url");
    return Response.redirect(session.url, 303);
  } catch (e) {
    console.error("checkout session failed:", e);
    return html(subscribePage("Sorry — we could not start checkout. Please try again in a moment."), 502);
  }
}

async function handleSuccess(url: URL, env: Env): Promise<Response> {
  let email: string | null = null;
  const sessionId = url.searchParams.get("session_id");
  if (sessionId && env.STRIPE_SECRET_KEY) {
    try {
      const session = await getCheckoutSession(env.STRIPE_SECRET_KEY, sessionId);
      email = session.customer_details?.email || session.customer_email || null;
    } catch (e) {
      console.warn("success page: session lookup failed (non-fatal):", e);
    }
  }
  return html(successPage(email));
}

export async function handleBillingRoutes(request: Request, url: URL, env: Env): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/stripe-webhook") {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    return handleWebhook(request, env);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (path === "/subscribe") return html(subscribePage());
  if (path === "/subscribe/checkout") return handleCheckout(request, url, env);
  if (path === "/subscribe/success") return handleSuccess(url, env);
  return null;
}
