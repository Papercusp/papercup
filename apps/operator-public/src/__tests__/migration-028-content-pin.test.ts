/**
 * Migration 028 — content pin columns (cupboard-release-pipeline-content-trust
 * P-001). The three columns exist after the migration, are nullable (a code
 * kind stores null), and round-trip a self-describing pin.
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

const PIN_COLUMNS = ['pinned_commit_sha', 'pinned_tree_digest', 'pinned_at'];

describe('Cupboard migration 028 content pin', () => {
  it('adds the three nullable pin columns and round-trips both a pinned and an unpinned row', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyThrough(db, 27);
      const before = (db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const col of PIN_COLUMNS) expect(before).not.toContain(col);

      db.exec(readFileSync(join(migrationsDir, '028_content_pin.sql'), 'utf8'));

      const after = db.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string; notnull: number }>;
      for (const col of PIN_COLUMNS) {
        const info = after.find((c) => c.name === col);
        expect(info, col).toBeDefined();
        expect(info!.notnull, `${col} nullable`).toBe(0);
      }

      const insert = db.prepare(`INSERT INTO harnesses (
        id, listing_kind, listing_ref, github_repository_id, github_owner, github_name,
        github_url, title, publisher_github_user_id, publisher_github_login,
        pinned_commit_sha, pinned_tree_digest, pinned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(
        'pinned', 'plan', 'quality-plan', 7, 'acme', 'catalog', 'https://github.com/acme/catalog',
        'Quality', 5, 'pub', 'a'.repeat(40), 'b'.repeat(64), 1700000000000, 100, 101,
      );
      insert.run(
        'code', 'plugin', 'demo-plugin', 8, 'acme', 'catalog', 'https://github.com/acme/catalog',
        'Demo', 5, 'pub', null, null, null, 100, 101,
      );

      const read = db.prepare('SELECT pinned_commit_sha, pinned_tree_digest, pinned_at FROM harnesses WHERE id = ?');
      expect(read.get('pinned')).toEqual({
        pinned_commit_sha: 'a'.repeat(40),
        pinned_tree_digest: 'b'.repeat(64),
        pinned_at: 1700000000000,
      });
      expect(read.get('code')).toEqual({ pinned_commit_sha: null, pinned_tree_digest: null, pinned_at: null });
    } finally {
      db.close();
    }
  });
});
