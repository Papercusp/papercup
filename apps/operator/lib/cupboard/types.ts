/**
 * cupboard/types — public-facing API surface for the Phase 9
 * Cupboard registry server per papercusp-dogfood-v5 §10
 * (`papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24.md`
 * P-051a/P-051b).
 *
 * Types-only and PURE. No HTTP client, no fetch wrapper, no PG.
 * Both sides of the wire consume these:
 *   - The desktop operator client (when Phase 9 client wiring lands)
 *   - The `apps/operator-public/` server itself (when P-051a lands)
 *
 * Thirteenth module in the dogfood-arc types-only spine.
 *
 * Mirrors the §10.2 schema + §10.3 auth endpoints verbatim. When
 * the runtime Cupboard impl drops in, both client + server import
 * these types so wire compatibility is enforced at the type system
 * boundary, not at integration-test time.
 *
 * Why types-first matters here especially: Cupboard is the FIRST
 * cross-server contract in the dogfood arc. Wire-format drift
 * between desktop client and Cupboard server is impossible to
 * unit-test without spinning up both — pinning the types in the
 * shared package means any field-rename, status-string change, or
 * error-code shift is caught by `tsc` on both sides simultaneously.
 */

/**
 * Wire-version of the Cupboard listing shape. Bump if columns
 * change. Clients reject unknown versions to fail fast on
 * server-newer-than-client mismatch.
 */
export const CUPBOARD_SCHEMA_VERSION = 1 as const;
export type CupboardSchemaVersion = typeof CUPBOARD_SCHEMA_VERSION;

/**
 * Lifecycle states for a harness listing per v5 §10.2 CHECK
 * constraint. `claimed` means a verified maintainer has bound the
 * harness to an account; `unclaimed` is the default provisional
 * state; `stale` is reserved for listings whose binding has gone
 * dark; `superseded` is set when an admin replaces the listing.
 */
export const CUPBOARD_CLAIM_STATUSES = [
  'unclaimed',
  'claimed',
  'stale',
  'superseded',
] as const;
export type CupboardClaimStatus = (typeof CUPBOARD_CLAIM_STATUSES)[number];

/**
 * GitHub-side permission ladder per v5 §10.3. Claim verification
 * requires `maintain` or `admin`; supersede requires `admin`.
 */
export const CUPBOARD_GITHUB_PERMISSIONS = [
  'pull',
  'triage',
  'push',
  'maintain',
  'admin',
] as const;
export type CupboardGithubPermission = (typeof CUPBOARD_GITHUB_PERMISSIONS)[number];

/**
 * Permissions sufficient to claim a harness.
 */
export const CLAIM_REQUIRED_PERMISSIONS: ReadonlySet<CupboardGithubPermission> = new Set([
  'maintain',
  'admin',
] as const);

/**
 * Permissions sufficient to supersede a harness.
 */
export const SUPERSEDE_REQUIRED_PERMISSIONS: ReadonlySet<CupboardGithubPermission> = new Set([
  'admin',
] as const);

/**
 * The §10.2 `harnesses` row shape, narrowed to the fields the
 * client/server wire carries. (`id` + `created_at` + `updated_at`
 * are server-assigned but surface in the response.)
 */
export interface HarnessListing {
  id: number;
  slug: string;
  title: string;
  description: string;
  /** Full join URL — `papercusp://harness?topic=...&github=...&repo_id=...`. */
  harness_link: string;
  /** Stable numeric GitHub repository id. The canonical-uniqueness
   * key for `harnesses_active_repo_unique`. */
  github_repository_id: number;
  /** `<owner>/<repo>` display string, refreshed from GitHub. */
  github_repo: string;
  /** Whether the repo must be public for the listing to remain
   * visible. v5 default: TRUE. */
  github_repo_must_be_public: boolean;
  published_by_github_user_id: number;
  provisional_owner_github_user_id: number;
  claim_status: CupboardClaimStatus;
  claimed_at: number | null;
  last_permission_verified_at: number | null;
  superseded_by_harness_id: number | null;
  /** Self-reported contributor count, recomputed weekly. */
  contributor_count_estimate: number;
  /** Epoch ms of most-recent activity for the bound repo. */
  last_activity_at: number | null;
  language: string | null;
  tags: string[];
  created_at: number;
  updated_at: number;
}

