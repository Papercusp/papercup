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

describe('Cupboard migration 024 theme kind rebuild', () => {
  it('preserves the post-018 release columns and admits only the widened theme kind', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyThrough(db, 23);
      db.prepare(`INSERT INTO harnesses (
        id, listing_kind, listing_ref, github_repository_id, github_owner, github_name,
        github_url, title, publisher_github_user_id, publisher_github_login,
        visibility, tenant_id, pricing_model, price_amount_micros, price_currency,
        compatibility_json, required_permissions, release_version, release_content_hash,
        release_manifest_digest, release_signature, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          'preserved', 'goal', 'daily', 24, 'acme', 'catalog',
          'https://github.com/acme/catalog', 'Daily', 7, 'alice',
          'private', 'tenant-a', 'one-time', 2500000, 'USD',
          '{"runtime":"node>=22"}', '["harness:write"]', '1.2.3',
          `sha256:${'a'.repeat(64)}`, 'digest', 'signature', 100, 101,
        );

      db.exec(readFileSync(join(migrationsDir, '024_theme_kind.sql'), 'utf8'));

      expect(db.prepare(`SELECT listing_kind, visibility, tenant_id, pricing_model,
        price_amount_micros, release_version, release_content_hash FROM harnesses WHERE id = ?`)
        .get('preserved')).toEqual({
          listing_kind: 'goal', visibility: 'private', tenant_id: 'tenant-a',
          pricing_model: 'one-time', price_amount_micros: 2500000,
          release_version: '1.2.3', release_content_hash: `sha256:${'a'.repeat(64)}`,
        });

      const insert = db.prepare(`INSERT INTO harnesses (
        id, listing_kind, listing_ref, github_repository_id, github_owner, github_name,
        github_url, title, publisher_github_user_id, publisher_github_login, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      expect(() => insert.run('theme', 'theme', 'aurora', 25, 'acme', 'themes',
        'https://github.com/acme/themes', 'Aurora', 7, 'alice', 102, 102)).not.toThrow();
      expect(() => insert.run('bad', 'stylesheet', 'x', 26, 'acme', 'bad',
        'https://github.com/acme/bad', 'Bad', 7, 'alice', 103, 103)).toThrow(/CHECK constraint failed/);

      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='harnesses'")
        .all().map((row) => (row as { name: string }).name);
      for (const name of ['harnesses_active_listing_unique', 'harnesses_visibility_idx',
        'harnesses_tenant_idx', 'harnesses_release_identity_unique']) {
        expect(indexes).toContain(name);
      }
    } finally {
      db.close();
    }
  });
});
