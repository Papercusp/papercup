# SU agent file-lock coordination

Cross-process file claim coordination for engineer-collaborator agents
(Claude Code, OMP, Codex, Gemini) reaching Papercusp via `papercusp-su`.

**Plan:** [`apps/operator/docs/plans/su-agent-coordination-v3-2026-05-14.md`](../../../docs/plans/su-agent-coordination-v3-2026-05-14.md)

## Phase 1 ships (this commit)

Cooperative no-wait surface — 5 verbs, advisory-lock-per-workspace
serialization, FIFO-ordered grant cascade for future waiters, identity
via `?client=` URL param.

| Tool | What it does |
|---|---|
| `locks:acquire` | Atomic multi-path claim. Returns `{ok, lock_id, expires_ts, held}` or `{ok: false, busy: [...]}`. |
| `locks:release` | Free locks + run cascade. Pass `lock_id` (with optional `paths` filter) or `all_mine: true`. |
| `locks:heartbeat` | Extend a lock's TTL. `extended: false` means it was already stolen. |
| `locks:cancel_wait` | (Phase 2 — waiter cancellation; no-op until wait subsystem ships.) |
| `locks:queue` | Read-only inspection. Active locks + pending waiters + (optional) terminal waiters from the last 24h. |

Defaults: `ttl_sec=1200` (20 min), max `ttl_sec=3600` (1 h), max
`paths.length=50`, max `intent` 200 chars.

## Phase 2 (not yet)

Server-side blocking acquire via `LISTEN/NOTIFY` (6-step
LISTEN-before-INSERT protocol). The `wait: { max_sec: N }` parameter on
`locks:acquire` is accepted but currently no-op — returns immediate
busy. Phase 2 wires up `WorkspaceListener` (refcounted shared
connection), waiter cap (10/owner), and progress events.

## Phase 3 (not yet)

`PreToolUse` / `PostToolUse` hooks for Claude Code (and OMP) — turns the
cooperative surface into enforced. Other CLIs (Codex, Gemini) stay
cooperative until their hook recipes land.

## Storage

- **Database:** `papercusp_su` (separate from `papercusp` main db, same
  embedded PG instance, same `harness_admin` role).
- **Bootstrap:** Lazy on first `locks:*` call. Creates the db if absent,
  applies SQL migrations from `@papercusp/locks`'s
  `packages/locks/src/sql/NNN-*.sql` under
  `LOCK TABLE su_meta IN SHARE UPDATE EXCLUSIVE MODE` to serialize
  concurrent migration runners.
- **Schema:** `agent_file_locks`, `agent_lock_waiters`, both with
  aggressive per-table autovacuum settings (5% bloat threshold).

### One-time install prereqs

The bootstrap needs `harness_admin` to be able to `CREATE DATABASE`.
Granted once per machine:

```bash
sudo -u postgres psql -c "ALTER ROLE harness_admin CREATEDB;"
```

For query-level perf monitoring (optional), enable `pg_stat_statements`
as superuser after the database exists:

```bash
sudo -u postgres psql -d papercusp_su -c "CREATE EXTENSION pg_stat_statements;"
```

## Concurrency model

```ts
inWorkspaceTxn(workspaceId, ownerId, async (tx) => {
  // SET LOCAL application_name = 'papercusp-su:' || ownerId
  // SET LOCAL lock_timeout = '5s'
  // SET LOCAL statement_timeout = '5s'  (per-op override in handler)
  // SELECT pg_advisory_xact_lock(101, hashtext('su:' || workspaceId))
  // ...tool body runs serialized within this workspace...
});
```

The advisory key `101` is reserved for SU locks in
[`packages/locks/src/sql/advisory-lock-keys.md`](../../../../../packages/locks/src/sql/advisory-lock-keys.md).
Two-arg form prevents collision with any future feature using advisory
locks.

## Canonical-path contract

A lock key is `hashtext('su:' || coordination_domain || ':' || path)`. Two
callers contend **iff** they pass the byte-identical `path` string —
so every caller MUST pass the same canonical form for the same file,
or the lock silently provides nothing.

`normalizePaths()` (`su-lock-store.ts`) enforces the contract on every
`locks:acquire`. It runs `validatePath()` on the **raw** path, then
`canonicalizePath()`:

