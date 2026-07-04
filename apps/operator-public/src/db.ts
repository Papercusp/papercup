/**
 * Cupboard D1 helpers — typed row shapes + insert/update/select primitives.
 *
 * Row types mirror the migration 001_init.sql columns 1:1. Helpers are
 * thin wrappers around prepared statements; no ORM, no abstraction layer.
 */

import type { Env } from './env.ts';

/** The storefront listing kinds (migrations 004 + 006 + 008 / D-005). The
 *  `snapshot` kind was retired (retire-snapshots-instance-spec-2026-06-09 D-005);
 *  the D1 `tarball_*` columns (migration 005) remain vestigial/nullable.
 *  Migration 008 (learning-packs-2026-06-11 D-005): `pack` was RENAMED
 *  `tool-pack` (a runtime-less code-tool pack) and `learning-pack` (a
 *  distributable set of curated hive learnings) joined. `pack` stays accepted
 *  on the wire as a normalized alias for older clients. Migration 010
 *  (app-templates-2026-07-04 P-010 / D-006): `template` joined — a composable
 *  {components + GUIDE + checks} unit, repo-backed like a blueprint
 *  (listing_ref = the template id under the repo's templates/ dir). */
export const LISTING_KINDS = ['harness', 'blueprint', 'plugin', 'tool-pack', 'learning-pack', 'template'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export function isListingKind(v: unknown): v is ListingKind {
  return typeof v === 'string' && (LISTING_KINDS as readonly string[]).includes(v);
}

/** Wire-compat: normalize the pre-008 'pack' alias to 'tool-pack'. */
export function normalizeListingKind(v: unknown): ListingKind | null {
  if (v === 'pack') return 'tool-pack';
  return isListingKind(v) ? v : null;
}

/**
 * Pre-publication review policy (learning-packs D-007): the INSTRUCTION-
 * CARRYING kinds — content injected into agent context (learning packs),
 * run as agent roles (blueprints), or read as the building agent's
 * composition prompt (a template's GUIDE.md — app-templates P-010) — land
 * `pending` at publish and go public only on operator approval. Code kinds
 * keep install-consent + reactive moderation.
 */
export const REVIEW_POLICY_KINDS: readonly ListingKind[] = ['learning-pack', 'blueprint', 'template'];

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface HarnessRow {
  id: string;
  /** Storefront kind (migration 004). Default 'harness' for pre-004 rows. */
  listing_kind: ListingKind;
  /** For a listing_kind='blueprint' row: the blueprint.yaml `kind` — 'hive' (a hive
   *  template) | 'harness' (a harness blueprint). NULL for every other kind + pre-009
   *  rows (migration 009 / hive-blueprint-generalization P-018). Drives the Hives tab. */
  blueprint_kind: string | null;
  /** Papercupai project remote id this listing belongs to (D-008). null = legacy/standalone. */
  project_ref: string | null;
  /** Within-project discriminator (blueprint stream / snapshot id / plugin slug). null for the canonical harness listing. */
  listing_ref: string | null;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  topic_hex: string | null;              // join topic; required only for kind='harness' (migration 004 made it nullable)
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission: string | null;   // GitHub perm at publish: admin|maintain|write|triage|read|none; null = legacy/unknown
  publisher_device_pubkey: string | null;        // channel-2 device Ed25519 pubkey (base64); null = none provided
  publisher_attestation_gist_id: string | null;  // gist binding device_pubkey ↔ login; verified/revoked by the indexer
  // Pack model (migration 006): JSON-encoded string[] of the MCP tool names the
  // unit registers when installed (e.g. ["repomix.pack"]). Kinds plugin|pack
  // only; NULL elsewhere and for pre-006 listings. The operator's tool→provider
  // resolver reads it to answer "which Cupboard unit provides tool X?".
  provides_tools: string | null;
  // Repo→Hive binding (migration 007 / hive-from-github-url D-004 HYBRID):
  // the owning Hive's raw-32-byte-base64 Ed25519 pubkey (same encoding as the
  // hive directory announce) + a denormalized display title. One row per
  // member repo of a public hive, all carrying the same hive_pubkey. NULL =
  // pre-hive listing or a plain shared-harness binding.
  hive_pubkey: string | null;
  hive_title: string | null;
  claim_status: 'unclaimed' | 'claimed' | 'stale' | 'superseded';
  claimant_github_user_id: number | null;
  claimant_github_login: string | null;
  superseded_by: string | null;
  stars: number;
  contributor_count: number;
  last_activity_at: number | null;
  languages: string | null;            // JSON-encoded {language: byte_count}
  stats_refreshed_at: number | null;
  created_at: number;
  updated_at: number;
  unlisted_at: number | null;
  unlisted_reason: string | null;
  // Pre-publication review (migration 008 / learning-packs D-007). Policy
  // kinds publish 'pending'; everything else (and every pre-008 row) is
  // 'approved'. reviewed_at/review_reason carry the operator decision.
  review_status: ReviewStatus;
  reviewed_at: number | null;
  review_reason: string | null;
}

export interface ReportRow {
  id: string;
  harness_id: string;
  reporter_github_user_id: number;
  reporter_github_login: string;
  reason: string;
  ip_hash: string | null;
  status: 'pending' | 'resolved_unlist' | 'resolved_dismiss';
  resolved_at: number | null;
  resolved_by_operator_note: string | null;
  created_at: number;
}

export interface NewHarnessInput {
  id: string;
  /** Storefront kind (migration 004). Defaults to 'harness' when omitted. */
  listing_kind?: ListingKind;
  /** Papercupai project remote id (D-008). */
  project_ref?: string | null;
  /** Within-project discriminator (blueprint stream / snapshot id / plugin slug). */
  listing_ref?: string | null;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  /** Required only for kind='harness'; null for the fork/install kinds. */
  topic_hex: string | null;
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission?: string | null;
  publisher_device_pubkey?: string | null;
  publisher_attestation_gist_id?: string | null;
  /** Pack model (migration 006): JSON string[] of provided tool names; plugin|pack only. */
  provides_tools?: string | null;
  /** Repo→Hive binding (migration 007): owning Hive's raw-32-byte-base64 Ed25519 pubkey. */
  hive_pubkey?: string | null;
  /** Denormalized Hive display title (directory announce stays authoritative). */
  hive_title?: string | null;
  /** blueprint.yaml `kind` ('hive'|'harness') for a listing_kind='blueprint' publish;
   *  null otherwise (migration 009 / P-018). */
  blueprint_kind?: string | null;
  /** Pre-publication review (migration 008): policy kinds publish 'pending'. */
  review_status?: ReviewStatus;
  created_at: number;
}

export async function insertHarness(db: D1Database, h: NewHarnessInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO harnesses
         (id, listing_kind, project_ref, listing_ref,
          github_repository_id, github_owner, github_name, github_url,
          title, description, topic_hex,
          publisher_github_user_id, publisher_github_login, publisher_permission,
          publisher_device_pubkey, publisher_attestation_gist_id,
          provides_tools,
          hive_pubkey, hive_title, blueprint_kind,
          review_status,
          claim_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?, ?)`,
    )
    .bind(
      h.id,
      h.listing_kind ?? 'harness',
      h.project_ref ?? null,
      h.listing_ref ?? null,
      h.github_repository_id,
      h.github_owner,
      h.github_name,
      h.github_url,
      h.title,
      h.description,
      h.topic_hex,
      h.publisher_github_user_id,
      h.publisher_github_login,
      h.publisher_permission ?? null,
      h.publisher_device_pubkey ?? null,
      h.publisher_attestation_gist_id ?? null,
      h.provides_tools ?? null,
      h.hive_pubkey ?? null,
      h.hive_title ?? null,
      h.blueprint_kind ?? null,
      h.review_status ?? 'approved',
      h.created_at,
      h.created_at,
    )
    .run();
}

/** Operator decision on a pending listing (learning-packs P-019/P-020). */
export async function setReviewStatus(
  db: D1Database,
  id: string,
  status: Exclude<ReviewStatus, 'pending'>,
  reason: string | null,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
          SET review_status = ?, reviewed_at = ?, review_reason = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, now, reason, now, id)
    .run();
}

/** The operator's pending-review queue, oldest first. */
export async function listPendingReview(db: D1Database, limit = 100): Promise<HarnessRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM harnesses
        WHERE review_status = 'pending' AND unlisted_at IS NULL
        ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<HarnessRow>();
  return res.results ?? [];
}

export async function getHarnessById(db: D1Database, id: string): Promise<HarnessRow | null> {
  const row = await db
    .prepare('SELECT * FROM harnesses WHERE id = ?')
    .bind(id)
    .first<HarnessRow>();
  return row ?? null;
}

/**
 * Look up the shared-HARNESS listing bound to a repo. Scoped to
 * listing_kind='harness' because, post-migration-004, the same project-remote
 * repo id can host N non-harness listings (blueprints/snapshots/plugins) — but
 * the "one shared-harness per repo" 1:1 invariant (binding lookup + harness
 * publish dedup) still holds. An active (listed) row wins over an unlisted one.
 */
export async function getHarnessByGithubRepoId(
  db: D1Database,
  github_repository_id: number,
): Promise<HarnessRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM harnesses
         WHERE github_repository_id = ? AND listing_kind = 'harness'
         ORDER BY (unlisted_at IS NULL) DESC
         LIMIT 1`,
    )
    .bind(github_repository_id)
    .first<HarnessRow>();
  return row ?? null;
}

