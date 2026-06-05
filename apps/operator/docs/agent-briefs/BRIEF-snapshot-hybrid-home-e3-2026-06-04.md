# BRIEF — Snapshot hybrid FS+PG home + work_items capture (E3 / P-006)

**Plan:** `harness-blueprint-distribution-2026-06-03` (read first: `plans:get { slug, harness:'all' }`).
Items **P-005** (mostly DONE — see Status), **P-006**. Decisions **D-004, D-010, D-011, D-012**.
**Coordinate with:** **su-9e6b8** (carving `packages/operator-core` out of `apps/operator/**` — `create.ts` + `snapshot-discovery.ts` are in their churn zone; hold those edits until they signal stable / confirm moved paths), **su-b989e** (migration-number allocator — get your migration `#` from them), **su-adb1b** (owns `work_items`).

## Status (what su-4b6ce already did — don't redo)
**P-005 is DONE + TESTED** in `libs/papercusp-export-state/` (123 unit tests green):
- 12 identity/membership/trust/**credential** tables (`contributors`, `contributor_usage_events`, `identity_files`, `mobile_devices`, `mobile_pair_tokens`, `oauth_nonces`, `operator_credentials`, `operator_publish_credentials`, `operator_search_provider_credentials`, `operator_trust_store`, `operator_voice_credentials`, `trusted_authors`) are now **explicit `exclude` entries** in `shared-table-filters.ts` (`IDENTITY_TRUST_TABLES`) with a D-011 reason + a regression test (D-011 satisfied: never portable).
- **work_items design-for-on-landing:** a documented TODO in `shared-table-filters.ts` + a **`to_regclass` existence guard** added to `pg-dump.ts copyFilteredSharedTables` so an absent include table (work_items pre-landing) is skipped, not fatal.

This brief = **P-006 (hybrid FS+PG home)** + **wiring work_items capture when it lands**.

## Verified background (don't re-derive — the plan's audit is WRONG in two places)
- export-state snapshots = **FS-only tarballs** at `<project>/.harness/snapshots/snap_*.tar.gz`. Discovery = **FS-walk** (`apps/operator/lib/snapshot-discovery.ts`, mtime+TTL cached). Create = `apps/operator/lib/endpoint-route/routes/snapshots/create.ts` → `capture()` (libs/papercusp-export-state). **Create writes NO PG row today.** `FLAGS.SNAPSHOTS` gates the routes (default off).
- ⚠ **The plan calls `harness_snapshots_consolidated` an "orphan, never written." THAT IS WRONG.** It has **50 live rows** (stale `sheets` data, 2026-05-07) written by the **archived** `031` trigger (per-harness `harness_snapshots` → consolidated copy). It is a **separate legacy "iteration-snapshot" concept** (`features_json`/`validation_md`/`iter_num` columns), **git-exported** via `apps/operator/lib/harness-state/git-export/serialize.ts:37`, and read by `scaffold-harness-schema.ts` + the sync-resolver. It is **NOT** the export-state tarball index — **dropping it would break git-export + those readers.**
  → So P-006 "wire-or-drop the orphan" resolves to: **create a NEW table for export-state snapshots; LEAVE the legacy iteration-snapshot tables** (or verify-the-iteration-concept-is-dead, then drop — a *separate* follow-up, not this brief). This is the D-010-sanctioned "dropped for a new table."
- Capture pulls: the per-harness schema dump (`harness_<slug>.*`) + the `SHARED_TABLE_FILTERS` includes. The dump loop is `pg-dump.ts:133 copyFilteredSharedTables` (now existence-guarded).
- **work_items = `harness_shared.work_items`** (su-adb1b confirmed; NOT built yet — it generalizes `harness_features_consolidated`; per-harness become thin views). When it lands: add a `SHARED_TABLE_FILTERS` **include** entry with a **slug-scoped** filter — **confirm the slug column against the landed schema** (siblings use `install_slug`; `harness_features_consolidated` keys on `harness_slug`). The existence guard makes adding it safe pre-migration.

## Scope
- **New `harness_shared.snapshot_index`** table (migration ≥ **134** — get the number from su-b989e's allocator; idempotent SQL per `CLAUDE.md` storage policy): `snapshot_id` PK, `harness_slug`, `tarball_path`, `bytes`, `content_hash`, `created_at_ms`, `name`, `description`, `license`, `manifest jsonb`, `published jsonb`. Add it to `SHARED_TABLE_FILTERS` as an **`exclude`** (it's an operator-local index — never captured into a snapshot). Then `node libs/papercusp/libs/db/scripts/pull-schema.mjs`.
- **Write the index row on create** (`create.ts` / inside `capture()` — pick the layer that keeps export-state PG-free if that's a design constraint; the route layer is the safer place). *(apps/operator — su-9e6b8 carve zone.)*
- **PG-indexed discovery:** `snapshot-discovery.ts` queries `snapshot_index`; keep an **FS reconcile sweep** (index tarballs that lack a row) for robustness + migration of existing FS-only snapshots. *(apps/operator — carve zone.)*
- **work_items capture:** when `harness_shared.work_items` lands, add the include filter (one-liner; guard already in place).
- **D-004 plugin-bundling narrowing (couples to BRIEF A / E2):** the snapshot currently bundles plugin DEFS in the manifest (`create.ts readEnabledPlugins`). Per D-004 that bundling moves to the blueprint dep-manifest (declare, don't embed). **Coordinate with the E1/E2 owner**; leave as-is + note until then.

## Testing
Integration (Docker PG): create → assert FS tarball **and** a `snapshot_index` row; discovery reads from PG; FS-reconcile picks up an orphan tarball. The existing export-state suite (123 unit tests) must stay green. Tests go in the canonical homes (Vitest `<pkg>/lib/**`); `apps/operator` snapshot routes → operator Vitest.

## Done when
Creating a snapshot writes an FS tarball **+** a PG `snapshot_index` row; discovery is PG-indexed (FS reconcile for orphans); P-005 exclusion tests stay green; `work_items` capture wires in cleanly the moment the table lands.

## Do NOT
drop `harness_snapshots`/`_consolidated` without a separate verify-dead pass (git-export depends on it); guess the `work_items` slug-filter column; put export-state into a hard PG dependency if the package is meant to stay PG-agnostic (do the PG index write at the operator route layer); edit `apps/operator` during su-9e6b8's carve without coordinating paths.
