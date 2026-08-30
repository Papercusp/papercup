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
 *
 * WI-4958: also regresses the `source`-scoping fix — `loopWakes`/`meanWakeChars`/
 * `maxWakeChars` must count ONLY deliveries whose `source` carries the
 * LOOP_WAKE_SOURCE_PREFIX ('loop:') stamp (genuine engine-loop kickoffs), not
 * every coord:inbox-wake:% delivery regardless of source (which silently mixed
 * in short-summary peer coord:send wakes and skewed the WAKE_MEAN_CHAR_BUDGET
 * gate). `nonLoopInboxWakes` must count the excluded population instead of
 * dropping it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readContextBurnMetrics } from './soak-report';
import { LOOP_WAKE_SOURCE_PREFIX } from '../agent-tools/coordination/inbox-wake';

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
  /** WI-4958: the emit-time attribution (migration 387). A loop-fire kickoff
   *  stamps `loop:<routineId>`; an ordinary coord:send wake stamps the sender's
   *  ownerId. Omitted ⇒ NULL (an unattributed row, counted in neither bucket). */
  source?: string | null;
}) {
  await db.sql`
    INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, summary, status, created_at, source)
    VALUES (${opts.workspaceId}, 1, 'test-subscriber', ${opts.eventKey ?? 'coord:inbox-wake:test-owner'},
            ${opts.summary ?? 'a wake summary'}, 'delivered', ${opts.createdAt ?? new Date()}, ${opts.source ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('soak-report');
  // event_wake_deliveries — migration 163 (table + indexes; strip GRANT/meta).
  await db.sql.unsafe(readMigration('163-await-event-subscriptions.sql'));
  // WI-4958: migration 387 adds the `source` column readContextBurnMetrics now
  // filters on (loop-wake scoping) — apply it so the ephemeral test schema
  // matches production, not just the 163 baseline.
  await db.sql.unsafe(readMigration('387-event-wake-delivery-source.sql'));
  await db.sql.unsafe(TOOL_INVOCATIONS_DDL);
}, 90_000);

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.event_wake_deliveries`;
  await db.sql`DELETE FROM harness_shared.tool_invocations`;
});

afterAll(async () => {
  await db?.cleanup();
});

describe('readContextBurnMetrics', () => {
  it('EI-12456: counts a wake delivery stamped DEFAULT_COORD_WORKSPACE even when the pot workspace differs', async () => {
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      summary: 'x'.repeat(100),
      source: `${LOOP_WAKE_SOURCE_PREFIX}test-routine`,
    });

    const metrics = await readContextBurnMetrics(db.sql, {
      workspaceId: 'papercusp-workspace', // deliberately NOT 'default'
      windowHours: 24,
    });

    expect(metrics.loopWakes).toBe(1);
    expect(metrics.meanWakeChars).toBe(100);
    expect(metrics.maxWakeChars).toBe(100);
  });

  it('does NOT match a row filtered against the real pot workspace (proves the pre-fix bug, if it regresses)', async () => {
    await seedWakeDelivery({ workspaceId: DEFAULT_COORD_WORKSPACE, source: `${LOOP_WAKE_SOURCE_PREFIX}x` });

    // Sanity: a query hand-filtered on the pot's real workspaceId directly
    // against the table (the old, broken behavior) matches nothing.
    const rows = await db.sql`
      SELECT count(*)::int AS n FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = 'papercusp-workspace' AND event_key LIKE 'coord:inbox-wake:%'`;
    expect(Number(rows[0]?.n ?? -1)).toBe(0);
  });

  it('ignores a wake row whose event_key is not an inbox-wake delivery', async () => {
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      eventKey: 'work-item:claimable',
      source: `${LOOP_WAKE_SOURCE_PREFIX}x`,
    });

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.loopWakes).toBe(0);
    expect(metrics.meanWakeChars).toBeNull();
  });

  it('excludes a wake row outside the window', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      createdAt: twoDaysAgo,
      source: `${LOOP_WAKE_SOURCE_PREFIX}x`,
    });

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.loopWakes).toBe(0);
  });

  // WI-4958: the accounting-repair regression. A plain coord:send wake (source =
  // the sender's ownerId, never the 'loop:' prefix) carries a short one-line
  // `summary` — it must NOT be counted into loopWakes/meanWakeChars/maxWakeChars
  // (the WAKE_MEAN_CHAR_BUDGET gate's intended population is loop kickoffs only),
  // but it must still be visible via nonLoopInboxWakes rather than silently
  // dropped.
  it('excludes a non-loop-sourced wake from loopWakes/meanWakeChars but counts it in nonLoopInboxWakes', async () => {
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      summary: 'x'.repeat(5000), // a big loop kickoff would look like this — must NOT count here
      source: 'su-some-owner-id', // a plain coord:send wake's source (the sender's ownerId)
    });

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.loopWakes).toBe(0);
    expect(metrics.meanWakeChars).toBeNull();
    expect(metrics.maxWakeChars).toBeNull();
    expect(metrics.nonLoopInboxWakes).toBe(1);
  });

  it('a mixed window averages meanWakeChars over LOOP wakes only, ignoring the non-loop population', async () => {
    // Two loop kickoffs (200 + 400 chars → mean 300) and one short peer coord:send
    // wake (20 chars) that must not dilute the average.
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      summary: 'x'.repeat(200),
      source: `${LOOP_WAKE_SOURCE_PREFIX}routine-a`,
    });
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      summary: 'x'.repeat(400),
      source: `${LOOP_WAKE_SOURCE_PREFIX}routine-b`,
    });
    await seedWakeDelivery({
      workspaceId: DEFAULT_COORD_WORKSPACE,
      summary: 'x'.repeat(20),
      source: 'su-peer-owner',
    });

    const metrics = await readContextBurnMetrics(db.sql, { workspaceId: 'papercusp-workspace', windowHours: 24 });

    expect(metrics.loopWakes).toBe(2);
    expect(metrics.meanWakeChars).toBe(300);
    expect(metrics.maxWakeChars).toBe(400);
    expect(metrics.nonLoopInboxWakes).toBe(1);
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
