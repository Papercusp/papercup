# SU agent coordination — v3 implementation plan

**Date:** 2026-05-14
**Status:** Built — Phases 0–3 shipped 2026-05-14; per-session identity fix 2026-05-20. See `apps/operator/lib/agent-tools/locks/PHASE-STATUS.md` for the as-built phase log.
**Supersedes:** v1 (filesystem locks, SQLite proposals) and v2 (PG migration with SERIALIZABLE)
**Scope:** Cross-process file-claim coordination for engineer-collaborator agents reaching Papercusp via `papercusp-su`. Embedded-PG-backed, durable waiter queue with FIFO fairness, server-side blocking acquire via LISTEN/NOTIFY, operator-visible queue. Per-workspace advisory-lock serialization.

---

## 0. Evolution from v1 → v2 → v3

The plan went through two major revisions in response to reviewer feedback. This section captures *why* each change happened so a future reader can judge whether the reasoning still holds.

### v1 (initial) — filesystem + SQLite proposals

Started with two options under "portability": filesystem lockfiles using `O_EXCL` + atomic rename, then SQLite as the more transactional alternative.

| Aspect | v1 design |
|---|---|
| Storage | `~/.papercusp/su-locks.db` (SQLite, WAL mode) |
| Multi-file acquire | Single `BEGIN IMMEDIATE` transaction with `INSERT … ON CONFLICT … WHERE expires_ts <= …` |
| Wait mechanism | Adaptive polling loop, 200ms–5s |
| Concurrency model | better-sqlite3 sync API + WAL serialization |
| Identity | Bash heuristic chain: `$WINDOWID || $KITTY_WINDOW_ID || $ITERM_SESSION_ID || tty || $$` |
| Workspace | URL param with per-call override |
| Path locks | Per-file only |
| Enforcement | Cooperative (tool surface only) |
| Test strategy | `Promise.all` of 4 acquires in one process |
| Estimate | 2.5 dev-days |

### v2 (after first reviewer pass) — PG migration

The reviewer caught that SQLite was a second persistence stack when embedded PG was already running. User extended it to a separate `papercusp_su` database (not just a schema) for blast-radius and migration independence.

