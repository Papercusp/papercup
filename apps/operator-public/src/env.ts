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
  /** Snapshot tarball blob store (revive-cupboard-distribution, snapshot facet).
   *  Content-addressed objects at `snapshots/<sha256>.tar.gz`; the D1 listing row
   *  is metadata-only and points here via tarball_r2_key. */
  SNAPSHOTS: R2Bucket;

  // Secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  IP_HASH_PEPPER: string;

  // Vars
  ENVIRONMENT: string;
  CUPBOARD_HOST: string;
  /** Comma-separated GitHub user ids allowed to use the /admin moderation
   *  surface (list/resolve reports, operator takedowns). Empty ⇒ no operators
   *  ⇒ every /admin endpoint 403s. GitHub user ids are public, not secret, so
   *  this is a var (not a `wrangler secret`). Auth still requires a valid
   *  GitHub bearer whose resolved id is in this set. */
  CUPBOARD_OPERATOR_GITHUB_IDS: string;     // default '' (no operators)
  RATE_PER_USER_PUBLISH_HOURLY: string;     // default '5'
  RATE_PER_USER_REPORT_HOURLY: string;      // default '10'
  RATE_PER_IP_LIST_PER_MINUTE: string;      // default '60'
  INDEXER_BATCH_SIZE: string;               // default '100'
}