| Rule | Example in → out |
|---|---|
| Strip leading `./` | `./apps/foo.ts` → `apps/foo.ts` |
| Collapse repeated `/` | `apps//foo.ts` → `apps/foo.ts` |
| Drop `/./` segments | `apps/./foo.ts` → `apps/foo.ts` |
| Strip trailing `/` | `apps/foo.ts/` → `apps/foo.ts` |

Rejected outright (`InvalidPathError`, never normalized):

- **Absolute** paths (`/etc/passwd`) — paths must be repo-relative.
- **`..` traversal** (`../x`, `a/../b`, bare `..`).
- **Backslashes** (`apps\foo.ts`) — POSIX forward slashes only.
- **NULL bytes**, empty, or anything that canonicalizes to empty.

**Symlinks are the caller's responsibility.** The operator does not
share the agent's working directory, so it cannot `realpath` a
symlink. A caller that locks a symlink and another that locks its
target will NOT contend. Resolve symlinks to their real path before
calling `locks:acquire`. (The OMP enforcement hook refuses to acquire
on a symlink — see `scripts/hooks/`.)

## Inspection

```bash
# Find SU PG db (URL is reused from the main embedded-pg).
PSQL_URL="postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp_su"

# Active locks + waiters
psql "$PSQL_URL" -c "SELECT path, owner_label, intent, expires_ts FROM agent_file_locks ORDER BY expires_ts;"
psql "$PSQL_URL" -c "SELECT ticket_id, owner_label, paths, status, queued_ts FROM agent_lock_waiters WHERE status='waiting';"

# Per-agent activity (which connections are doing what)
psql "$PSQL_URL" -c "SELECT pid, application_name, state, query_start, query FROM pg_stat_activity WHERE application_name LIKE 'papercusp-su:%';"

# Query stats
psql "$PSQL_URL" -c "SELECT calls, total_exec_time, mean_exec_time, query FROM pg_stat_statements WHERE query LIKE '%agent_file_locks%' ORDER BY total_exec_time DESC LIMIT 10;"
```

## Troubleshooting

### Stuck advisory lock — kill a wedged connection

If a connection is hung inside a `papercusp-su` transaction (bug in a
tool, network partition, infinite loop), `idle_in_transaction_session_timeout`
(30s, set at db level) handles the idle case. For an actively-spinning
backend that won't release:

```sql
SELECT pid, application_name, state, query
  FROM pg_stat_activity
 WHERE application_name LIKE 'papercusp-su:%'
   AND state IN ('active', 'idle in transaction')
   AND state_change < now() - interval '1 minute';

-- After confirming the offending pid:
SELECT pg_terminate_backend(<pid>);
```

### Reset all lock state

The separate-database design makes nuclear reset trivial:

```sql
\c papercusp
DROP DATABASE papercusp_su;
-- Next locks:* call recreates it.
```

### Lock survived an agent crash

By design — TTL is the only way agents are guaranteed to lose a held
lock. Default TTL is 20 minutes; another agent's next `locks:acquire`
silently steals the expired lock. To force-release immediately:

```sql
DELETE FROM agent_file_locks WHERE owner_label LIKE '%<some-substring>%';
```

## Manual smoke test

```
# Terminal A
omp
> use locks:acquire to claim apps/operator/lib/foo.ts for 60s

# Terminal B (within 60s)
omp
> use locks:acquire to claim apps/operator/lib/foo.ts

# Expect: B sees ok=false, busy=[{path: 'apps/operator/lib/foo.ts', owner_label: '...', expires_ts: '...'}]
# After 60s of waiting on B + re-trying: should succeed.
```

## Divergence from the v3.3 plan

Two pragmatic adjustments:

1. **Same `harness_admin` role, not a new `papercusp_su` role.**
   Embedded PG has no external network surface; the grant-isolation
   benefit doesn't justify the password-file complexity.
2. **Migrations live with the package at `packages/locks/src/sql/`**
   (moved there from `apps/operator/lib/agent-tools/locks/sql/` in the
   P-010 extraction), not `libs/papercusp/libs/db/sql/su-locks/`. Keeps
   the feature self-contained; the main DB's migration system targets a
   different database anyway.

Everything else follows the v3.3 plan.