| Change | Why |
|---|---|
| SQLite → embedded PG, separate `papercusp_su` db | Already running; consistent backup story via Kopia; one persistence stack; separate db isolates blast radius and migration sequence |
| Polling loop → `LISTEN/NOTIFY` | Sub-ms wake latency vs 200ms–5s; deletes the adaptive-poll subsystem |
| `paths_json TEXT` → `text[]` + GIN index | First-class PG arrays; `&&` overlap operator for conflict queries |
| App-side UUID/timestamp → server-side `gen_random_uuid()` + `clock_timestamp()` defaults | Eliminates clock-skew bugs and a category of "passed wrong value" mistakes |
| Concurrency model | `BEGIN ISOLATION LEVEL SERIALIZABLE` everywhere + app-side retry on 40001 |
| App-code grant cascade → PL/pgSQL function `grant_cascade()` | One round trip instead of N+1; encapsulation; force-release can't accidentally skip cascade |
| LISTEN channel per ticket → per workspace, payload = ticket_id | One connection per active workspace instead of N per N waiters |
| Identity heuristic chain → UUID baked once by install script | Brittle bash heuristics replaced with stable UUID; terminal name becomes advisory label only |
| Workspace override → URL-only | Two paths = two failure modes |
| Test: `Promise.all` → child processes with own PG connections | Real cross-process semantics |
| Enforcement | Added Phase 4: Claude Code PreToolUse hook |
| Waiter cap | `MAX_WAITERS_PER_OWNER = 10` |
| Default TTL | 600s → 1200s (compromise between reviewer's 1800s and original 600s) |
| Estimate | 2.5 → 5 dev-days |

### v3 (after second self-audit) — advisory-lock simplification

Auditing v2 found three real misses and several refinements. The biggest: PG advisory locks (`pg_advisory_xact_lock`) are the right serialization primitive for the *transactions that manipulate the persistent lock state*. This collapses the concurrency model.

| Change | Why |
|---|---|
| `SERIALIZABLE` + 40001 retry logic → `pg_advisory_xact_lock` per workspace + `READ COMMITTED` | Single serialization point per workspace; no anomaly reasoning; no app-side retry; ~30 lines of concurrency logic → ~6 |
| Hand-wavy LISTEN ordering → explicit 7-step LISTEN-before-INSERT protocol | Eliminates lost-wakeup window; reinforces per-workspace-channel choice |
| Added `lock_timeout = '5s'` per transaction | Fail-fast on stuck advisory-lock holders |
| Added `idle_in_transaction_session_timeout = '30s'` at role level | Catches wedged sessions; auto-releases advisory locks |
| Added `application_name = 'papercusp-su:' || owner_id` per connection | `pg_stat_activity` becomes a free diagnostic surface |
| LISTEN cleanup spelled out: refcount on shared workspace listener connection | Avoids leaked LISTEN subscriptions |
| Path validation in `BEFORE INSERT` trigger | Belt-and-suspenders alongside app-side validation; catches ad-hoc `psql` inserts too |
| `grant_cascade()` gains explicit `EXCEPTION` blocks | One waiter row vanishing mid-cascade no longer aborts the whole transaction |
| Queue position calculation → `ROW_NUMBER() OVER` | Idiomatic PG, single pass |
| Added `CREATE EXTENSION pg_stat_statements` | Free query-level performance monitoring |
| Status column → `CREATE TYPE waiter_status AS ENUM` | Stronger typing than CHECK constraint |
| Per-operation `statement_timeout` instead of global 500ms | Release/cascade can legitimately run longer than acquire |
| Acquire verify step → CTE with `RETURNING` | One round trip instead of two |
| Estimate | 5 dev-days (unchanged; complexity moved from concurrency to PL/pgSQL) |

Net effect v2 → v3: roughly the same line count, but the **reasoning load** is much lower. "Wrap state mutations in `inWorkspaceTxn`" is a primitive the reviewer can understand in one read. "Detect serialization anomalies and retry on 40001" requires understanding PG's anomaly detection model.


---

## 1. Goals & non-goals

### Goals

- Two or more OMP shells editing the same workspace **never lose work to a stomp**.
- An agent that wants a file already held **waits** (server-side blocking call, bounded timeout) instead of retrying or yielding to the user.
- **FIFO fairness** among waiters: queued-first agent gets the file first.
- **Hot-file anti-starvation**: a long-waiting agent doesn't lose forever to short-acquire churn.
- **Survives session crashes**: TTL-expired locks auto-yield; orphan waiter rows get janitored.
- **Survives MCP-connection drops**: a waiter can re-attach to its existing ticket on reconnect.
- **Inspectable**: `locks:queue` tool + `psql` against `papercusp_su` + `pg_stat_activity`.
- The user is involved only when an agent truly gives up (wait timed out, agent decided not to retry).
- **Cooperative tool surface** as the universal layer; **Claude Code PreToolUse hook** as the first enforcement layer.

### Non-goals

- Cross-machine coordination. Single laptop / single user only. The MCP tool surface is designed so a future remote-PG swap is mechanical.
- Locking *git state* — only the live working tree. Branches are out of scope.
- Replacing PR review.
- Fencing tokens. There is a small window (between heartbeat-fail and the agent noticing) where a stolen-from agent can still write. The PreToolUse hook closes most of it. Full fencing is over-engineering for single-machine cooperative use.
- Locking files outside a workspace.
- Path-prefix locks. Per-file paths only; prefix support is a future YAGNI decision deferred until contention patterns demand it.

---

## 2. Architecture

```
┌──────────────────┐                                ┌─────────────────────┐
│ OMP shell #1     │   locks:acquire(paths, wait)   │ papercusp-su (HTTP) │
│ Claude Code etc. ├──────────────────────────────► │ MCP transport       │
└──────────────────┘   ctx.progress events back     │                     │
                                                    │ ┌─────────────────┐ │
┌──────────────────┐   locks:acquire(paths, wait)   │ │ locks:* tools   │ │
│ OMP shell #2     ├──────────────────────────────► │ │ (defineTool)    │ │
└──────────────────┘                                │ └────────┬────────┘ │
                                                    │          │          │
                                                    │ ┌────────▼────────┐ │
                                                    │ │ su-lock-store.ts│ │
                                                    │ │ (postgres-js)   │ │
                                                    │ └────────┬────────┘ │
                                                    └──────────┼──────────┘
                                                               │
                                       Embedded PG, db = papercusp_su
                                  (separate from main papercusp db)
```

- All `locks:*` tools run inside the operator process serving `papercusp-su`. SU agents share that one process's connection pool.
- Embedded PG: same instance bundled with Papercusp, separate logical database. Connection string resolved from `~/.papercusp/embedded-pg.json` per existing project pattern.
- Long-running tool calls stream `ctx.progress` events to the agent during a wait.

---

## 3. Storage

### 3.1 Database & role

A separate logical database on the embedded PG instance:

```sql
-- Run once at install / first bootstrap
CREATE DATABASE papercusp_su;
CREATE ROLE papercusp_su LOGIN PASSWORD :random;
GRANT ALL ON DATABASE papercusp_su TO papercusp_su;
ALTER ROLE papercusp_su SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE papercusp_su SET application_name = 'papercusp-su';  -- overridable per connection
```

The role's password lives at `~/.papercusp/su-db-password` (mode 0600), generated on first bootstrap, like the superuser token.

### 3.2 Extensions

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;          -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_stat_statements; -- free perf monitoring
```

### 3.3 Schema

```sql
CREATE TYPE waiter_status AS ENUM ('waiting','granted','expired','cancelled');

CREATE TABLE agent_file_locks (
  workspace_id  text         NOT NULL,
  path          text         NOT NULL,
  owner         text         NOT NULL,
  owner_label   text,
  intent        text         NOT NULL,
  lock_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
  acquired_ts   timestamptz  NOT NULL DEFAULT clock_timestamp(),
  expires_ts    timestamptz  NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
CREATE INDEX idx_locks_owner   ON agent_file_locks (owner);
CREATE INDEX idx_locks_expires ON agent_file_locks (expires_ts);

CREATE TABLE agent_lock_waiters (
  ticket_id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       text           NOT NULL,
  owner              text           NOT NULL,
  owner_label        text,
  paths              text[]         NOT NULL,
  intent             text           NOT NULL,
  ttl_sec            integer        NOT NULL,
  queued_ts          timestamptz    NOT NULL DEFAULT clock_timestamp(),
  wait_until         timestamptz    NOT NULL,
  status             waiter_status  NOT NULL DEFAULT 'waiting',
  granted_lock_id    uuid,
  granted_expires_ts timestamptz
);
-- Partial index — only active waiters are scanned in the FIFO cascade
CREATE INDEX idx_waiters_active
  ON agent_lock_waiters (workspace_id, queued_ts)
  WHERE status = 'waiting';
-- GIN for paths-overlap queries
CREATE INDEX idx_waiters_paths_gin
  ON agent_lock_waiters USING GIN (paths)
  WHERE status = 'waiting';
CREATE INDEX idx_waiters_owner
  ON agent_lock_waiters (owner) WHERE status = 'waiting';

-- Path validation trigger (applied to both tables)
CREATE FUNCTION validate_path(p text) RETURNS void AS $func$
BEGIN
  IF p = '' OR p LIKE '/%' OR p LIKE '%/../%' OR p LIKE '../%' OR length(p) > 4096 THEN
    RAISE EXCEPTION 'invalid path: %', p USING ERRCODE = '23514';
  END IF;
END;
$func$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION validate_lock_path() RETURNS trigger AS $func$
BEGIN
  PERFORM validate_path(NEW.path);
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

CREATE FUNCTION validate_waiter_paths() RETURNS trigger AS $func$
DECLARE p text;
BEGIN
  FOREACH p IN ARRAY NEW.paths LOOP
    PERFORM validate_path(p);
  END LOOP;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_lock_path
  BEFORE INSERT OR UPDATE OF path ON agent_file_locks
  FOR EACH ROW EXECUTE FUNCTION validate_lock_path();

CREATE TRIGGER trg_validate_waiter_paths
  BEFORE INSERT OR UPDATE OF paths ON agent_lock_waiters
  FOR EACH ROW EXECUTE FUNCTION validate_waiter_paths();
```

Note the `$func$` named dollar-quoting — bash heredocs collapse anonymous `$$` silently (see `agent-insights/pg-migrations-dollar-quote.mdx`).


### 3.4 Migration cadence

Migrations live as a separate sequence from the main `papercusp` db migrations. Format `NNN-description.sql`, run via a small `applySuLocksMigrations()` function that tracks applied versions in a `su_meta` table inside `papercusp_su`. Additive-only by policy.

> **As-built (2026-05-14):** migrations ship at `apps/operator/lib/agent-tools/locks/sql/` (`001-bootstrap`, `002-tables`, `003-grant-cascade`), co-located with the tool code, **not** at the originally-planned `libs/papercusp/libs/db/sql/su-locks/`. Reason: the SU-locks subsystem is operator-coupled (registered via `defineTool` in `apps/operator/lib/agent-tools/index.ts`), so its SQL belongs with the tools rather than in the shared db library — see [first-party tool location](/internal/docs/implementation/pi-integration). The `su_meta` version table and `applySuLocksMigrations()` runner are unchanged.

---

## 4. Agent identity

### 4.1 Stable `agent_id` (UUID)

Generated **once**, persisted at `~/.papercusp/su-agent-id` (mode 0600). The install script:

```bash
if [ ! -s "$HOME/.papercusp/su-agent-id" ]; then
  uuidgen > "$HOME/.papercusp/su-agent-id"
  chmod 600 "$HOME/.papercusp/su-agent-id"
fi
AGENT_ID=$(cat "$HOME/.papercusp/su-agent-id")
```

Re-runs are no-ops. The UUID is the durable identity; nothing about terminals or windows matters.

### 4.2 Human-readable `owner_label`

Built fresh per session for display only. Format: `<client>@<host>:<term>`, e.g. `claude-code@marsh-office:pts2`. Best-effort `tty`/`$WINDOWID` reading; falls back to `pid:<n>` if nothing else available.

Two agents with the same `pts2` (re-attached tmux) don't collide because `owner = agent_id (UUID)` is what the lock tables key on. The label is advisory.

### 4.3 Threading through `ctx`

Install script bakes the agent_id into the MCP server URL:

```jsonc
{
  "papercusp-su": {
    "type": "http",
    "url": "http://localhost:3070/api/mcp?superuser=1&client=<AGENT_ID>",
    "headers": { "Authorization": "Bearer <token>" }
  }
}
```

The `client` param already surfaces in `ctx.uiClientId` (per docs-retrieval Phase 2 telemetry plumbing). `locks:*` tools read it from `ctx`, never from per-call args. **URL-only — no override.**

### 4.4 `application_name` per connection

When a `locks:*` tool acquires a connection from the pool, it sets:

```sql
SET LOCAL application_name = 'papercusp-su:' || $owner_id;
```

at the top of every transaction. `pg_stat_activity` becomes a free per-agent diagnostic view.

---

## 5. Tool surface — 5 verbs

All in `apps/operator/lib/agent-tools/locks/`, registered via `defineTool`.

### 5.1 `locks:acquire`

```typescript
{
  paths: string[];                              // repo-relative; sorted+deduped server-side
  intent: string;                               // ≤200 chars
  ttl_sec?: number;                             // default 1200, max 3600
  wait?: { max_sec: number };                   // optional; max 300
}
->
  | { ok: true; lock_id: string; expires_ts: number; held: string[]; waited_sec?: number }
  | { ok: false; busy: BusyRow[]; ticket_id?: string; reason?: 'waiter_cap_exceeded' }

BusyRow = { path; owner_label; intent; expires_ts; ticket_position?: number }
```

`ticket_position` (if present) tells the caller how far back in the queue they would have been.

### 5.2 `locks:release`

```typescript
{
  lock_id?: string;
  paths?: string[];          // optional filter when lock_id is set
  all_mine?: boolean;        // release every lock owned by ctx.owner
}
-> { released: string[] }
```

Exactly one of `lock_id` / `all_mine` required. Release runs the grant cascade (§7.2) inside the same transaction.

### 5.3 `locks:heartbeat`

```typescript
{
  lock_id: string;
  ttl_sec?: number;          // default = original ttl
}
-> { expires_ts: number; extended: boolean }   // extended=false if stolen
```

### 5.4 `locks:cancel_wait`

```typescript
{ ticket_id: string }
-> { cancelled: boolean }    // false if already granted (race)
```

If `cancelled: false`, the agent **must immediately** call `locks:release { all_mine: true }` — they were granted a lock between deciding to cancel and the cancel landing. Spelled out in the playbook.

### 5.5 `locks:queue`

```typescript
{
  paths?: string[];
  owner?: string;
  include_completed?: boolean;  // default false; includes terminal rows from last 24h
}
-> {
  active_locks: LockRow[];
  waiting: Array<{ ticket_id; owner_label; paths; intent; queued_ts; wait_until; ahead_count }>;
  completed?: WaiterRow[];
}
```

`ahead_count` computed via `ROW_NUMBER() OVER (ORDER BY queued_ts ASC) - 1`.


---

## 6. Concurrency model — `pg_advisory_xact_lock` per workspace

The entire model in 6 lines:

```ts
async function inWorkspaceTxn<T>(workspaceId: string, ownerId: string, fn: (tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL application_name = ${'papercusp-su:' + ownerId}`;
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '5s'`;   // per-op override below
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'su:' + workspaceId}))`;
    return fn(tx);
  });
}
```

Every state-mutating tool wraps its work in `inWorkspaceTxn`. The wrapper provides:

- **Serialization** — within a workspace, operations strictly order. Across workspaces, they're independent.
- **Timeout safety net** — `lock_timeout` (advisory-lock acquisition) + `statement_timeout` (query execution).
- **Diagnostic naming** — `pg_stat_activity` shows what every agent is doing.

Isolation level: **`READ COMMITTED`** (PG default). The advisory lock IS the serialization point; no need for `SERIALIZABLE`. No app-side retry logic on `40001`.

### 6.1 Per-operation `statement_timeout` overrides

```
acquire     : 500ms    (user-facing)
heartbeat   : 500ms    (user-facing)
cancel_wait : 500ms    (user-facing)
queue       : 1000ms   (may scan many rows)
release     : 5000ms   (cascade can iterate up to MAX_WAITERS_PER_OWNER × N workspaces)
```

`SET LOCAL statement_timeout = '500ms'` inside each tool's handler after `inWorkspaceTxn` opens.

### 6.2 Why this is correct

- All state mutations on `agent_file_locks` and `agent_lock_waiters` go through `inWorkspaceTxn`.
- The advisory lock serializes the **transactions themselves**, not just statements within a transaction.
- Inside a serialized transaction, `READ COMMITTED` is sufficient because there are no concurrent writers to race with.
- Read-only tools (`locks:queue`) don't take the advisory lock — they see a consistent snapshot via PG's MVCC and don't need to serialize against writers.

### 6.3 Failure modes

- **Stuck advisory-lock holder** → `lock_timeout = '5s'` aborts new acquirers with a clear error.
- **Wedged session with open transaction** → `idle_in_transaction_session_timeout = '30s'` at role level kills it, releasing the advisory lock.
- **Application crash mid-transaction** → connection close releases advisory lock immediately (advisory locks are connection-scoped).

---

## 7. Core algorithms

### 7.1 `acquire` (no wait)

```sql
-- Inside inWorkspaceTxn(workspaceId, ownerId)
SET LOCAL statement_timeout = '500ms';

-- Step 1: head-waiter check (anti-starvation)
SELECT 1 FROM agent_lock_waiters
 WHERE workspace_id = $1
   AND status = 'waiting'
   AND paths && $2::text[]            -- overlap with what we want
   AND queued_ts < clock_timestamp()
 LIMIT 1;
-- If exists, raise app-side: { ok: false, busy: <snapshot> }

-- Step 2: upsert all paths atomically; ON CONFLICT only steals expired locks
WITH wanted AS (SELECT unnest($2::text[]) AS path),
upsert AS (
  INSERT INTO agent_file_locks (workspace_id, path, owner, owner_label, intent, expires_ts)
  SELECT $1, w.path, $3, $4, $5, clock_timestamp() + ($6 || ' seconds')::interval
  FROM wanted w
  ON CONFLICT (workspace_id, path) DO UPDATE
    SET owner       = excluded.owner,
        owner_label = excluded.owner_label,
        intent      = excluded.intent,
        lock_id     = gen_random_uuid(),
        acquired_ts = clock_timestamp(),
        expires_ts  = excluded.expires_ts
    WHERE agent_file_locks.expires_ts <= clock_timestamp()
  RETURNING path, lock_id, expires_ts
)
SELECT
  -- Won rows
  (SELECT array_agg(path) FROM upsert) AS held,
  -- Lost rows (still owned by someone else)
  (SELECT json_agg(json_build_object(
     'path', l.path, 'owner_label', l.owner_label,
     'intent', l.intent, 'expires_ts', l.expires_ts))
   FROM agent_file_locks l, wanted w
   WHERE l.workspace_id = $1 AND l.path = w.path
     AND l.path NOT IN (SELECT path FROM upsert)
  ) AS busy;
```

If `busy` is non-null: app rolls back, returns `{ ok: false, busy }`. The CTE-with-RETURNING pattern keeps it to one round trip.

If `busy` is null: commit, return `{ ok: true, lock_id, expires_ts, held }`.

Note: all winning paths share the same `lock_id` because we want a single token for release. Implementation detail: instead of `gen_random_uuid()` per row, generate one in the app, pass as `$7`, use in both INSERT branch and ON CONFLICT branch.

### 7.2 `release` (with grant cascade)

```sql
-- Inside inWorkspaceTxn
SET LOCAL statement_timeout = '5s';

-- Delete this lock_id's rows
WITH deleted AS (
  DELETE FROM agent_file_locks
   WHERE workspace_id = $1
     AND lock_id = $2
     AND ($3::boolean OR path = ANY($4::text[]))   -- $3 = all_mine, $4 = path filter
  RETURNING path
)
SELECT array_agg(path) FROM deleted;

-- Run cascade
SELECT * FROM grant_cascade($1, clock_timestamp());

-- For each granted waiter from the cascade, NOTIFY
-- (app-side loop, one NOTIFY per granted ticket)
```

The PL/pgSQL function:

```sql
CREATE FUNCTION grant_cascade(p_workspace_id text, p_now timestamptz)
RETURNS TABLE(ticket_id uuid, granted_lock_id uuid, paths text[], owner text)
LANGUAGE plpgsql AS $func$
DECLARE
  v_waiter   record;
  v_new_lock uuid;
  v_expires  timestamptz;
  v_conflict integer;
BEGIN
  FOR v_waiter IN
    SELECT w.* FROM agent_lock_waiters w
     WHERE w.workspace_id = p_workspace_id
       AND w.status = 'waiting'
       AND w.wait_until > p_now
     ORDER BY w.queued_ts ASC
  LOOP
    BEGIN
      -- Conflict check
      SELECT count(*) INTO v_conflict
        FROM agent_file_locks l
       WHERE l.workspace_id = p_workspace_id
         AND l.path = ANY(v_waiter.paths)
         AND l.expires_ts > p_now;
      IF v_conflict > 0 THEN
        CONTINUE;
      END IF;

      v_new_lock := gen_random_uuid();
      v_expires  := p_now + (v_waiter.ttl_sec || ' seconds')::interval;

      INSERT INTO agent_file_locks
        (workspace_id, path, owner, owner_label, intent, lock_id, acquired_ts, expires_ts)
      SELECT p_workspace_id, p, v_waiter.owner, v_waiter.owner_label, v_waiter.intent,
             v_new_lock, p_now, v_expires
        FROM unnest(v_waiter.paths) AS p
        ON CONFLICT DO NOTHING;

      UPDATE agent_lock_waiters
         SET status = 'granted',
             granted_lock_id = v_new_lock,
             granted_expires_ts = v_expires
       WHERE agent_lock_waiters.ticket_id = v_waiter.ticket_id;

      ticket_id := v_waiter.ticket_id;
      granted_lock_id := v_new_lock;
      paths := v_waiter.paths;
      owner := v_waiter.owner;
      RETURN NEXT;
    EXCEPTION
      WHEN no_data_found THEN CONTINUE;
      WHEN unique_violation THEN CONTINUE;
    END;
  END LOOP;
  RETURN;
END;
$func$;
```

`EXCEPTION` blocks ensure a single waiter vanishing (force-deleted, cancelled mid-cascade) doesn't abort the whole transaction.

### 7.3 Head-waiter blocks new acquires (anti-starvation)

Step 1 of `acquire` (§7.1). If any older waiter overlaps the new acquirer's paths, reject the new acquirer with `busy` even if the paths are free. Bounded delay: `max_sec + max(TTL)`.


### 7.4 `acquire` with `wait` — LISTEN-before-INSERT protocol

The exact ordering matters; getting it wrong opens a lost-wakeup window. The 7-step protocol:

```
1. LISTEN ch_workspace_<wsId>     -- on dedicated long-lived connection;
                                     outside any transaction
2. inWorkspaceTxn: try acquire (§7.1)
   - if granted: UNLISTEN; return ok
3. inWorkspaceTxn: INSERT INTO waiters; check waiter cap
   - if cap exceeded: UNLISTEN; return { ok: false, reason: 'waiter_cap_exceeded' }
4. inWorkspaceTxn: SELECT my row's status
   - if 'granted' already (race during 3): UNLISTEN; return ok
5. await notification on the LISTEN connection (with timeout = wait_until - now)
6. on wake: inWorkspaceTxn: SELECT my row's status
   - if 'granted': UNLISTEN; return ok
   - if still 'waiting': GOTO 5 (re-await with remaining timeout)
7. on timeout: inWorkspaceTxn: UPDATE waiters SET status='expired';
   UNLISTEN; return { ok: false, busy: <snapshot>, ticket_id }
```

The critical ordering: **LISTEN comes before the INSERT**. PG buffers notifications between LISTEN and the first poll, so a grant that fires between steps 3 and 5 is not lost — step 5 sees the queued notification immediately.

#### 7.4a LISTEN connection lifecycle (per-workspace, refcounted)

```ts
class WorkspaceListener {
  static refcounts = new Map<string, number>();
  static conns = new Map<string, Connection>();

  static async acquire(workspaceId: string): Promise<Connection> {
    const cur = WorkspaceListener.refcounts.get(workspaceId) ?? 0;
    if (cur === 0) {
      const conn = await pool.reserve();   // dedicated long-lived connection
      await conn`LISTEN ${conn(`ch_workspace_${workspaceId}`)}`;
      WorkspaceListener.conns.set(workspaceId, conn);
    }
    WorkspaceListener.refcounts.set(workspaceId, cur + 1);
    return WorkspaceListener.conns.get(workspaceId)!;
  }

  static async release(workspaceId: string) {
    const cur = WorkspaceListener.refcounts.get(workspaceId) ?? 0;
    if (cur <= 1) {
      const conn = WorkspaceListener.conns.get(workspaceId);
      if (conn) {
        await conn`UNLISTEN ${conn(`ch_workspace_${workspaceId}`)}`;
        await conn.release();
      }
      WorkspaceListener.conns.delete(workspaceId);
      WorkspaceListener.refcounts.delete(workspaceId);
    } else {
      WorkspaceListener.refcounts.set(workspaceId, cur - 1);
    }
  }
}
```

Notification handler demuxes by `ticket_id` payload:

```ts
const conn = await WorkspaceListener.acquire(workspaceId);
const waiters = new Map<string, (status: string) => void>();
conn.on('notification', (msg) => {
  const [ticketId, kind] = msg.payload.split(':');
  waiters.get(ticketId)?.(kind);
});
```

#### 7.4b Waiter cap

Inside step 3:

```sql
WITH cur AS (
  SELECT count(*) AS n FROM agent_lock_waiters
   WHERE owner = $1 AND status = 'waiting'
)
SELECT n >= 10 AS at_cap FROM cur;
```

If `at_cap`, app returns `{ ok: false, reason: 'waiter_cap_exceeded' }` without inserting. Per-owner cap (10), not per-workspace — a runaway agent fails loudly without breaking other agents' queues.

#### 7.4c Adaptive timeout in step 5

Single `await` with `Promise.race([notificationPromise, timeoutPromise])`. No adaptive polling needed — LISTEN/NOTIFY pushes events. Server-side timeout is set once to `wait_until - now`.

`ctx.progress` events fire at a slow heartbeat (every 10s) for the agent's display, independent of the wake mechanism. Each progress event reads the current `busy` snapshot for the agent's UX:

```ts
const progressTimer = setInterval(async () => {
  const snap = await readBusySnapshot(workspaceId, paths);
  ctx.progress(elapsed_sec, JSON.stringify({
    phase: 'waiting',
    ticket_id,
    elapsed_sec,
    ahead_count: snap.ahead,
    busy: snap.rows,
  }));
}, 10_000);
```

Cleared on wake / cancel / timeout.

### 7.5 `cancel_wait`

```sql
-- Inside inWorkspaceTxn
UPDATE agent_lock_waiters
   SET status = 'cancelled'
 WHERE ticket_id = $1 AND status = 'waiting'
 RETURNING ticket_id;
```

Returns `{ cancelled: true }` if a row was updated; `{ cancelled: false }` otherwise. If `false`, the playbook says: immediately call `locks:release { all_mine: true }` (you were granted; lock is yours and unwanted).

### 7.6 `heartbeat`

```sql
-- Inside inWorkspaceTxn
UPDATE agent_file_locks
   SET expires_ts = clock_timestamp() + ($2 || ' seconds')::interval
 WHERE lock_id = $1
   AND expires_ts > clock_timestamp()
 RETURNING expires_ts;
```

`extended: false` (no row returned) means the lock had already been stolen.

### 7.7 Janitor

Runs at the top of every `acquire`, `release`, `heartbeat` call inside its `inWorkspaceTxn`:

```sql
DELETE FROM agent_file_locks WHERE expires_ts <= clock_timestamp();
DELETE FROM agent_lock_waiters
 WHERE status IN ('granted','expired','cancelled')
   AND queued_ts < clock_timestamp() - interval '24 hours';
```

Stale-lock deletion is technically redundant with the grant cascade's freshness check, but it keeps `locks:queue` output clean and bounds table growth.


---

## 8. Connection management

Two pools, both connecting to `papercusp_su`:

- **`txPool`**: short-lived connections for state-mutating transactions. Standard postgres-js pool, size ~10.
- **`listenerPool`**: dedicated long-lived connections for LISTEN/NOTIFY. Reserved via `pool.reserve()`, one per active workspace. Released back when refcount hits zero.

Resolved from `~/.papercusp/embedded-pg.json` + `~/.papercusp/su-db-password`. Bootstrapped lazily on first `locks:*` call.

---

## 9. Policy & playbook updates

### 9.1 `apps/operator/prompts/papercusp-su.tools.md`

Add a new workflow:

> ### Before editing any file, claim it
>
> 1. **Acquire** the file set you're about to edit:
>    ```
>    locks:acquire {
>      paths: ['<repo-rel-path>', ...],
>      intent: '<one-line what you're doing>',
>      ttl_sec: 1200,
>      wait: { max_sec: 300 }
>    }
>    ```
> 2. **On `ok: true`**: edit, commit, then `locks:release { lock_id }`. For edits >15 min, heartbeat once at the halfway mark.
> 3. **On `ok: false` (wait timed out)**: the response tells you what's still busy and gives you a `ticket_id`. Decide:
>    - **Retry**: call `acquire` again — you get a new spot in the queue.
>    - **Pivot**: do other work; come back later.
>    - **Yield to user**: "Agent X has `lib/foo.ts` for 'fix typo in comment' (held 8min, expires in 22min). I want to do 'refactor entire auth module'. Want me to wait, do something else, or coordinate?" *Always show both intents — holder's and yours — so the user can decide.*
> 4. **`reason: 'waiter_cap_exceeded'`**: you have 10 active waits already; something is wrong with your loop. Stop, audit your in-flight tickets via `locks:queue { owner: <self> }`, cancel stale ones.
> 5. **`cancel_wait` returns `cancelled: false`**: grant raced your cancel. You hold a lock you don't want. Immediately `locks:release { all_mine: true }`.
> 6. **Crash safety**: locks expire on TTL. No cleanup needed.
> 7. **Inspecting other agents**: `locks:queue` is readable. Use it if the user asks "what are the other agents doing?"

### 9.2 `apps/operator/content/docs/agent-policies.mdx`

Add a new section after §6 (Reuse before adding), before §7 (Confirm before destructive):

> ## 7. Coordinate edits across SU agents
>
> Multiple OMP shells may be open at once, each driving its own SU agent. Before any edit:
>
> 1. Always call `locks:acquire { paths, intent, wait: { max_sec: 300 } }` for files you're about to touch.
> 2. On busy: wait, retry, pivot, or surface to the user — never stomp.
> 3. Release on completion. Heartbeat once at the halfway mark for edits >15 min.
>
> Prevention over reconciliation: cheaper to wait 30s for a file to free than to discover at merge time that two agents wrote different fixes for the same bug.
>
> The cooperative tool surface is universal. **Claude Code** users additionally get enforcement via a `PreToolUse` hook that calls `locks:acquire { wait: { max_sec: 0 } }` before any `Edit/Write/MultiEdit` and refuses on busy. Other host CLIs (OMP, Codex, Gemini) rely on the playbook discipline until their own hook recipes ship.
>
> See [the playbook](#) and the `locks:*` tool reference.

Renumber subsequent sections.

### 9.3 Claude Code PreToolUse hook

`apps/operator/scripts/hooks/pretooluse-locks-acquire.sh` — invoked by Claude Code before every `Edit`/`Write`/`MultiEdit`. Reads the target paths from hook input, posts to `papercusp-su` with `wait: { max_sec: 0 }`, exits 0 on success, exits with stderr message on busy. `install-standalone-mcp.sh` writes the hook config block to `~/.claude/settings.json` alongside the MCP server config.

PostToolUse hook releases on edit completion (best-effort, idempotent — `all_mine: true` covers missed releases).

OMP/Codex/Gemini equivalents are documented as TODO recipes in the hook directory's README.

---

## 10. Testing strategy

### 10.1 Unit tests — PL/pgSQL and store layer

In `apps/operator/lib/agent-tools/locks/su-lock-store.test.ts`, against a disposable embedded PG instance per test:

- `acquire_single_path_free` → ok
- `acquire_set_all_free` → ok, all rows present
- `acquire_set_one_busy` → busy, no partial state (verify zero rows for our lock_id)
- `acquire_stale_lock` → steals, returns ok
- `acquire_paths_validation` → rejects absolute, `..`, empty
- `release_with_paths_filter` → only matching paths gone
- `release_grants_first_waiter` → waiter status='granted', lock row exists
- `release_skips_blocked_waiter_resumes_later` → waiter still 'waiting' when conflict remains
- `release_grant_cascade_continues_past_vanished_waiter` → EXCEPTION block does its job
- `head_waiter_blocks_new_acquire` → new acquire returns busy even when path free
- `heartbeat_extends_live_lock` → expires_ts updates, extended:true
- `heartbeat_after_steal` → extended:false
- `cancel_wait_active` → cancelled:true
- `cancel_wait_after_grant` → cancelled:false (race)
- `waiter_cap_exceeded` → 11th wait per owner returns reason
- `janitor_cleans_stale_and_terminal` → both tables shrink
- `migrations_idempotent` → run twice, schema stable

~30 tests.

### 10.2 Real cross-process concurrency test

In `apps/operator/lib/agent-tools/locks/concurrent-cross-process.test.ts`:

Spawn **3–4 child Node processes**, each with its own postgres-js connection to the same `papercusp_su`. Each child runs randomized acquire/release loops over a shared path pool. Driver process asserts:

- No path ever has >1 active holder.
- FIFO order observable in grant cascades (queued_ts ordering preserved).
- No deadlock — every child completes ≥N operations in T seconds.
- Released locks granted within ~50ms of release (LISTEN/NOTIFY wake latency).

Run 100 iterations with random schedules and path overlap. This is the test that actually exercises cross-process semantics; the `Promise.all` pattern from v1/v2 is replaced because better-sqlite3 sync API serialized at the JS event loop.

### 10.3 LISTEN/NOTIFY wake-latency test

Dedicated test: agent A holds lock, agent B (separate process) acquires-with-wait, agent A releases. Assert B wakes within 50ms (well under the 200ms-5s polling worst case).

### 10.4 End-to-end MCP test

In `apps/operator/e2e/su-locks.spec.ts`: two child processes acting as SU shells through actual `papercusp-su` HTTP MCP transport. Validates the whole stack including ctx threading, progress events, hook integration.

### 10.5 Manual smoke

Documented in `apps/operator/lib/agent-tools/locks/README.md`:

```
Terminal A: omp, "claim apps/operator/lib/foo.ts for 60s, do nothing, release"
Terminal B: omp, "claim apps/operator/lib/foo.ts wait=120s"
Expect: B shows 'waiting on foo.ts, held by claude-code@host:term-A, expires in ~50s'
        then auto-resolves on A's release within ~50ms.
```