/**
 * Batch repo→listing lookup (comb-hive-native-sharing P-011): the active
 * harness-kind listings for a SET of GitHub repo ids, for the search panel's
 * "hive exists" badges (P-010). One query over the existing repo-id index,
 * mirroring getHarnessByGithubRepoId's harness-kind + active-row scoping —
 * batched. The caller validates + caps the id set.
 */
export async function getHarnessesByGithubRepoIds(
  db: D1Database,
  github_repository_ids: number[],
): Promise<HarnessRow[]> {
  if (github_repository_ids.length === 0) return [];
  const placeholders = github_repository_ids.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT * FROM harnesses
       WHERE github_repository_id IN (${placeholders})
         AND listing_kind = 'harness' AND unlisted_at IS NULL`,
  );
  // .bind is variadic — spread the ids in one call (same cast as listHarnesses).
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(
    ...github_repository_ids,
  );
  const res = await bound.all<HarnessRow>();
  return res.results ?? [];
}

export interface ListOpts {
  limit?: number;
  cursor?: number | null;          // pagination by last_activity_at DESC, secondary id
  search?: string;
  claim_status?: 'unclaimed' | 'claimed';
  /** Filter to one storefront kind (migration 004). Omit for all kinds. */
  kind?: ListingKind;
  /** Filter to one project remote (D-008 project rollup). */
  project_ref?: string;
}

export async function listHarnesses(db: D1Database, opts: ListOpts): Promise<HarnessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  // Static SQL avoids D1's prepared-statement string concat tax; we filter
  // unlisted always — and non-approved always (learning-packs D-007: pending/
  // rejected policy-kind listings are invisible to public browse; the
  // publisher reads their own via GET /:id with auth, operators via /admin).
  const where: string[] = ['unlisted_at IS NULL', `review_status = 'approved'`];
  const binds: unknown[] = [];
  if (opts.kind) {
    where.push('listing_kind = ?');
    binds.push(opts.kind);
  }
  if (opts.project_ref) {
    where.push('project_ref = ?');
    binds.push(opts.project_ref);
  }
  if (opts.cursor != null) {
    where.push('(last_activity_at IS NULL OR last_activity_at < ?)');
    binds.push(opts.cursor);
  }
  if (opts.search) {
    where.push('(title LIKE ? OR description LIKE ? OR github_owner LIKE ? OR github_name LIKE ?)');
    const q = `%${opts.search}%`;
    binds.push(q, q, q, q);
  }
  if (opts.claim_status) {
    where.push('claim_status = ?');
    binds.push(opts.claim_status);
  }
  const sql = `SELECT * FROM harnesses WHERE ${where.join(' AND ')} ORDER BY last_activity_at DESC NULLS LAST, id ASC LIMIT ?`;
  binds.push(limit);
  const stmt = db.prepare(sql);
  // .bind is variadic, spread the binds in one call
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(...binds);
  const res = await bound.all<HarnessRow>();
  return res.results ?? [];
}

/**
 * Dedup lookup for a non-harness listing: the active row matching
 * (repo, kind, listing_ref) — the uniqueness key of
 * `harnesses_active_listing_unique`. (Harness-kind dedup keeps using
 * getHarnessByGithubRepoId, which matches the 1:1 harness-repo index.)
 */
export async function getActiveListingByRefs(
  db: D1Database,
  github_repository_id: number,
  listing_kind: ListingKind,
  listing_ref: string,
): Promise<HarnessRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM harnesses
         WHERE github_repository_id = ? AND listing_kind = ? AND listing_ref = ?
           AND unlisted_at IS NULL
         LIMIT 1`,
    )
    .bind(github_repository_id, listing_kind, listing_ref)
    .first<HarnessRow>();
  return row ?? null;
}


