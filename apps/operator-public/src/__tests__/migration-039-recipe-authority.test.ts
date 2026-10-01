/**
 * Migration 039 — Worker-computed recipe authority columns
 * (cupboard-release-pipeline-content-trust-2026-09-16 P-007, D-005).
 *
 * The two columns exist after the migration and are NULLABLE, and a row that
 * existed BEFORE it reads NULL/NULL — "not analyzed". A pre-039 recipe row must
 * never be silently stamped `0` (resolved): that would turn "the Worker never
 * looked" into "the Worker proved it safe", which is exactly the laundering
 * D-005 forbids. Consumers read NULL on a recipe row as UNKNOWN.
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

const AUTHORITY_COLUMNS = ['authority_unresolved', 'authority_unresolved_cause'];

describe('Cupboard migration 039 recipe authority', () => {
  it('adds two nullable columns and leaves every pre-existing row NOT-analyzed (NULL), never resolved', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyThrough(db, 38);
      const before = (db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of AUTHORITY_COLUMNS) expect(before).not.toContain(col);

      const insert = db.prepare(`INSERT INTO harnesses (
        id, listing_kind, listing_ref, github_repository_id, github_owner, github_name,
        github_url, title, publisher_github_user_id, publisher_github_login,
        review_status, pinned_commit_sha, pinned_tree_digest, pinned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(
        'old-recipe', 'recipe', 'r1', 1, 'acme', 'catalog', 'https://github.com/acme/catalog',
        'old-recipe', 5, 'pub', 'approved', 'a'.repeat(40), 'd'.repeat(64), 1000, 100, 101,
      );
      insert.run(
        'old-plan', 'plan', 'p1', 1, 'acme', 'catalog', 'https://github.com/acme/catalog',
        'old-plan', 5, 'pub', 'approved', 'b'.repeat(40), 'e'.repeat(64), 1000, 100, 101,
      );

      db.exec(readFileSync(join(migrationsDir, '039_recipe_authority.sql'), 'utf8'));

      const after = db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string; notnull: number }>;
      for (const col of AUTHORITY_COLUMNS) {
        const info = after.find((c) => c.name === col);
        expect(info, col).toBeDefined();
        expect(info!.notnull, `${col} nullable`).toBe(0);
      }

      const read = db.prepare('SELECT authority_unresolved, authority_unresolved_cause FROM harnesses WHERE id = ?');
      for (const id of ['old-recipe', 'old-plan']) {
        expect(read.get(id), id).toEqual({ authority_unresolved: null, authority_unresolved_cause: null });
      }
    } finally {
      db.close();
    }
  });
});