/**
 * The §10.2 `harness_claims` row shape. One per (harness, claimant).
 */
export interface HarnessClaim {
  id: number;
  harness_id: number;
  claimant_github_user_id: number;
  /** GitHub permission level at verification time. */
  github_permission: CupboardGithubPermission;
  verified_at: number;
  revoked_at: number | null;
}

/**
 * The §10.2 `reports` row shape. One per abuse report.
 */
export interface CupboardReport {
  id: number;
  harness_id: number;
  reporter_github_user_id: number;
  reason: string;
  details: string | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

/**
 * The CupboardClient interface — 8-op surface per v5 §10.3. Every
 * method returns a `CupboardResult<T>` so error handling is
 * uniform.
 *
 * `lookupRepoBinding` is the most-used method — every desktop
 * "create shared harness" flow calls it BEFORE creating the
 * local Hyperbee to enforce per-repo uniqueness.
 */
export interface CupboardClient {
  /** GET /repo-bindings/github/:repository_id */
  lookupRepoBinding(github_repository_id: number): Promise<CupboardResult<HarnessListing | null>>;

  /** POST /repo-bindings/github */
  createRepoBinding(input: CreateRepoBindingInput): Promise<CupboardResult<HarnessListing>>;

  /** POST /harnesses/:id/claim */
  claim(input: ClaimInput): Promise<CupboardResult<HarnessClaim>>;

  /** POST /harnesses/:id/supersede */
  supersede(input: SupersedeInput): Promise<CupboardResult<HarnessListing>>;

  /** POST /harnesses */
  publish(input: PublishListingInput): Promise<CupboardResult<HarnessListing>>;

  /** GET /harnesses?... */
  listListings(filters?: ListListingsFilter): Promise<CupboardResult<HarnessListing[]>>;

  /** POST /reports */
  report(input: ReportInput): Promise<CupboardResult<CupboardReport>>;

  /** DELETE /harnesses/:id */
  unlist(input: UnlistInput): Promise<CupboardResult<void>>;
}

// ---------- input/output types ----------

export interface CreateRepoBindingInput {
  github_repository_id: number;
  github_repo: string;
  slug: string;
  title: string;
  description: string;
  harness_link: string;
  /** OAuth token from `gh auth token` — server re-verifies repo
   * access before accepting the binding. */
  oauth_token: string;
}

export interface ClaimInput {
  harness_id: number;
  oauth_token: string;
}

export interface SupersedeInput {
  /** The harness id being superseded. */
  harness_id: number;
  /** The new harness's id (already created via createRepoBinding). */
  replacement_harness_id: number;
  oauth_token: string;
}

export interface PublishListingInput {
  harness_id: number;
  /** Tags for discovery. */
  tags?: string[];
  oauth_token: string;
}

export interface ListListingsFilter {
  /** Substring match against title + description. */
  q?: string;
  /** Filter to a language (e.g. `'TypeScript'`). */
  language?: string;
  /** Filter to a tag. */
  tag?: string;
  /** Pagination cursor returned from a prior call. */
  cursor?: string;
  /** Max results. Server caps at 100. */
  limit?: number;
}

export interface ReportInput {
  harness_id: number;
  reason: string;
  details?: string;
  oauth_token: string;
}

export interface UnlistInput {
  harness_id: number;
  oauth_token: string;
}

// ---------- result + error envelopes ----------

export type CupboardResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: CupboardError };

export interface CupboardError {
  kind: CupboardErrorKind;
  /** Human-readable message — surfaces in UI toasts + audit logs. */
  message: string;
  /** HTTP status when available. */
  status?: number;
  /** Per-field validation issues when `kind: 'validation'`. */
  field_errors?: Array<{ field: string; message: string }>;
  /** Rate-limit retry-after window, populated for
   * `kind: 'rate_limited'`. */
  retry_after_ms?: number;
}