export async function markHarnessUnlisted(
  db: D1Database,
  id: string,
  reason: string,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(`UPDATE harnesses SET unlisted_at = ?, unlisted_reason = ?, updated_at = ? WHERE id = ?`)
    .bind(now_ms, reason, now_ms, id)
    .run();
}

export async function updateHarnessStats(
  db: D1Database,
  id: string,
  stats: {
    stars: number;
    contributor_count: number;
    last_activity_at: number | null;
    languages: string | null;
  },
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
         SET stars = ?,
             contributor_count = ?,
             last_activity_at = ?,
             languages = ?,
             stats_refreshed_at = ?,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      stats.stars,
      stats.contributor_count,
      stats.last_activity_at,
      stats.languages,
      now_ms,
      now_ms,
      id,
    )
    .run();
}

/**
 * Clear a listing's channel-2 attestation (item 1). Called by the indexer
 * when the attestation gist is deleted (revocation) or no longer binds the
 * stored device pubkey to the publisher (invalid). Leaves the listing up —
 * it just loses its verified-publisher signal.
 */
export async function clearHarnessAttestation(
  db: D1Database,
  id: string,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
         SET publisher_device_pubkey = NULL,
             publisher_attestation_gist_id = NULL,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(now_ms, id)
    .run();
}

export async function setHarnessClaim(
  db: D1Database,
  id: string,
  claim: { user_id: number; login: string },
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE harnesses
         SET claim_status = 'claimed',
             claimant_github_user_id = ?,
             claimant_github_login = ?,
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(claim.user_id, claim.login, now_ms, id)
    .run();
}

