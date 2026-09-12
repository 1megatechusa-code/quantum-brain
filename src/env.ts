// Bindings come from the generated Cloudflare.Env (see `wrangler types`);
// VECTORIZE_GRACE_MS is widened from its generated literal default so tests
// and per-deploy vars can override it.
// The billing vars are omitted from the generated base for the same reason:
// `wrangler types` emits each `vars` value as a string literal, and tests and
// self-hosted brains without billing leave them unset.
type GeneratedEnv = Omit<
  Cloudflare.Env,
  | "VECTORIZE_GRACE_MS"
  | "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "QB_PRICE_MONTHLY" | "QB_PRICE_YEARLY"
  | "RESEND_API_KEY" | "EMAIL_FROM" | "EMAIL_REPLY_TO" | "WORKER_BASE_URL"
>;

export interface Env extends GeneratedEnv {
  VECTORIZE_GRACE_MS?: string;

  // ── Quantum Brain billing (Phase D) ─────────────────────────────────────────
  // Declared here as optional strings rather than relied on from the generated
  // types: the secrets are absent in tests and on a self-hosted brain that has
  // no billing, and src/billing/* treats a missing value as "billing is off"
  // (503 on the public routes) instead of a type error at the edge.
  /** Stripe secret key (sk_live_/sk_test_). Wrangler secret. */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook endpoint signing secret (whsec_). Wrangler secret. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe Price ids for the two plans. Plain vars (wrangler.jsonc). */
  QB_PRICE_MONTHLY?: string;
  QB_PRICE_YEARLY?: string;
  /** Resend API key (re_). Wrangler secret. */
  RESEND_API_KEY?: string;
  /** Activation email sender / reply-to. Plain vars. */
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  /** Public origin of this Worker, used to build connector and redirect URLs. Plain var. */
  WORKER_BASE_URL?: string;

  // ── File storage (#8) ────────────────────────────────────────────────────
  /**
   * Not in GeneratedEnv's omit list: unlike the billing secrets above, an R2
   * bucket binding IS emitted correctly by `wrangler types` once declared in
   * wrangler.jsonc, so this only needs a manual type on brains/tests that run
   * ahead of a fresh `wrangler types` pass. Required, not optional — self-
   * hosted brains that never call the file routes never touch this binding,
   * and every test env supplies a mock (see test/helpers/make-env.ts).
   */
  FILES: R2Bucket;
}

// Worker version, echoed by GET /health. The desktop app compares this against
// the version it bundles to offer a one-click "update your Second Brain".
// Bump (semver) when the Worker changes; see installer/README "Worker versioning".
export const SB_VERSION = "3.2.0";
