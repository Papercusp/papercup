import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Overridable so falsifiability can be proven against a COPY outside the tree (a naive
// 029 that drops the pinned_* columns), instead of mutating the shared checkout — which
// git-sync would commit mid-probe. Defaults to the real chain; CI never sets it.
const migrationsDir =
  process.env.PROBE_MIGRATIONS_DIR ?? join(__dirname, '..', '..', 'migrations');

/**
 * An INVARIANT guard over the whole migration chain, deliberately NOT a snapshot.
 *
 * Every other migration test here applies a PINNED PREFIX — `applyThrough(db, last)`
 * filters `Number(name.slice(0, 3)) <= last`, so the 024 test stops at 024 and the 028
 * test at 028. That shape means no existing test can ever apply a migration numbered
 * ABOVE the one it was written for: a new rebuild is invisible to the entire suite by
 * construction, and a destructive one passes green.
 *
 * It bit exactly once. Migration 024 rebuilt `harnesses` and its header said "Later
 * migrations add other tables only" — true then, false from 028, which ALTER-added three
 * columns to that same table. Copy-024-and-extend is the obvious way to add a listing
 * kind and it drops `pinned_commit_sha` / `pinned_tree_digest` / `pinned_at` from the
 * live storefront (measured 2026-09-16: 67 columns -> 64).
 *
 * So this file asks the PROPERTY, not the artifact: apply the FULL chain with no pin,
 * and assert no migration ever removes a column from a table an earlier migration
 * created. It needs no edit when migration 030 lands — that is the entire point. A
 * snapshot test (one hardcoded column list) would not have caught this even if it HAD
 * applied the full chain, because it would assert the column set known at its own
 * migration.
 */

function migrationFiles(): string[] {
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();
  // The chain must be gapless and start at 001, or "apply everything" is not what ran.
  expect(files.map((name) => Number(name.slice(0, 3)))).toEqual(
    Array.from({ length: files.length }, (_, index) => index + 1),
  );
  return files;
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

function tablesOf(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('migration chain column preservation', () => {
  it('never drops a column once a migration has created it', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const seen = new Map<string, string[]>();
      const losses: string[] = [];

      for (const file of migrationFiles()) {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));

        for (const table of tablesOf(db)) {
          const now = columnsOf(db, table);
          const before = seen.get(table);
          if (before) {
            const dropped = before.filter((column) => !now.includes(column));
            if (dropped.length > 0) {
              losses.push(`${file}: ${table} lost ${dropped.join(', ')}`);
            }
          }
          seen.set(table, now);
        }
      }

      // A rebuild that drops a column names itself here, with the migration that did it.
      expect(losses).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('carries every migration-028 content-pin column through every later rebuild', () => {
    // The specific regression above, pinned as its own case so a failure reads as the
    // concrete thing that broke rather than a generic diff. Unlike the 028 test, this
    // applies the FULL chain, so it keeps covering rebuilds added after 029.
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of migrationFiles()) {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      }
      expect(columnsOf(db, 'harnesses')).toEqual(
        expect.arrayContaining(['pinned_commit_sha', 'pinned_tree_digest', 'pinned_at']),
      );
    } finally {
      db.close();
    }
  });

  it('admits the datatype listing kind after the full chain', () => {
    // Positive control for the guard above: proves the chain actually ran and that
    // migration 029 really widened the CHECK, so an all-green result cannot come from a
    // no-op. Without this, a chain that silently failed to apply 029 would satisfy the
    // preservation assertions perfectly.
    const db = new DatabaseSync(':memory:');
    try {
      for (const file of migrationFiles()) {
        db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      }
      const insert = (kind: string, id: string) =>
        db
          .prepare(
            `INSERT INTO harnesses (
               id, listing_kind, listing_ref, github_repository_id, github_owner,
               github_name, github_url, title, publisher_github_user_id,
               publisher_github_login, created_at, updated_at
             ) VALUES (?, ?, 'datatypes/incident', 1, 'acme', 'repo',
                       'https://example.invalid/repo', 'Incident', 1, 'octocat', 1, 1)`,
          )
          .run(id, kind);

      expect(() => insert('datatype', 'listing-datatype')).not.toThrow();
      expect(() => insert('not-a-kind', 'listing-bogus')).toThrow();
    } finally {
      db.close();
    }
  });
});