export async function insertReport(db: D1Database, r: Omit<ReportRow, 'status' | 'resolved_at' | 'resolved_by_operator_note'>): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reports
         (id, harness_id, reporter_github_user_id, reporter_github_login,
          reason, ip_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(r.id, r.harness_id, r.reporter_github_user_id, r.reporter_github_login, r.reason, r.ip_hash, r.created_at)
    .run();
}

/** A report joined with a thin summary of its target harness, for the
 *  operator moderation list (avoids an N+1 fetch per report). */
export interface ReportWithHarness extends ReportRow {
  harness_title: string | null;
  harness_github_url: string | null;
  harness_unlisted_at: number | null;
}

/**
 * List reports for the operator moderation surface, newest-pending-first.
 * `status` filters to one lifecycle state; omit (or pass 'all') for every
 * report. Joined with the harness so the operator sees what's being reported
 * without a second round-trip.
 */
export async function listReports(
  db: D1Database,
  opts: { status?: ReportRow['status'] | 'all'; limit?: number } = {},
): Promise<ReportWithHarness[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filterStatus = opts.status && opts.status !== 'all';
  const sql =
    `SELECT r.*,
            h.title AS harness_title,
            h.github_url AS harness_github_url,
            h.unlisted_at AS harness_unlisted_at
       FROM reports r
       LEFT JOIN harnesses h ON h.id = r.harness_id` +
    (filterStatus ? ` WHERE r.status = ?` : ``) +
    ` ORDER BY r.created_at ASC LIMIT ?`;
  const binds: unknown[] = filterStatus ? [opts.status, limit] : [limit];
  const stmt = db.prepare(sql);
  const bound = (stmt as unknown as { bind: (...vs: unknown[]) => D1PreparedStatement }).bind(...binds);
  const res = await bound.all<ReportWithHarness>();
  return res.results ?? [];
}

