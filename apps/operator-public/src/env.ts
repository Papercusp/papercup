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
}
