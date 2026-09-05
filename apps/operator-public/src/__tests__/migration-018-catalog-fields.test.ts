/**
 * migration-018-catalog-fields.test.ts — execute the real Cupboard migration
 * chain and prove migration 018's additive catalog columns behave against real
 * SQLite, not just against a source-shape reading of the checked-in SQL.
 *
 * Four properties are only observable by RUNNING the SQL (P-008; D-024, D-025,
 * D-027..D-029):
 *
 *  1. BACKFILL — a row written before 018 must come out `visibility='public'`,
 *     because the migration is applied to a live D1 database while the worker
 *     is serving and every pre-018 listing is already in the public catalog. A
 *     `NOT NULL DEFAULT` on ADD COLUMN is what delivers that, and only an
 *     applied migration shows it.
 *
 *  2. VISIBILITY CHECK — SQLite permits a column-level CHECK on ADD COLUMN only
 *     when the column carries a default. Whether the constraint actually took
 *     is an execution fact.
 *
 *  3. RELEASE IMMUTABILITY — the release-identity UNIQUE index COALESCEs
 *     `listing_ref` to ''. SQLite treats NULLs as DISTINCT in a UNIQUE index,
 *     so the bare column list ACCEPTS a duplicate release_version on the
 *     canonical `listing_ref IS NULL` row — silently defeating the immutability
 *     the index exists to enforce. A source reading cannot distinguish the two
 *     index definitions; this test can.
 *
 *  4. JSON FILTERS — the compatibility/permission axes are queried with
 *     json_each/json_extract over TEXT columns. The predicates in src/db.ts are
 *     only correct if those SQLite JSON functions select the rows we expect.
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

/** Insert a listing using only columns that exist before migration 018. */
function insertPre018(
  db: DatabaseSync,
  input: { id: string; kind: string; repoId: number; listingRef?: string },
): void {
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
}

