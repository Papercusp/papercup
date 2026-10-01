/**
 * Migration 038 — approved-SHA columns (cupboard-release-pipeline-content-trust
 * P-008). The three columns exist after the migration, are nullable, and the
 * backfill stamps ONLY already-approved pinned rows: a pending, rejected or
 * unpinned row must not read as "an operator reviewed this commit".
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

function applyThrough(db: DatabaseSync, last: number): void {
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name) && Number(name.slice(0, 3)) <= last)
    .sort();
  expect(files.map((name) => Number(name.slice(0, 3)))).toEqual(
    Array.from({ length: last }, (_, index) => index + 1),
  );
  for (const file of files) db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
}

const APPROVED_COLUMNS = ['approved_commit_sha', 'approved_tree_digest', 'approved_at'];

type Seed = {
  id: string;
  kind: string;
  ref: string;
  repo: number;
  review: 'pending' | 'approved' | 'rejected';
  sha: string | null;
  digest: string | null;
  reviewedAt: number | null;
};

describe('Cupboard migration 038 approved commit sha', () => {
  it('adds three nullable columns and backfills approved+pinned rows only', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyThrough(db, 37);
      const before = (db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of APPROVED_COLUMNS) expect(before).not.toContain(col);

      const insert = db.prepare(`INSERT INTO harnesses (
        id, listing_kind, listing_ref, github_repository_id, github_owner, github_name,
        github_url, title, publisher_github_user_id, publisher_github_login,
        review_status, reviewed_at, pinned_commit_sha, pinned_tree_digest, pinned_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const seeds: Seed[] = [
        { id: 'approved-pinned', kind: 'plan', ref: 'p1', repo: 1, review: 'approved', sha: 'a'.repeat(40), digest: 'd'.repeat(64), reviewedAt: 5000 },
        { id: 'pending-pinned', kind: 'plan', ref: 'p2', repo: 1, review: 'pending', sha: 'b'.repeat(40), digest: 'e'.repeat(64), reviewedAt: null },
        { id: 'rejected-pinned', kind: 'plan', ref: 'p3', repo: 1, review: 'rejected', sha: 'c'.repeat(40), digest: 'f'.repeat(64), reviewedAt: 6000 },
        { id: 'approved-unpinned', kind: 'knowledge-pack', ref: 'kp', repo: 2, review: 'approved', sha: null, digest: null, reviewedAt: 7000 },
      ];
      for (const s of seeds) {
        insert.run(
          s.id, s.kind, s.ref, s.repo, 'acme', 'catalog', 'https://github.com/acme/catalog',
          s.id, 5, 'pub', s.review, s.reviewedAt, s.sha, s.digest, s.sha ? 1000 : null, 100, 101,
        );
      }

      db.exec(readFileSync(join(migrationsDir, '038_approved_commit_sha.sql'), 'utf8'));

      const after = db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string; notnull: number }>;
      for (const col of APPROVED_COLUMNS) {
        const info = after.find((c) => c.name === col);
        expect(info, col).toBeDefined();
        expect(info!.notnull, `${col} nullable`).toBe(0);
      }

      const read = db.prepare(
        'SELECT approved_commit_sha, approved_tree_digest, approved_at FROM harnesses WHERE id = ?',
      );
      // An approved, pinned row was approved at the pin it carries.
      expect(read.get('approved-pinned')).toEqual({
        approved_commit_sha: 'a'.repeat(40),
        approved_tree_digest: 'd'.repeat(64),
        approved_at: 5000,
      });
      // Not approved ⇒ nobody reviewed that commit: stays NULL.
      for (const id of ['pending-pinned', 'rejected-pinned', 'approved-unpinned']) {
        expect(read.get(id), id).toEqual({ approved_commit_sha: null, approved_tree_digest: null, approved_at: null });
      }

      // SPEC-P-008: `drift` is NOT NULL and every existing row starts at 0 —
      // a row nobody has observed drifting must never read as drifted.
      const driftInfo = after.find((c) => c.name === 'drift');
      expect(driftInfo, 'drift column').toBeDefined();
      expect(driftInfo!.notnull, 'drift NOT NULL').toBe(1);
      const drifts = db.prepare('SELECT id, drift FROM harnesses ORDER BY id').all() as Array<{ id: string; drift: number }>;
      expect(drifts.length).toBe(seeds.length);
      for (const d of drifts) expect(d.drift, d.id).toBe(0);
    } finally {
      db.close();
    }
  });
});
