/**
 * Cupboard server bindings + secrets + vars.
 *
 * Mirrors the papercusp-publish env shape so the deploy patterns
 * carry over. D1 + KV bindings; GitHub OAuth secrets; rate-limit vars.
 */

export interface Env {
  // Bindings
  DB: D1Database;
  COUNTERS: KVNamespace;
  /** Existing shared bucket, namespaced under artifacts/workspace-host/. */
  ARTIFACTS: R2Bucket;

  // Secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  IP_HASH_PEPPER: string;
  /** Stripe endpoint signing secret (`whsec_…`), installed via
   *  `wrangler secret put STRIPE_WEBHOOK_SECRET` (P-010). OPTIONAL on purpose:
   *  a deployment that has not configured it fails CLOSED — the commerce webhook
   *  route answers 503 rather than accepting a delivery it cannot authenticate. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe API secret key (`sk_…`), installed via
   *  `wrangler secret put STRIPE_SECRET_KEY` (P-010 / D-045 §3c). OPTIONAL for
   *  the same fail-closed reason as the webhook secret above: a deployment that
   *  has not configured it answers 503 on the checkout-session route rather than
   *  attempting an unauthenticated call to Stripe. Installing it in a deployment
   *  is an OWNER credential action, deliberately outside any agent's scope. */
  STRIPE_SECRET_KEY?: string;
  /** Repo-scoped GitHub token used ONLY to publish public Cupboard release
   *  assets to the mirror repo (P-045 / D-056), installed via
   *  `wrangler secret put GITHUB_RELEASE_MIRROR_TOKEN`. OPTIONAL for the same
   *  fail-closed reason as the Stripe secrets above: a deployment that has not
   *  configured it answers 503 on the mirror route rather than attempting an
   *  unauthenticated write. Installing it is an OWNER credential action,
   *  deliberately outside any agent's scope. Reads of mirrored bytes are
   *  tokenless, so this credential is never spent on delivery. */
  GITHUB_RELEASE_MIRROR_TOKEN?: string;
  /** `owner/repo` receiving the public release assets. A var, not a secret:
   *  the mirror repo is public by construction (its whole purpose is public
   *  availability), so its name confers nothing. */
  GITHUB_RELEASE_MIRROR_REPO?: string;
  /** Base-compatible RPC URL for the buyer-side P-032 payment-channel rail. */
  PAYMENT_CHANNEL_RPC_URL?: string;
  /** 32-byte EVM private key. The bound-wallet funding path additionally
   * requires its derived address to equal the authenticated wallet binding. */
  PAYMENT_CHANNEL_PRIVATE_KEY?: string;
  /** Idempotent channel contract implementing openChannel/closeChannel. */
  PAYMENT_CHANNEL_SETTLEMENT_CONTRACT?: string;
  /** Stablecoin contract address (pilot: Base-compatible USDC). */
  PAYMENT_CHANNEL_STABLECOIN?: string;

  // Vars
  ENVIRONMENT: string;
  CUPBOARD_HOST: string;
  /** Comma-separated GitHub user ids allowed to use /admin operator surfaces
   *  (moderation and artifact publication). Empty ⇒ no operators ⇒ every
   *  /admin endpoint 403s. GitHub user ids are public, not secret, so this is
   *  a var (not a `wrangler secret`). Auth still requires a valid GitHub bearer. */
  CUPBOARD_OPERATOR_GITHUB_IDS: string;     // default '' (no operators)
  RATE_PER_USER_PUBLISH_HOURLY: string;     // default '5'
  RATE_PER_USER_REPORT_HOURLY: string;      // default '10'
  RATE_PER_IP_LIST_PER_MINUTE: string;      // default '60'
  INDEXER_BATCH_SIZE: string;               // default '100'
  /** CAIP-compatible EVM numeric chain id for the payment-channel pilot. */
  PAYMENT_CHANNEL_CHAIN_ID?: string;
}
