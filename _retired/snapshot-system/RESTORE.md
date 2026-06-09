# RESTORE — the harness-snapshot system

**Retired:** 2026-06-09 · plan `retire-snapshots-instance-spec-2026-06-09` (Phase B)
**Last-active superproject commit (files in their original locations):** `301ffa5e109840dc817a3b419725d508f1646dfc`
**Restore tag:** `snapshot-system-retired-2026-06-09`

## What this is

The whole **harness-snapshot system** — FS `.tar.gz` tarballs at
`<project>/.papercusp/snapshots/snap_*.tar.gz` + a PG discovery index
(`harness_shared.snapshot_index`, migration 134) + the `snapshots:*` MCP tools +
the `/api/snapshots/*` routes + the Cupboard `kind=snapshot` listing path (worker
+ operator UI) + the `SNAPSHOTS` feature flag + the R2 tarball blob store.

It was a **monolithic-era** abstraction (built when a "harness" *was* the whole
world). Its three jobs were re-homed: **distribution → blueprints** (the Cupboard
distributes recipes), **backup → git + PG** (code + state are already durable), and
the one remaining job — the **reproducible clone** — became the lightweight
**`InstanceSpec`** (`blueprintRef + repoSha + deploymentConfig + genome`;
`capture` / `boot` / `vary`), which lives at
`packages/operator-core/lib/instance-spec/`. See the plan for the full rationale.

## Moved files (all from their original superproject locations)

- **`papercusp-export-state/`** ← `libs/papercusp-export-state/` — the FS-tarball
  capture/restore lib (`@papercusp/export-state`): `capture`, `staging`, `tarball`,
  `pg-dump`, `secret-scan`, `manifest`, `restore`, the `snapshot-index` row core,
  `shared-table-filters`, `binaries` (the `pg_dump`/`trufflehog`/`gitleaks` probes), etc.
- **`operator-core/`** ← `packages/operator-core/lib/` — `snapshot-discovery.ts`,
  `snapshot-index.ts`, `snapshot-locks.ts`, `snapshot-config-redact.ts`,
  `snapshot-shape.ts`, `cupboard-snapshot-blob.ts` (was `cupboard/snapshot-blob.ts`),
  `agent-tools-snapshots/` (the `snapshots:list` / `snapshots:get` tools, was
  `agent-tools/snapshots/`), `endpoint-route-routes-snapshots/` (the `/api/snapshots/*`
  routes, was `endpoint-route/routes/snapshots/`), `endpoint-route-tests/` (the route
  tests), and the colocated `*.test.ts`.
- **`operator-vite-routes/`** ← `apps/operator-vite/src/routes/` — `snapshots/` +
  `installed-snapshots.tsx` (the SPA snapshot routes).
- **`operator-app-ui/`** ← `apps/operator/app/` — `snapshots/` + `installed-snapshots/`
  (the `SnapshotsClient` / `InstalledSnapshotsClient` / `ForkClient` page implementations).
- **`operator-public/`** ← `apps/operator-public/src/routes/` — `blobs.ts` (the R2
  snapshot-tarball blob routes) + `snapshot-blobs.test.ts`.
- **`apps-operator-test/`** ← `apps/operator/test/` — `snapshot-index.integration.test.ts`,
  `cupboard-publish-fork.integration.test.ts`.

## Surgery that landed WITH the move (must be reverted to restore)

- **Registrations pruned:** the two `snapshots/{list,get}` imports in
  `packages/operator-core/lib/agent-tools/index.ts` (replaced by the new
  `instance/{capture,boot,clone}` imports); the eight `snapshots/*` route imports +
  `flatten(...)` lines in `packages/operator-core/lib/endpoint-route/routes/index.ts`;
  the `blobs` route import + registration in `apps/operator-public/src/routes/index.ts`.
- **Cupboard `kind=snapshot` removed:** `'snapshot'` dropped from `LISTING_KINDS` +
  `listingAction` in `packages/operator-core/lib/cupboard/types.ts` and
  `apps/operator-public/src/db.ts`; the snapshot tarball validation block + the
  unlist blob-GC removed from `apps/operator-public/src/routes/listings.ts`; the
  `tarball_*` fields removed from the worker `HarnessRow`/`NewHarnessInput`/INSERT +
  `countActiveListingsByTarballKey` removed (the D1 `tarball_*` columns, worker
  migration 005, were LEFT as vestigial/nullable — no worker migration drops them);
  the `SNAPSHOTS` R2 binding removed from `env.ts` + `wrangler.toml`; the
  CupboardClient UI (`VIEW_FILTERS` / `KindIcon` / `KIND_TONES` / `Camera` import).
- **`SNAPSHOTS` flag removed** from `libs/flags/src/types.ts` (+ `FLAG_DEFAULTS`),
  and every consumer: the operator-vite gated routes, `ChromeShell` nav, `settings/layout`,
  `FeaturesAdmin` labels/blurbs, the cap-tier heuristic test, the flags `*.test.ts`.
- **Migration 199** (`libs/papercusp/libs/db/sql/199-drop-snapshot-index.sql`) drops
  `harness_shared.snapshot_index`; the `snapshotIndexInHarnessShared` table block was
  removed from `schema/schema.ts` + `schema/generated.ts`.
- **`@papercusp/export-state` workspace** removed from the root `package.json`
  `workspaces` list + `package-lock.json`, and the `@papercusp/export-state` dep +
  the "snapshot binaries" doctor section removed from `libs/papercusp/packages/cli`.

## NOT touched (a separate, still-LIVE system — do NOT conflate)

The legacy `harness_shared.harness_snapshots` / `harness_snapshots_consolidated`
tables are a DIFFERENT "iteration snapshot" concept (features_json / validation_md /
iter_num), trigger-fed + git-exported (`harness-state/git-export/serialize.ts`, the
`/harness/snapshots` route, `scaffold-harness-schema`). Migration 134 explicitly
warned not to conflate them. The plan's P-008 mislabeled
`harness_snapshots_consolidated` as "orphaned" — it is not; only `snapshot_index`
was retired. The `backup:*` (kopia) tools + `operator/state-snapshot` + the
`internal/*-snapshot` routes are also unrelated and untouched.

## To restore

1. `git mv` each subtree back to its original location (see "Moved files" above).
2. Re-add `libs/papercusp-export-state` to the root `package.json` `workspaces` +
   the CLI dep, then `npm install`.
3. Re-add the registration imports/lines pruned above.
4. Re-add the `SNAPSHOTS` flag (+ default `true` if reverting to the pre-retire ship
   state), the Cupboard `kind=snapshot` path, the worker tarball fields + R2 binding.
5. Revert migration 199 (drop the file or add a re-create migration) + restore the
   `snapshotIndexInHarnessShared` block in `schema/{schema,generated}.ts`.
6. Remove this row from the root `CLAUDE.md` "Retired / preserved-not-active surfaces" table.
