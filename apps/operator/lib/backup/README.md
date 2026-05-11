# Backup — per-workspace kopia repo

Phase 1 implements the backend wrapper around the kopia CLI. UI lives in
`/settings/backups` (Phase 2) and `/dev` → Backups tab (Phase 3).

## Shape

```
apps/operator/lib/backup/
├── types.ts            — public types + retention presets
├── password.ts         — HKDF from ~/.papercusp/db-encryption-key
├── workspace-backup.ts — WorkspaceBackup class (ensureRepo, snapshot, list, stats, verify, getSettings)
└── README.md
```

## Repo layout per workspace

```
~/.papercusp-workspaces/<id>/backups/
├── kopia-repo/         — the kopia content-addressed store
├── repository.config   — kopia client config (auto-generated)
├── cache/              — kopia local cache
└── logs/               — kopia client logs
```

## Why a per-workspace repo

See discussion in plan: dedup wins (phase worktrees share ~95%, harnesses
within a workspace share heavily), lifecycle matches user intent (delete
workspace = delete one repo), blast-radius isolation is already provided
by path-scoped restore — no need for per-harness repos to get that.

## Password derivation

`deriveRepoPassword(workspaceId)` does HKDF-Expand over the contents of
`~/.papercusp/db-encryption-key`, with a context label that binds to
`kopia-backup-v1` + the workspace id. Same threat surface as today's PG
encryption: lose the key, lose the backups. No new secret to store.

## What's snapshotted

Today the workspace root (`~/.papercusp-workspaces/<id>/`) is the only
source. The global ignore policy (see `IGNORE_PATTERNS` in
`workspace-backup.ts`) strips `node_modules`, build artifacts, etc.

Coming in Phase 4 (event triggers): pre-snapshot DB dump hook that
writes transactional PG dumps for both `:5432` and the workspace's
embedded-pg-on-:16534 into a `db-dumps/` dir inside the workspace, so
kopia captures consistent copies alongside the raw data dir.

## Phase 1 scope

- ✅ `ensureRepo()` — idempotent init/connect
- ✅ `snapshot(reason, context?)` — creates kopia snapshot + PG row
- ✅ `list(limit)` — recent snapshots from PG
- ✅ `stats()` — repo stats from PG (dedup ratio, last ok/fail)
- ✅ `verify()` — `kopia snapshot verify`
- ✅ `getSettings()` — read or insert+read row
- ⏳ `restore()` — Phase 5 (restore-to-clone)
- ⏳ `maintenance()` — Phase 2
- ⏳ `mount()` — Phase 3
- ⏳ `stream()` — Phase 3 (SSE for UI live progress)
- ⏳ Pre-snapshot DB hook — Phase 4

## Migrations

`apps/operator/lib/commands/migrations/012_workspace_backups.sql` creates
three tables in `harness_shared`:

- `workspace_backup_settings` — one row per workspace
- `backup_snapshots`         — one row per snapshot attempt
- `backup_events`            — append-only audit + UI stream