/** Insert a listing carrying the migration-018 catalog columns. */
function insertCatalogListing(
  db: DatabaseSync,
  input: {
    id: string;
    kind: string;
    repoId: number;
    listingRef?: string | null;
    visibility?: string;
    tenantId?: string | null;
    skuRef?: string | null;
    pricingModel?: string | null;
    priceAmountMicros?: number | null;
    priceCurrency?: string | null;
    compatibilityJson?: string | null;
    requiredPermissions?: string | null;
    releaseVersion?: string | null;
    releaseContentHash?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO harnesses (
       id, listing_kind, listing_ref,
       github_repository_id, github_owner, github_name, github_url,
       title, publisher_github_user_id, publisher_github_login,
       created_at, updated_at,
       visibility, tenant_id,
       sku_ref, pricing_model, price_amount_micros, price_currency,
       compatibility_json, required_permissions,
       release_version, release_content_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.visibility ?? "public",
    input.tenantId ?? null,
    input.skuRef ?? null,
    input.pricingModel ?? null,
    input.priceAmountMicros ?? null,
    input.priceCurrency ?? null,
    input.compatibilityJson ?? null,
    input.requiredPermissions ?? null,
    input.releaseVersion ?? null,
    input.releaseContentHash ?? null,
  );
}

function ids(rows: unknown[]): string[] {
  return rows.map((row) => (row as { id: string }).id);
}

describe("Cupboard migration 018 catalog fields", () => {
  it("backfills every pre-018 row as public with no tenant, and adds all six axes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 17);
      insertPre018(db, { id: "legacy-listing", kind: "harness", repoId: 200 });
      insertPre018(db, {
        id: "legacy-app",
        kind: "app",
        repoId: 201,
        listingRef: "desktop",
      });

      db.exec(
        readFileSync(
          join(MIGRATIONS_DIR, "018_catalog_visibility_sku_release.sql"),
          "utf8",
        ),
      );

      // 1. BACKFILL — pre-018 rows stay in the public catalog.
      expect(
        db
          .prepare(
            "SELECT id, visibility, tenant_id FROM harnesses ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "legacy-app", visibility: "public", tenant_id: null },
        { id: "legacy-listing", visibility: "public", tenant_id: null },
      ]);

      // Every column the six axes need is present and nullable-by-default.
      const columns = db
        .prepare("PRAGMA table_info(harnesses)")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const column of [
        "visibility",
        "tenant_id",
        "sku_ref",
        "pricing_model",
        "price_amount_micros",
        "price_currency",
        "compatibility_json",
        "required_permissions",
        "release_version",
        "release_content_hash",
        "release_manifest_digest",
        "release_signature",
        "release_published_at",
        "yanked_at",
        "yanked_reason",
        "revoked_at",
        "revoked_reason",
      ]) {
        expect(columns).toContain(column);
      }

      // The five migration-018 indexes exist alongside the pre-018 set.
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'harnesses' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      for (const index of [
        "harnesses_visibility_idx",
        "harnesses_tenant_idx",
        "harnesses_sku_idx",
        "harnesses_release_hash_idx",
        "harnesses_release_identity_unique",
      ]) {
        expect(indexes).toContain(index);
      }
    } finally {
      db.close();
    }
  });

  it("enforces the visibility and pricing_model CHECK constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 18);

      for (const visibility of ["public", "unlisted", "private"]) {
        insertCatalogListing(db, {
          id: `vis-${visibility}`,
          kind: "harness",
          repoId: 300 + visibility.length,
          listingRef: visibility,
          visibility,
        });
      }
      expect(
        ids(
          db
            .prepare(
              "SELECT id FROM harnesses WHERE visibility IN ('public','unlisted','private') ORDER BY id",
            )
            .all(),
        ),
      ).toEqual(["vis-private", "vis-public", "vis-unlisted"]);

      expect(() =>
        insertCatalogListing(db, {
          id: "vis-bogus",
          kind: "harness",
          repoId: 310,
          visibility: "secret",
        }),
      ).toThrow(/CHECK constraint failed/);

      for (const pricingModel of [
        "free",
        "one-time",
        "subscription",
        "per-use",
      ]) {
        insertCatalogListing(db, {
          id: `price-${pricingModel}`,
          kind: "harness",
          repoId: 320 + pricingModel.length,
          listingRef: pricingModel,
          pricingModel,
          priceAmountMicros: 1_500_000,
          priceCurrency: "USDC",
        });
      }
      expect(() =>
        insertCatalogListing(db, {
          id: "price-bogus",
          kind: "harness",
          repoId: 330,
          pricingModel: "donation",
        }),
      ).toThrow(/CHECK constraint failed/);

      // pricing_model stays optional — a free listing may leave it NULL.
      insertCatalogListing(db, {
        id: "price-null",
        kind: "harness",
        repoId: 331,
        listingRef: "unpriced",
      });
      expect(
        db
          .prepare("SELECT pricing_model FROM harnesses WHERE id = ?")
          .get("price-null"),
      ).toEqual({ pricing_model: null });
    } finally {
      db.close();
    }
  });

  it("pins release identity even on the canonical NULL listing_ref row", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 18);

      // Every case below uses a NON-'harness' kind with a NULL listing_ref so
      // that the PRE-018 indexes cannot be what rejects the duplicate:
      // harnesses_active_harness_repo_unique is scoped to listing_kind =
      // 'harness', and harnesses_active_listing_unique's bare (repo, kind,
      // listing_ref) column list treats the two NULL refs as DISTINCT. That
      // leaves harnesses_release_identity_unique as the sole possible enforcer,
      // which is why each rejection asserts the index BY NAME — a bare
      // /UNIQUE constraint failed/ would pass just as happily on a collision
      // from an unrelated index, and the test would then prove nothing.
      insertCatalogListing(db, {
        id: "release-null-ref-1",
        kind: "pack",
        repoId: 400,
        listingRef: null,
        releaseVersion: "1.0.0",
        releaseContentHash: `sha256:${"a".repeat(64)}`,
      });
      expect(() =>
        insertCatalogListing(db, {
          id: "release-null-ref-2",
          kind: "pack",
          repoId: 400,
          listingRef: null,
          releaseVersion: "1.0.0",
          releaseContentHash: `sha256:${"b".repeat(64)}`,
        }),
      ).toThrow(/harnesses_release_identity_unique/);

      // A different version on the same repo+kind is a new release, not a
      // collision — immutability pins one row per version, not per repo.
      insertCatalogListing(db, {
        id: "release-null-ref-3",
        kind: "pack",
        repoId: 400,
        listingRef: null,
        releaseVersion: "1.0.1",
        releaseContentHash: `sha256:${"c".repeat(64)}`,
      });

      // Distinct listing_refs under one repo+kind occupy separate version
      // spaces — COALESCE('') must not collapse them onto each other, and must
      // not collapse either onto the NULL-ref row above.
      insertCatalogListing(db, {
        id: "release-ref-tools",
        kind: "pack",
        repoId: 400,
        listingRef: "tools",
        releaseVersion: "1.0.0",
      });
      insertCatalogListing(db, {
        id: "release-ref-recipes",
        kind: "pack",
        repoId: 400,
        listingRef: "recipes",
        releaseVersion: "1.0.0",
      });

      // The index is deliberately NOT scoped to unlisted_at IS NULL: an
      // unlisted or yanked release still owns its version forever. Unlisting
      // the row also takes it OUT of harnesses_active_listing_unique, so this
      // rejection can only come from the release-identity index.
      db.prepare(
        "UPDATE harnesses SET unlisted_at = ?, yanked_at = ? WHERE id = ?",
      ).run(1_700_000_400, 1_700_000_500, "release-ref-tools");
      expect(() =>
        insertCatalogListing(db, {
          id: "release-ref-tools-again",
          kind: "pack",
          repoId: 400,
          listingRef: "tools",
          releaseVersion: "1.0.0",
        }),
      ).toThrow(/harnesses_release_identity_unique/);

      // Rows with no release_version at all are outside the partial index —
      // two unreleased drafts on one repo+kind+NULL-ref coexist freely.
      insertCatalogListing(db, {
        id: "unreleased-1",
        kind: "pack",
        repoId: 402,
        listingRef: null,
      });
      insertCatalogListing(db, {
        id: "unreleased-2",
        kind: "pack",
        repoId: 402,
        listingRef: null,
      });
      expect(
        ids(
          db
            .prepare(
              "SELECT id FROM harnesses WHERE release_version IS NULL ORDER BY id",
            )
            .all(),
        ),
      ).toEqual(["unreleased-1", "unreleased-2"]);
    } finally {
      db.close();
    }
  });

  it("CONTROL: the bare column list this index deliberately avoids does NOT enforce immutability", () => {
    // A guard that has never failed is a guard you have not tested, and the
    // test above would pass just as happily against an index that enforces
    // nothing on the canonical NULL-ref row. This control keeps the
    // deliberately-wrong index definition — the bare column list, without
    // COALESCE(listing_ref, '') — permanently in the test file and asserts it
    // ACCEPTS the duplicate the real index rejects. If SQLite ever changed its
    // NULLs-are-DISTINCT behaviour, or someone "simplified" the COALESCE away,
    // this control fails and says exactly why the COALESCE is load-bearing.
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 18);
      db.exec("DROP INDEX harnesses_release_identity_unique");
      db.exec(
        `CREATE UNIQUE INDEX harnesses_release_identity_unique
           ON harnesses (github_repository_id, listing_kind, listing_ref, release_version)
         WHERE release_version IS NOT NULL`,
      );

      insertCatalogListing(db, {
        id: "control-1",
        kind: "pack",
        repoId: 450,
        listingRef: null,
        releaseVersion: "1.0.0",
      });
      // Republishing the SAME version on the SAME repo+kind — the exact write
      // immutability exists to reject — succeeds under the bare column list.
      insertCatalogListing(db, {
        id: "control-2",
        kind: "pack",
        repoId: 450,
        listingRef: null,
        releaseVersion: "1.0.0",
      });
      expect(
        ids(
          db
            .prepare(
              "SELECT id FROM harnesses WHERE release_version = '1.0.0' ORDER BY id",
            )
            .all(),
        ),
      ).toEqual(["control-1", "control-2"]);

      // Calibration: the same bare index DOES still reject a duplicate when
      // listing_ref is non-NULL, so the control above isolates the NULL
      // handling rather than a wholly inert index.
      insertCatalogListing(db, {
        id: "control-3",
        kind: "pack",
        repoId: 450,
        listingRef: "tools",
        releaseVersion: "1.0.0",
      });
      expect(() =>
        insertCatalogListing(db, {
          id: "control-4",
          kind: "pack",
          repoId: 450,
          listingRef: "tools",
          releaseVersion: "1.0.0",
        }),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it("selects the right rows through the json_each and json_extract catalog filters", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 18);

      insertCatalogListing(db, {
        id: "mac-node",
        kind: "app",
        repoId: 500,
        listingRef: "mac",
        compatibilityJson: JSON.stringify({
          runtime: "node>=22",
          platforms: ["darwin-aarch64", "darwin-x86_64"],
          architectures: ["arm64", "x86_64"],
        }),
        requiredPermissions: JSON.stringify(["fs:read", "net:fetch"]),
      });
      insertCatalogListing(db, {
        id: "linux-node",
        kind: "app",
        repoId: 501,
        listingRef: "linux",
        compatibilityJson: JSON.stringify({
          runtime: "node>=22",
          platforms: ["linux-x86_64"],
          architectures: ["x86_64"],
        }),
        requiredPermissions: JSON.stringify(["fs:read"]),
      });
      insertCatalogListing(db, {
        id: "linux-bun",
        kind: "app",
        repoId: 502,
        listingRef: "linux-bun",
        compatibilityJson: JSON.stringify({
          runtime: "bun>=1.2",
          platforms: ["linux-x86_64"],
          architectures: ["x86_64"],
        }),
        requiredPermissions: JSON.stringify(["net:fetch", "shell:exec"]),
      });
      // No compatibility/permission metadata at all — must never match a
      // narrowing filter, and must not error the query either.
      insertCatalogListing(db, {
        id: "bare",
        kind: "app",
        repoId: 503,
        listingRef: "bare",
      });

      // Platform filter — json_each over compatibility_json.platforms.
      const byPlatform = (platform: string): string[] =>
        ids(
          db
            .prepare(
              `SELECT id FROM harnesses
                WHERE compatibility_json IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM json_each(harnesses.compatibility_json, '$.platforms')
                     WHERE json_each.value = ?
                  )
                ORDER BY id`,
            )
            .all(platform),
        );
      expect(byPlatform("linux-x86_64")).toEqual(["linux-bun", "linux-node"]);
      expect(byPlatform("darwin-aarch64")).toEqual(["mac-node"]);
      expect(byPlatform("windows-x86_64")).toEqual([]);

      // Runtime filter — json_extract of a scalar field.
      const byRuntime = (runtime: string): string[] =>
        ids(
          db
            .prepare(
              `SELECT id FROM harnesses
                WHERE compatibility_json IS NOT NULL
                  AND json_extract(compatibility_json, '$.runtime') = ?
                ORDER BY id`,
            )
            .all(runtime),
        );
      expect(byRuntime("node>=22")).toEqual(["linux-node", "mac-node"]);
      expect(byRuntime("bun>=1.2")).toEqual(["linux-bun"]);
      expect(byRuntime("deno>=2")).toEqual([]);

      // Permission filter — json_each over the required_permissions string[].
      const byPermission = (permission: string): string[] =>
        ids(
          db
            .prepare(
              `SELECT id FROM harnesses
                WHERE required_permissions IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM json_each(harnesses.required_permissions)
                     WHERE json_each.value = ?
                  )
                ORDER BY id`,
            )
            .all(permission),
        );
      expect(byPermission("fs:read")).toEqual(["linux-node", "mac-node"]);
      expect(byPermission("shell:exec")).toEqual(["linux-bun"]);
      expect(byPermission("net:fetch")).toEqual(["linux-bun", "mac-node"]);
      expect(byPermission("gpu:use")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("scopes tenant and SKU lookups without widening the public catalog", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrationsThrough(db, 18);

      insertCatalogListing(db, {
        id: "global-public",
        kind: "harness",
        repoId: 600,
        listingRef: "global",
        visibility: "public",
      });
      insertCatalogListing(db, {
        id: "pot-a-private",
        kind: "harness",
        repoId: 601,
        listingRef: "a-private",
        visibility: "private",
        tenantId: "pot-a",
      });
      insertCatalogListing(db, {
        id: "pot-a-public",
        kind: "harness",
        repoId: 602,
        listingRef: "a-public",
        visibility: "public",
        tenantId: "pot-a",
        skuRef: "sku_a_public",
        pricingModel: "one-time",
        priceAmountMicros: 9_990_000,
        priceCurrency: "USD",
      });
      insertCatalogListing(db, {
        id: "pot-b-private",
        kind: "harness",
        repoId: 603,
        listingRef: "b-private",
        visibility: "private",
        tenantId: "pot-b",
      });
      insertCatalogListing(db, {
        id: "unlisted-row",
        kind: "harness",
        repoId: 604,
        listingRef: "unlisted",
        visibility: "unlisted",
      });

      // The unauthenticated public read is fail-closed: public only, and never
      // another pot's private catalog.
      expect(
        ids(
          db
            .prepare(
              "SELECT id FROM harnesses WHERE visibility = 'public' ORDER BY id",
            )
            .all(),
        ),
      ).toEqual(["global-public", "pot-a-public"]);

      // A tenant scope is the ONLY widening read, and it widens to exactly one
      // pot — pot-b's private row stays invisible.
      expect(
        ids(
          db
            .prepare(
              `SELECT id FROM harnesses
                WHERE visibility = 'public' OR tenant_id = ?
                ORDER BY id`,
            )
            .all("pot-a"),
        ),
      ).toEqual(["global-public", "pot-a-private", "pot-a-public"]);

      // The narrowing ?tenant= filter never reaches beyond the named pot.
      expect(
        ids(
          db
            .prepare("SELECT id FROM harnesses WHERE tenant_id = ? ORDER BY id")
            .all("pot-b"),
        ),
      ).toEqual(["pot-b-private"]);

      // Settlement lookup resolves a listing from an opaque, provider-neutral
      // SKU — and money is stored as exact integer minor units.
      expect(
        db
          .prepare(
            `SELECT id, pricing_model, price_amount_micros, price_currency
               FROM harnesses WHERE sku_ref = ?`,
          )
          .get("sku_a_public"),
      ).toEqual({
        id: "pot-a-public",
        pricing_model: "one-time",
        price_amount_micros: 9_990_000,
        price_currency: "USD",
      });
    } finally {
      db.close();
    }
  });
});
