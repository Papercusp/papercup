/**
 * session-audit.integration.test.ts — real-Postgres regression for WI-4958's
 * PG-backed digest halves: `readFailedCallRows` (feeds both invalid-call
 * clustering and recurring-friction), `readGateTransitions`, and the requested
 * (disciplined-path) half of `readCompactionAudit`. The FS transcript-scan half
 * of readCompactionAudit is exercised directly against real temp files in
 * session-audit.test.ts (no PG needed there) — this file only pins the SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readCompactionAudit, readFailedCallRows, readGateTransitions } from './session-audit';

const TOOL_INVOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    harness_slug    text NOT NULL DEFAULT 'papercusp',
    plugin_name     text NOT NULL DEFAULT 'test',
    tool_name       text NOT NULL,
    role            text NOT NULL DEFAULT 'operator',
    spawn_id        text NOT NULL DEFAULT 'spawn-test',
    window_key      text NOT NULL DEFAULT 'window-test',
    invoked_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL,
    error_message   text,
    coord_owner_id  text
  );`;

const ADV_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    mode            text NOT NULL DEFAULT 'console',
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    coord_owner_id  text,
    agent           text,
    session_id      text
  );`;

const PIPELINE_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.pipeline_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    install_slug text NOT NULL,
    kind         text NOT NULL,
    status       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  );`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('session-audit');
  await db.sql.unsafe(TOOL_INVOCATIONS_DDL);
  await db.sql.unsafe(ADV_SESSIONS_DDL);
  await db.sql.unsafe(PIPELINE_EVENTS_DDL);
}, 90_000);

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.tool_invocations`;
  await db.sql`DELETE FROM harness_shared.adv_sessions`;
  await db.sql`DELETE FROM harness_shared.pipeline_events`;
});

afterAll(async () => {
  await db?.cleanup();
});

describe('readFailedCallRows', () => {
  it('reads failed calls scoped to workspace + harness, excluding ok rows and rows with no owner', async () => {
    await db.sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, status, coord_owner_id, error_message)
      VALUES
        ('ws-1', 'papercusp', 'docs:get', 'error', 'su-a', 'boom'),
        ('ws-1', 'papercusp', 'docs:get', 'ok', 'su-a', NULL),
        ('ws-1', 'papercusp', 'docs:get', 'error', NULL, 'no owner — must be excluded'),
        ('ws-1', 'other-harness', 'docs:get', 'error', 'su-a', 'wrong harness — must be excluded'),
        ('ws-2', 'papercusp', 'docs:get', 'error', 'su-a', 'wrong workspace — must be excluded')
    `;

    const rows = await readFailedCallRows(db.sql, { workspaceId: 'ws-1', surveySlugs: ['papercusp'], windowHours: 24 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: 'su-a', toolName: 'docs:get', errorMessage: 'boom' });
  });

  it('excludes rows outside the window', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    await db.sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, status, coord_owner_id, error_message, invoked_at)
      VALUES ('ws-1', 'papercusp', 'docs:get', 'error', 'su-a', 'stale', ${twoDaysAgo})
    `;

    const rows = await readFailedCallRows(db.sql, { workspaceId: 'ws-1', surveySlugs: ['papercusp'], windowHours: 24 });
    expect(rows).toEqual([]);
  });
});

describe('readGateTransitions', () => {
  it('reads green_checkpoint and deploy events for the pot, newest first, ignoring other kinds', async () => {
    await db.sql`
      INSERT INTO harness_shared.pipeline_events (install_slug, kind, status, created_at)
      VALUES
        ('papercusp', 'green_checkpoint', 'advanced', now() - interval '2 hours'),
        ('papercusp', 'deploy', 'ok', now() - interval '1 hour'),
        ('papercusp', 'green_checkpoint', 'red', now()),
        ('papercusp', 'something-else', 'n/a', now()),
        ('other-pot', 'deploy', 'ok', now())
    `;

    const transitions = await readGateTransitions(db.sql, { potSlug: 'papercusp', windowHours: 24 });

    expect(transitions).toHaveLength(3);
    expect(transitions.map((t) => t.status)).toEqual(['red', 'ok', 'advanced']); // newest first
    expect(transitions.every((t) => ['green_checkpoint', 'deploy'].includes(t.kind))).toBe(true);
  });
});

describe('readCompactionAudit', () => {
  it('sums requested compactions per owner, scoped to workspace + window', async () => {
    await db.sql`
      INSERT INTO harness_shared.tool_invocations (workspace_id, tool_name, status, coord_owner_id)
      VALUES
        ('ws-1', 'session:request-compaction', 'ok', 'su-a'),
        ('ws-1', 'session:request-compaction', 'ok', 'su-a'),
        ('ws-1', 'session:request-compaction', 'ok', 'su-b'),
        ('ws-1', 'session:request-compaction', 'error', 'su-a'),
        ('ws-2', 'session:request-compaction', 'ok', 'su-c')
    `;

    const audit = await readCompactionAudit(db.sql, { workspaceId: 'ws-1', windowHours: 24 });

    expect(audit.requestedTotal).toBe(3);
    // No adv_sessions rows seeded → no scan candidates, no native evidence.
    expect(audit.sessionsCandidates).toBe(0);
    expect(audit.nativeTotal).toBe(0);
    expect(audit.disciplinedRatio).toBeNull();
  });

  it('resolves scan candidates from adv_sessions (Claude-only, most-recent per owner) but degrades cleanly with no real transcript on disk', async () => {
    await db.sql`
      INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, agent, session_id, started_at)
      VALUES
        ('ws-1', 'su-a', 'claude', 'nonexistent-session-aaaa111111', now()),
        ('ws-1', 'su-b', 'omp', 'omp-thread-xyz', now())
    `;

    const audit = await readCompactionAudit(db.sql, { workspaceId: 'ws-1', windowHours: 24 });

    // Only the claude session is a candidate — omp is excluded (v1 scope).
    expect(audit.sessionsCandidates).toBe(1);
    // The transcript does not exist on this test host → scan error, not a false 0.
    expect(audit.scanErrors).toBe(1);
    expect(audit.sessionsScanned).toBe(0);
    expect(audit.perSession[0]).toMatchObject({ ownerId: 'su-a', nativeDetected: null });
    expect(audit.perSession[0].scanError).toBeTruthy();
  });

  it('caps the number of transcripts scanned and reports the overflow via sessionsSkippedCap', async () => {
    for (let i = 0; i < 5; i++) {
      await db.sql`
        INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, agent, session_id, started_at)
        VALUES ('ws-1', ${`su-${i}`}, 'claude', ${`nonexistent-session-${i}`}, now())
      `;
    }

    const audit = await readCompactionAudit(db.sql, { workspaceId: 'ws-1', windowHours: 24, maxSessions: 2 });

    expect(audit.sessionsCandidates).toBe(5);
    expect(audit.perSession).toHaveLength(2);
    expect(audit.sessionsSkippedCap).toBe(3);
  });
});
