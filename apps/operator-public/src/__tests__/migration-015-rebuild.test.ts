/**
 * migration-015-rebuild.test.ts — execute the real Cupboard migration chain and
 * prove migration 015's one-shot table rebuild preserves the migration-014
 * schema/data while adding rubric, plan, and recipe listings.
 *
 * P-016 explicitly requires an executable rebuild test. Source-shape checks are
 * not enough here: SQLite can accept each statement in isolation while the
 * explicit INSERT ... SELECT silently drops or shifts a column during the
 * rebuild. This test therefore runs the checked-in SQL against real SQLite.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../migrations");

function migrationFilesThrough(last: number): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort();
  const selected = files.filter((name) => Number(name.slice(0, 3)) <= last);
  expect(selected.map((name) => Number(name.slice(0, 3)))).toEqual(
    Array.from({ length: last }, (_, index) => index + 1),
  );
  return selected;
}

function applyMigrationsThrough(db: DatabaseSync, last: number): void {
  for (const file of migrationFilesThrough(last)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

function insertListing(
  db: DatabaseSync,
  input: {
    id: string;
    kind: string;
    repoId: number;
    listingRef?: string;
    requiresRubrics?: string;
    beforeMigration015?: boolean;
  },
): void {
  if (input.beforeMigration015) {
    db.prepare(
      `INSERT INTO harnesses (
         id, listing_kind, listing_ref,
         github_repository_id, github_owner, github_name, github_url,
         title, publisher_github_user_id, publisher_github_login,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.kind,
      input.listingRef ?? null,
      input.repoId,
      "acme",
      `repo-${input.repoId}`,
      `https://github.com/acme/repo-${input.repoId}`,
      input.id,
      42,
      "publisher",
      1_700_000_000,
      1_700_000_001,
    );
    return;
  }

  db.prepare(
    `INSERT INTO harnesses (
       id, listing_kind, listing_ref,
       github_repository_id, github_owner, github_name, github_url,
       title, publisher_github_user_id, publisher_github_login,
       requires_rubrics, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    input.listingRef ?? null,
    input.repoId,
    "acme",
    `repo-${input.repoId}`,
    `https://github.com/acme/repo-${input.repoId}`,
    input.id,
    42,
    "publisher",
    input.requiresRubrics ?? null,
    1_700_000_000,
    1_700_000_001,
  );
}

describe("Cupboard migration 015 rebuild", () => {
  it("preserves migration-014 rows, normalizes legacy kinds, widens the CHECK, and recreates indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 14);

      db.prepare(
        `INSERT INTO harnesses (
           id, listing_kind, listing_ref,
           github_repository_id, github_owner, github_name, github_url,
           title, publisher_github_user_id, publisher_github_login,
           review_status, delivery_type, latest_json_url, release_repo, icon_url, platforms,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "preserved-app",
        "app",
        "desktop",
        100,
        "acme",
        "desktop",
        "https://github.com/acme/desktop",
        "Desktop app",
        42,
        "publisher",
        "pending",
        "standalone",
        "https://example.test/latest.json",
        "acme/releases",
        "https://example.test/icon.png",
        '["linux-x86_64"]',
        1_700_000_000,
        1_700_000_001,
      );

      // Production can reach this migration with either legacy kind still on a
      // row. Bypass the old CHECK only to construct those historical inputs;
      // migration 015 must normalize them before inserting into its new table.
      db.exec("PRAGMA ignore_check_constraints=ON");
      insertListing(db, {
        id: "legacy-pack",
        kind: "tool-pack",
        repoId: 101,
        listingRef: "pack",
        beforeMigration015: true,
      });
      insertListing(db, {
        id: "legacy-knowledge",
        kind: "learning-pack",
        repoId: 102,
        listingRef: "knowledge",
        beforeMigration015: true,
      });
      db.exec("PRAGMA ignore_check_constraints=OFF");

      db.exec(
        readFileSync(
          join(MIGRATIONS_DIR, "015_plan_rubric_recipe_kinds.sql"),
          "utf8",
        ),
      );

      expect(
        db
          .prepare(
            `SELECT listing_kind, listing_ref, review_status, delivery_type,
                  latest_json_url, release_repo, icon_url, platforms, requires_rubrics
             FROM harnesses WHERE id = ?`,
          )
          .get("preserved-app"),
      ).toEqual({
        listing_kind: "app",
        listing_ref: "desktop",
        review_status: "pending",
        delivery_type: "standalone",
        latest_json_url: "https://example.test/latest.json",
        release_repo: "acme/releases",
        icon_url: "https://example.test/icon.png",
        platforms: '["linux-x86_64"]',
        requires_rubrics: null,
      });
      expect(
        db
          .prepare("SELECT listing_kind FROM harnesses WHERE id = ?")
          .get("legacy-pack"),
      ).toEqual({
        listing_kind: "pack",
      });
      expect(
        db
          .prepare("SELECT listing_kind FROM harnesses WHERE id = ?")
          .get("legacy-knowledge"),
      ).toEqual({
        listing_kind: "knowledge-pack",
      });

      const required = '[{"rubricRef":"plan-class-feature-ship"}]';
      insertListing(db, {
        id: "new-rubric",
        kind: "rubric",
        repoId: 103,
        listingRef: "release-readiness",
      });
      insertListing(db, {
        id: "new-plan",
        kind: "plan",
        repoId: 104,
        listingRef: "ship-release",
        requiresRubrics: required,
      });
      insertListing(db, {
        id: "new-recipe",
        kind: "recipe",
        repoId: 105,
        listingRef: "release-check",
      });
      expect(
        db
          .prepare(
            `SELECT listing_kind, listing_ref, requires_rubrics
             FROM harnesses
            WHERE id IN ('new-rubric', 'new-plan', 'new-recipe')
            ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          listing_kind: "plan",
          listing_ref: "ship-release",
          requires_rubrics: required,
        },
        {
          listing_kind: "recipe",
          listing_ref: "release-check",
          requires_rubrics: null,
        },
        {
          listing_kind: "rubric",
          listing_ref: "release-readiness",
          requires_rubrics: null,
        },
      ]);
      expect(() =>
        insertListing(db, { id: "bad-kind", kind: "workflow", repoId: 106 }),
      ).toThrow(/CHECK constraint failed/);

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'harnesses' ORDER BY name",
          )
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual([
        "harnesses_active_harness_repo_unique",
        "harnesses_active_listing_unique",
        "harnesses_hive_pubkey_idx",
        "harnesses_kind_idx",
        "harnesses_listed_idx",
        "harnesses_project_idx",
        "harnesses_publisher_idx",
        "harnesses_review_pending_idx",
        "harnesses_tarball_key_idx",
        "sqlite_autoindex_harnesses_1",
      ]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      db.close();
    }
  });
});
