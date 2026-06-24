# HANDOFF — papercup→papercusp physical rename: the owner window runbook

> Author: su-fd4faac9 (autonomous overnight, 2026-06-24). Owner-facing.
> Plans: `papercup-physical-rename-phase5-2026-06-20` (P-007/P-008/P-009),
> `papercup-to-papercusp-migration-2026-06-20` (P-005/P-006).
>
> **What this is:** Brief 11 is ~done in code. The only thing left is the
> deploy-staged **irreversible trio** — it needs ONE coordinated quiescent
> window that the owner runs. This file is the push-button runbook + the
> investigation that clears the last open gate. **Nothing here was executed
> autonomously** (a dir mv / DROP SCHEMA / systemd rename with the fleet live
> and the owner asleep is exactly the irreversible+high-stakes case that stops
> AUTO mode). Everything safe + reversible was already landed (see bottom).

---

## 0. Gate cleared: DROP SCHEMA papercup_shared is replication-SAFE ✅

The P-009 CONTRACT was gated on a replication sign-off ("does the Hetzner :5433
logical-replication source break?"). **Investigated + resolved 2026-06-24:**

| Check | Result |
|---|---|
| `pg_publication` on live DB | **0** |
| `pg_replication_slots` | **0** |
| `pg_subscription` | **0** |
| `papercup_shared` objects | **6, all VIEWS** (0 base tables) |
| cross-schema deps on `papercup_shared` (pg_depend/pg_rewrite) | **0** |
| live connections referencing `papercup_shared` (pg_stat_activity) | **0** |
| live runtime code referencing `papercup_shared` | **0** (release :3070 @fcd8194db + staging both use `papercusp_shared`) |

**Why it cannot break replication:** the `papercup-pg-tunnel.service` is an SSH
**reverse** tunnel (`-R 0.0.0.0:5433:localhost:5432 root@178.156.253.226`) — it
only *exposes* this local PG on Hetzner's :5433. Logical replication requires a
PUBLICATION on the source + a SLOT created by the subscriber; **both are 0 here**,
so nothing is actively replicating from this DB. And even if something were,
**views are never part of logical replication** — only base tables in a
publication replicate, and the real tables now live in `papercusp_shared`.
Dropping 6 dead compat views is inert.

> The one latent footgun was found + fixed in the same pass (already landed, not
> windowed): `embedded-postgres-server/src/index.js` created the Zero publication
> `FOR TABLES IN SCHEMA harness_shared, papercup_shared`. Post-332 that schema is
> only views, so a **fresh** embedded install would have silently published zero
> message tables, and post-CONTRACT it would fail outright. Repointed to
> `papercusp_shared` (the D-001 codemod had missed this file).

---

## 1. STAGED CONTRACT migration (do NOT pre-place in sql/ — auto-applies on deploy)

When the window opens, save the block below as
`libs/papercusp/libs/db/sql/394-drop-papercup-shared-compat.sql` (394 = next free;
393 is the current max on disk, 392 the max recorded), then apply it **via the
runner** (`db:migrate`), never raw `psql -f` (storage-policy: a raw apply skips
the `schema_migrations` row → re-runs every deploy → lock-timeout wedge).

```sql
-- 394-drop-papercup-shared-compat.sql
-- CONTRACT phase of papercup_shared → papercusp_shared (Brief 11, phase5 P-009).
-- EXPAND (migration 332) renamed the 6 base tables into papercusp_shared and left
-- papercup_shared as 6 auto-updatable compat VIEWS. This drops them + the schema.
-- IDEMPOTENT: no-op once papercup_shared is gone. Replication-safe (0 pubs/slots/subs;
-- views are not logically replicated). Verified safe 2026-06-24 — see
-- HANDOFF-papercup-rename-window-runbook-2026-06-24.md §0.
DO $contract$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'papercup_shared') THEN
    DROP SCHEMA papercup_shared CASCADE;  -- CASCADE drops the 6 compat views
    RAISE NOTICE 'CONTRACT: dropped papercup_shared compat views + schema';
  ELSE
    RAISE NOTICE 'CONTRACT: papercup_shared already absent — no-op';
  END IF;
END
$contract$;
```

After it applies: `node libs/papercusp/libs/db/scripts/pull-schema.mjs` to
regenerate `generated.reference.sql` (it still shows `papercup_shared` — stale),
then grep-gate (§4).

---

## 2. Ordered window runbook (D-001 sequence)

Run during ONE quiescent window. Order: **schema CONTRACT → repo-dir → services
(dev-api LAST)**. Each step verifies before the next.

### Step A — P-009 CONTRACT (schema)
1. Confirm both trees run code that uses `papercusp_shared` only (already true).
2. Place + apply migration 394 (§1) via `db:migrate`.
3. Verify: `SELECT count(*) FROM papercusp_shared.messages;` works; `papercup_shared`
   gone (`\dn`). bg-host + dev-api both still query OK.

### Step B — P-007 REPO DIR via symlink bridge (13 refs)
```bash
# inode moves with the rename; every absolute path + running process resolves via the symlink
mv /home/marsh-office/papercupai-workspace/papercup /home/marsh-office/papercupai-workspace/papercusp
ln -s papercusp /home/marsh-office/papercupai-workspace/papercup
```
Then update refs to the REAL `…/papercusp` path (keep the symlink until 0 refs remain):
- 11 systemd `--user` units' `WorkingDirectory`/`ExecStart` (see Step C list)
- `apps/operator/.env.local` `PAPERCUSP_INTEGRATION_ROOT` (line ~140). **NOT**
  `RELEASE_ROOT=…/papercup-release` (a different artifact, out of scope).
- 2 build-script `ExecStart`/`WorkingDirectory`
- the `path` of the `papercusp` hive in the registry
- `daemon-reload` + restart services (Step C); drop the symlink only after grep shows 0 refs to the old path.

### Step C — P-008 SERVICES (11 units; dev-api LAST)
EXCLUDE the 2 gateway units (`papercup-inference-gateway` + `-watchdog`, su-4969f owns).
Per unit: create `papercusp-*` (copy + `s/papercup-/papercusp-/` in Description/Alias +
WorkingDirectory per Step B), `systemctl --user disable old && enable new`, migrate the
watchdog target, `daemon-reload`, restart.
Units: `papercup-bg-host`, `papercup-staging-api`, `papercup-pg-tunnel`, `papercup-vm-mac`,
their `*-watchdog` siblings, **and `papercup-dev-api` LAST** (its restart bounces :3070 / the MCP).
Verify: all active under new names; :3070 responds; bg-host routines fire; git-sync commits.
(NB: git-sync's `auto-commit ${slug}` label ALREADY reads `papercusp` — `${slug}` is the migrated
harness slug, not the dir name; live commits flipped to `auto-commit papercusp` post-P-003. The
early `auto-commit papercup` commits were historical. So P-005's "git-sync label" sub-item is
already satisfied; the dir rename does not change it.)

---

## 3. What was already done (safe + reversible — landed, not windowed)

- **Schema EXPAND** (migration 332) — done earlier; recorded in `schema_migrations`.
- **`register-papercup.ts`→`register-papercusp.ts`**, **`PAPERCUP_HARNESS_SLUG`→`PAPERCUSP_HARNESS_SLUG`**,
  **`LEGACY_DEFAULT_HOME_HARNESS='papercusp'`**, **`@papercupai/papercusp-monorepo`** — all already in code (verified 0 literal refs).
- **`PAPERCUP_ROOT`** last ref (a doc-comment) → `PAPERCUSP_ROOT`. **0 left in code.**
- **`embedded-postgres-server/src/index.js`** `papercup_shared`→`papercusp_shared` (the missed D-001 codemod file; required before CONTRACT — see §0).
- Live spine 100% re-homed to papercusp; papercup-hive cleaned; 43 work_items re-homed (migration P-002/P-003, done earlier).

## 4. What remains AFTER the window (cleanup, then grep-zero gate)

- `pull-schema.mjs` regen (stale `generated.reference.sql`).
- `scripts/backfill-briefings.mjs` + `deploy/papercup-db-init.sql` — one-off / Hetzner-deploy `papercup_shared` refs; update or retire.
- `seed-learning-singletons.ts` `'papercup'` literals are **INTENTIONAL** legacy-retirement queries — leave until the legacy fallback (`RETIRED_HARNESS_SLUG_ALIASES`, migration P-006) is removed, which is gated on "nothing resolves to papercup".
- The **`@papercupai` npm SCOPE** (org name, ~205 files incl. ~40 plugin manifest names + the plugin-loader's hardcoded `@papercupai/` prefix + installed-plugin DB identity + git remote) is a separate deliberate decision — NOT a mechanical rename. Decide with the owner; out of the rename's safe scope.
- Final P-006 grep gate: `rg -P "papercup(?!s)"` excluding intentional history/migrations/`_retired`/the `@papercupai` scope + the intentional legacy-alias shim.