export const CUPBOARD_ERROR_KINDS = [
  'not_found',
  'unauthorized',
  'forbidden_insufficient_permission',
  'rate_limited',
  'conflict_repo_already_bound',
  'conflict_already_claimed',
  'validation',
  'private_repo_not_publishable',
  'server_error',
  'network_error',
  'unsupported_version',
] as const;
export type CupboardErrorKind = (typeof CUPBOARD_ERROR_KINDS)[number];

// ---------- convenience constructors ----------

export function ok<T>(data: T): CupboardResult<T> {
  return { ok: true, data };
}

export function err(error: CupboardError): CupboardResult<never> {
  return { ok: false, error };
}

// ---------- rate-limit constants (§10.3) ----------

/**
 * Per-user publish rate-limit per v5 §10.3 — "5 publishes per
 * github_user_id per hour."
 */
export const PUBLISH_RATE_LIMIT_PER_HOUR = 5;
export const PUBLISH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Server-side list-endpoint default + cap. The server caps at this
 * value regardless of what the client requests.
 */
export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;

// ---------- predicates ----------

/**
 * Is the listing currently visible to public-facing browsers?
 * Superseded + stale listings are hidden by default.
 */
export function isPubliclyVisible(listing: HarnessListing): boolean {
  return listing.claim_status !== 'superseded' && listing.claim_status !== 'stale';
}

/**
 * Predicate: does the caller's GitHub permission allow claiming
 * this listing?
 */
export function canClaim(permission: CupboardGithubPermission): boolean {
  return CLAIM_REQUIRED_PERMISSIONS.has(permission);
}

/**
 * Predicate: does the caller's GitHub permission allow superseding
 * this listing?
 */
export function canSupersede(permission: CupboardGithubPermission): boolean {
  return SUPERSEDE_REQUIRED_PERMISSIONS.has(permission);
}

/**
 * Predicate: is the listing eligible to be republished (Cupboard
 * UI shows the "Re-publish" CTA only if true)? Currently: true
 * iff `unclaimed` or `claimed` — superseded/stale require admin
 * action via `supersede` before re-publishing.
 */
export function canRepublish(listing: HarnessListing): boolean {
  return listing.claim_status === 'unclaimed' || listing.claim_status === 'claimed';
}

/**
 * Structural predicate. Verifies that a JSON-parsed response from
 * the Cupboard server is shaped like a `HarnessListing`. Used by
 * the client's response-parsing path defensively against
 * server-side schema drift.
 */
export function isHarnessListing(input: unknown): input is HarnessListing {
  if (input === null || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isInteger(r.id)) return false;
  if (typeof r.slug !== 'string' || r.slug.length === 0) return false;
  if (typeof r.title !== 'string') return false;
  if (typeof r.description !== 'string') return false;
  if (typeof r.harness_link !== 'string' || r.harness_link.length === 0) return false;
  if (
    typeof r.github_repository_id !== 'number' ||
    !Number.isInteger(r.github_repository_id) ||
    r.github_repository_id <= 0
  ) {
    return false;
  }
  if (typeof r.github_repo !== 'string' || r.github_repo.length === 0) return false;
  if (typeof r.github_repo_must_be_public !== 'boolean') return false;
  if (
    typeof r.published_by_github_user_id !== 'number' ||
    typeof r.provisional_owner_github_user_id !== 'number'
  ) {
    return false;
  }
  if (
    typeof r.claim_status !== 'string' ||
    !(CUPBOARD_CLAIM_STATUSES as readonly string[]).includes(r.claim_status)
  ) {
    return false;
  }
  if (r.claimed_at !== null && typeof r.claimed_at !== 'number') return false;
  if (r.last_permission_verified_at !== null && typeof r.last_permission_verified_at !== 'number') {
    return false;
  }
  if (
    r.superseded_by_harness_id !== null &&
    typeof r.superseded_by_harness_id !== 'number'
  ) {
    return false;
  }
  if (typeof r.contributor_count_estimate !== 'number' || r.contributor_count_estimate < 0) {
    return false;
  }
  if (r.last_activity_at !== null && typeof r.last_activity_at !== 'number') return false;
  if (r.language !== null && typeof r.language !== 'string') return false;
  if (!Array.isArray(r.tags)) return false;
  if (typeof r.created_at !== 'number' || typeof r.updated_at !== 'number') return false;
  return true;
}
