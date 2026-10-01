/**
 * Migration 041 — `verified_by` browse-badge column
 * (cupboard-release-pipeline-content-trust-2026-09-16 P-010, SPEC-P-010 / SPEC-P-010b, R-6).
 *
 * The truthful backfill is 'worker': every listing that existed BEFORE the migration was
 * pinned and scanned by the Worker alone, so none may read as attested. The CHECK keeps a
 * typo from minting a third trust tier, and NOT NULL keeps "unknown" from reading as either.
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

const INSERT_SQL = `INSERT INTO harnesses (
  id, listing_kind, listing_ref, github_repository_id, github_owner, github_name,
  github_url, title, publisher_github_user_id, publisher_github_login,
  review_status, pinned_commit_sha, pinned_tree_digest, pinned_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function seed(db: DatabaseSync, id: string, kind: string): void {
  db.prepare(INSERT_SQL).run(
    id, kind, `${id}-ref`, 1, 'acme', 'catalog', 'https://github.com/acme/catalog',
    id, 5, 'pub', 'approved', 'a'.repeat(40), 'd'.repeat(64), 1000, 100, 101,
  );
}

describe('Cupboard migration 041 verified_by', () => {
  it('backfills every pre-existing row as worker-verified, never attested', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyThrough(db, 40);
      const before = (db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(before).not.toContain('verified_by');
      seed(db, 'old-recipe', 'recipe');
      seed(db, 'old-plan', 'plan');

      db.exec(readFileSync(join(migrationsDir, '041_verified_by.sql'), 'utf8'));

      const info = (db.prepare('PRAGMA table_info(harnesses)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((c) => c.name === 'verified_by');
      expect(info, 'verified_by column').toBeDefined();
      expect(info!.notnull, 'NOT NULL').toBe(1);
      expect(info!.dflt_value).toBe("'worker'");

      const read = db.prepare('SELECT verified_by FROM harnesses WHERE id = ?');
      for (const id of ['old-recipe', 'old-plan']) {
        expect(read.get(id), id).toEqual({ verified_by: 'worker' });
      }
    } finally {
      db.close();
    }
  });

  it('accepts exactly the two trust tiers and refuses a third or a NULL', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyThrough(db, 41);
      seed(db, 'row', 'recipe');
      const set = (value: string | null) =>
        db.prepare('UPDATE harnesses SET verified_by = ? WHERE id = ?').run(value, 'row');

      expect(() => set('attestation')).not.toThrow();
      expect(() => set('worker')).not.toThrow();
      expect(() => set('self-declared')).toThrow(/CHECK constraint failed/);
      expect(() => set('Attestation')).toThrow(/CHECK constraint failed/);
      expect(() => set(null)).toThrow(/NOT NULL constraint failed/);
      expect(db.prepare('SELECT verified_by FROM harnesses WHERE id = ?').get('row')).toEqual({
        verified_by: 'worker',
      });
    } finally {
      db.close();
    }
  });
});
