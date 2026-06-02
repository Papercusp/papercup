/**
 * Cupboard D1 helpers — typed row shapes + insert/update/select primitives.
 *
 * Row types mirror the migration 001_init.sql columns 1:1. Helpers are
 * thin wrappers around prepared statements; no ORM, no abstraction layer.
 */

import type { Env } from './env.ts';

export interface HarnessRow {
  id: string;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  topic_hex: string;
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission: string | null;   // GitHub perm at publish: admin|maintain|write|triage|read|none; null = legacy/unknown
  publisher_device_pubkey: string | null;        // channel-2 device Ed25519 pubkey (base64); null = none provided
  publisher_attestation_gist_id: string | null;  // gist binding device_pubkey ↔ login; verified/revoked by the indexer
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
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  topic_hex: string;
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission?: string | null;
  publisher_device_pubkey?: string | null;
  publisher_attestation_gist_id?: string | null;
  created_at: number;
}

export async function insertHarness(db: D1Database, h: NewHarnessInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO harnesses
         (id, github_repository_id, github_owner, github_name, github_url,
          title, description, topic_hex,
          publisher_github_user_id, publisher_github_login, publisher_permission,
          publisher_device_pubkey, publisher_attestation_gist_id,
          claim_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?, ?)`,
    )
    .bind(
      h.id,
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
      h.created_at,
      h.created_at,
    )
    .run();
}

export async function getHarnessById(db: D1Database, id: string): Promise<HarnessRow | null> {
  const row = await db
    .prepare('SELECT * FROM harnesses WHERE id = ?')
    .bind(id)
    .first<HarnessRow>();
  return row ?? null;
}

export async function getHarnessByGithubRepoId(
  db: D1Database,
  github_repository_id: number,
): Promise<HarnessRow | null> {
  const row = await db
    .prepare('SELECT * FROM harnesses WHERE github_repository_id = ?')
    .bind(github_repository_id)
    .first<HarnessRow>();
  return row ?? null;
}

export interface ListOpts {
  limit?: number;
  cursor?: number | null;          // pagination by last_activity_at DESC, secondary id
  search?: string;
  claim_status?: 'unclaimed' | 'claimed';
}

export async function listHarnesses(db: D1Database, opts: ListOpts): Promise<HarnessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  // Static SQL avoids D1's prepared-statement string concat tax; we filter unlisted always.
  const where: string[] = ['unlisted_at IS NULL'];
  const binds: unknown[] = [];
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
