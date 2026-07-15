/**
 * soak-report.integration.test.ts — real-Postgres regression for EI-12456: the
 * context-burn wake meter (`readContextBurnMetrics`, extracted out of
 * `readPotSoakReport`) must count `event_wake_deliveries` rows even when the
 * pot's own `activeWorkspaceId()` differs from the row's stamped workspace_id.
 *
 * Root cause: `event_wake_deliveries` is a single flat plane (WI-3575) — every
 * row is stamped `workspace_id = DEFAULT_COORD_WORKSPACE` ('default')
 * regardless of which pot's loop actually fired the wake. The pre-fix query
 * filtered by the caller's real `workspaceId` (e.g. 'papercusp-workspace'),
 * which NEVER matches a 'default'-stamped row — so `loopWakes` silently read 0
 * even with real, successfully-delivered fires. This test seeds a row with
 * workspace_id='default' and calls readContextBurnMetrics with a DIFFERENT
 * workspaceId, proving the fix reads real rows despite the mismatch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readContextBurnMetrics } from './soak-report';

const readMigration = (f: string) =>
  readFileSync(join(__dirname, '../../../../libs/papercusp/libs/db/sql', f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

/** Minimal tool_invocations shape (migration 000-baseline.sql + 427's
 *  coord_owner_id column) — only the columns readContextBurnMetrics' compaction
 *  half actually reads. */
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

let db: FreshPgDb;

async function seedWakeDelivery(opts: {
  workspaceId: string;
  eventKey?: string;
  summary?: string;
  createdAt?: Date;
}) {
  await db.sql`
    INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, summary, status, created_at)
    VALUES (${opts.workspaceId}, 1, 'test-subscriber', ${opts.eventKey ?? 'coord:inbox-wake:test-owner'},
            ${opts.summary ?? 'a wake summary'}, 'delivered', ${opts.createdAt ?? new Date()})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('soak-report');
  // event_wake_deliveries — migration 163 (table + indexes; strip GRANT/meta).
  await db.sql.unsafe(readMigration('163-await-event-subscriptions.sql'));
  await db.sql.unsafe(TOOL_INVOCATIONS_DDL);
}, 90_000);

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.event_wake_deliveries`;
  await db.sql`DELETE FROM harness_shared.tool_invocations`;
});

afterAll(async () => {
  await db.cleanup();
});

describe('readContextBurnMetrics', () => {
  it('EI-12456: counts a wake delivery stamped DEFAULT_COORD_WORKSPACE even when the pot workspace differs', async () => {
    await seedWakeDelivery({ workspaceId: DEFAULT_COORD_WORKSPACE, summary: 'x'.repeat(100) });

    const metrics = await readContextBurnMetrics(db.sql, {
      workspaceId: 'papercusp-workspace', // deliberately NOT 'default'
      windowHours: 24,
    });

    expect(metrics.loopWakes).toBe(1);
    expect(metrics.meanWakeChars).toBe(100);
    expect(metrics.maxWakeChars).toBe(100);
  });

  it('does NOT match a row filtered against the real pot workspace (proves the pre-fix bug, if it regresses)', async () => {
    await seedWakeDelivery({ workspaceId: DEFAULT_COORD_WORKSPACE });

    // Sanity: a query hand-filtered on the pot's real workspaceId directly
    // against the table (the old, broken behavior) matches nothing.
    const rows = await db.sql`
      SELECT count(*)::int AS n FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = 'papercusp-workspace' AND event_key LIKE 'coord:inbox-wake:%'`;
    expect(Number(rows[0]?.n ?? -1)).toBe(0);
  });

  it('ignores a wake row whose event_key is not an inbox-wake delivery', async () => {
    await seedWakeDelivery({ workspaceId: DEFAULT_COORD_WORKSPACE, eventKey: 'work-item:claimable' });

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.loopWakes).toBe(0);
    expect(metrics.meanWakeChars).toBeNull();
  });

  it('excludes a wake row outside the window', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    await seedWakeDelivery({ workspaceId: DEFAULT_COORD_WORKSPACE, createdAt: twoDaysAgo });

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.loopWakes).toBe(0);
  });

  it('counts requested compactions scoped to the REAL pot workspace (unaffected by the wake-plane fix)', async () => {
    await db.sql`
      INSERT INTO harness_shared.tool_invocations (workspace_id, tool_name, status, coord_owner_id)
      VALUES ('papercusp-workspace', 'session:request-compaction', 'ok', 'su-owner-1')`;
    // A different workspace's compaction must NOT be counted.
    await db.sql`
      INSERT INTO harness_shared.tool_invocations (workspace_id, tool_name, status, coord_owner_id)
      VALUES ('other-workspace', 'session:request-compaction', 'ok', 'su-owner-2')`;

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.requestedCompactions).toBe(1);
    expect(metrics.sessionsCompacting).toBe(1);
  });

  it('counts a post-compaction error marker within the attribution window for the same owner', async () => {
    await db.sql`
      INSERT INTO harness_shared.tool_invocations (workspace_id, tool_name, status, coord_owner_id, invoked_at)
      VALUES ('papercusp-workspace', 'session:request-compaction', 'ok', 'su-owner-1', now())`;
    await db.sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, tool_name, status, coord_owner_id, invoked_at, error_message)
      VALUES ('papercusp-workspace', 'docs:get', 'error', 'su-owner-1', now() + interval '2 minutes',
              'relation "harness_shared.foo" does not exist')`;

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.postCompactionErrorMarkers).toBe(1);
  });
});