export async function getReportById(db: D1Database, id: string): Promise<ReportRow | null> {
  const row = await db
    .prepare('SELECT * FROM reports WHERE id = ?')
    .bind(id)
    .first<ReportRow>();
  return row ?? null;
}

/**
 * Resolve a pending report. Idempotency guard: the WHERE pins `status =
 * 'pending'`, so resolving an already-resolved report changes 0 rows — the
 * caller treats `changes === 0` as "already handled / not found". Returns the
 * number of rows changed.
 */
export async function resolveReport(
  db: D1Database,
  id: string,
  opts: { status: 'resolved_unlist' | 'resolved_dismiss'; note: string | null; now_ms: number },
): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE reports
          SET status = ?, resolved_at = ?, resolved_by_operator_note = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .bind(opts.status, opts.now_ms, opts.note, id)
    .run();
  return (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export async function audit(
  db: D1Database,
  ts: number,
  kind: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare('INSERT INTO audit (ts, kind, detail) VALUES (?, ?, ?)')
    .bind(ts, kind, JSON.stringify(detail))
    .run();
}

// ── Channel-2 publisher ban-list (item 1) ───────────────────────

export interface BannedPubkeyRow {
  pubkey: string;
  reason: string;
  added_at: number;
  added_by_operator_user_id: number | null;
  updated_at: number;
}

/** Set of banned publisher device pubkeys, for filtering public listings. */
export async function listBannedPubkeySet(db: D1Database): Promise<Set<string>> {
  const res = await db
    .prepare('SELECT pubkey FROM banned_publisher_pubkeys')
    .all<{ pubkey: string }>();
  return new Set((res.results ?? []).map((r) => r.pubkey));
}

export async function listBannedPubkeys(db: D1Database): Promise<BannedPubkeyRow[]> {
  const res = await db
    .prepare('SELECT * FROM banned_publisher_pubkeys ORDER BY added_at DESC')
    .all<BannedPubkeyRow>();
  return res.results ?? [];
}

export async function banPublisherPubkey(
  db: D1Database,
  pubkey: string,
  reason: string,
  operatorUserId: number | null,
  now_ms: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO banned_publisher_pubkeys (pubkey, reason, added_at, added_by_operator_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = ?, updated_at = ?`,
    )
    .bind(pubkey, reason, now_ms, operatorUserId, now_ms, reason, now_ms)
    .run();
}

export async function unbanPublisherPubkey(db: D1Database, pubkey: string): Promise<void> {
  await db.prepare('DELETE FROM banned_publisher_pubkeys WHERE pubkey = ?').bind(pubkey).run();
}

export function clientIp(req: Request): string {
  // Cloudflare Workers attaches the originating IP here.
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
}

export async function ipHash(ip: string, pepper: string): Promise<string> {
  if (!ip) return '';
  const enc = new TextEncoder();
  const buf = enc.encode(`${ip}:${pepper}`);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
