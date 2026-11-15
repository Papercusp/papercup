/**
 * Real-Postgres regression for a work-item checkpoint statement timeout.
 *
 * This uses createFreshPgDb so the timeout is induced only in a disposable
 * database. It proves that PG 57014 aborts the checkpoint write without changing
 * the prior note, and that a retry succeeds after the transient condition clears.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// The host snapshot's tool-log tail is optional; keep this DB test focused on
// the real held-item reader and checkpoint writer rather than scanning activity.
vi.mock('./tool-call-log-store', () => ({ toolCallRowsFor: async () => [] }));
vi.mock('./tool-call-log', () => ({ renderToolCallLog: () => '' }));

const priorLockTimeout = process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
const priorStatementTimeout = process.env.PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS;
const priorWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = '100';
// pg-bounded-txn clamps this to 500ms; keeping the test budget local makes the
// real statement_timeout regression fast without changing production defaults.
process.env.PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS = '500';
process.env.PAPERCUSP_WORKSPACE_ID = 'default';

const { setWorkItemCheckpointWithPrior, getWorkItemCheckpoint, workItemCheckpointScope } =
  await import('./work-item-checkpoint');
const { OrgTxnTimeoutError } = await import('./pg-bounded-txn');
const { autoCheckpointStaleHeldItems, CheckpointSnapshotFailureError } =
  await import('./turn-end-tracking-io');

const HARNESS = 'checkpoint-timeout';
const ITEM = 'WI-PG-57014';

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('work-item-checkpoint-timeout');
  h.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
      workspace_id text NOT NULL,
      scope text NOT NULL,
      note text,
      journal jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_ts bigint NOT NULL,
      deps jsonb,
      body_ts bigint,
      attested_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, scope)
    )`);
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      item_kind text NOT NULL,
      taken_by text,
      last_progress_at timestamptz,
      title text,
      summary text,
      status text NOT NULL DEFAULT 'open',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_plan_slug text,
      source_plan_item_ids text[],
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    )`);
}, 60_000);

afterAll(async () => {
  if (priorLockTimeout === undefined) delete process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
  else process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = priorLockTimeout;
  if (priorStatementTimeout === undefined) delete process.env.PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS;
  else process.env.PAPERCUSP_COORD_WRITE_STATEMENT_TIMEOUT_MS = priorStatementTimeout;
  if (priorWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspace;
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe(`DROP TRIGGER IF EXISTS delay_checkpoint_write ON harness_shared.carry_notes`);
  await db.sql.unsafe(`DROP FUNCTION IF EXISTS harness_shared.delay_checkpoint_write()`);
  await db.sql`DELETE FROM harness_shared.carry_notes`;
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, taken_by)
    VALUES ('default', ${HARNESS}, ${ITEM}, 'bug', 'su-test-holder')`;
});

describe('work-item checkpoint store — real PG statement timeout', () => {
  it('returns typed PG 57014 without saving, then recovers on retry', async () => {
    const ref = { harness: HARNESS, workItemId: ITEM, workspaceId: 'default' };
    const original = 'prior checkpoint remains durable';
    await setWorkItemCheckpointWithPrior(ref, original);

    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.delay_checkpoint_write()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(2);
        RETURN NEW;
      END;
      $$`);
    await db.sql.unsafe(`
      CREATE TRIGGER delay_checkpoint_write
      BEFORE INSERT OR UPDATE ON harness_shared.carry_notes
      FOR EACH ROW EXECUTE FUNCTION harness_shared.delay_checkpoint_write()`);

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await setWorkItemCheckpointWithPrior(ref, 'timed-out replacement');
    } catch (error) {
      caught = error;
    } finally {
      await db.sql.unsafe(`DROP TRIGGER IF EXISTS delay_checkpoint_write ON harness_shared.carry_notes`);
      await db.sql.unsafe(`DROP FUNCTION IF EXISTS harness_shared.delay_checkpoint_write()`);
    }

    expect(caught).toBeInstanceOf(OrgTxnTimeoutError);
    expect(caught).toMatchObject({ pgCode: '57014' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await getWorkItemCheckpoint(ref)).toBe(original);

    const recovered = await setWorkItemCheckpointWithPrior(ref, 'retry after timeout');
    expect(recovered.stored).toBe('retry after timeout');
    expect(await getWorkItemCheckpoint(ref)).toBe('retry after timeout');
  });

  it('preserves the successful respawn prefix and authored notes when a later snapshot times out, then retries', async () => {
    const ownerId = 'su-host-snapshot-holder';
    const firstId = 'WI-PG-SNAPSHOT-Z-FIRST';
    const secondId = 'WI-PG-SNAPSHOT-A-SECOND';
    const firstRef = { harness: HARNESS, workItemId: firstId, workspaceId: 'default' };
    const secondRef = { harness: HARNESS, workItemId: secondId, workspaceId: 'default' };
    const firstAuthored = '## Did\nAuthored first checkpoint remains intact.';
    const secondAuthored = '## Did\nAuthored second checkpoint remains intact.';

    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, taken_by, title, summary)
      VALUES
        ('default', ${HARNESS}, ${firstId}, 'bug', ${ownerId}, 'first held item', 'first'),
        ('default', ${HARNESS}, ${secondId}, 'bug', ${ownerId}, 'second held item', 'second')`;
    await setWorkItemCheckpointWithPrior(firstRef, firstAuthored);
    await setWorkItemCheckpointWithPrior(secondRef, secondAuthored);

    const secondScope = workItemCheckpointScope(HARNESS, secondId);
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.delay_checkpoint_write()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.scope = '${secondScope}' THEN
          PERFORM pg_sleep(2);
        END IF;
        RETURN NEW;
      END;
      $$`);
    await db.sql.unsafe(`
      CREATE TRIGGER delay_checkpoint_write
      BEFORE INSERT OR UPDATE ON harness_shared.carry_notes
      FOR EACH ROW EXECUTE FUNCTION harness_shared.delay_checkpoint_write()`);

    const warningMessages: unknown[] = [];
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warningMessages.push(args[0]);
    });
    let caught: unknown;
    try {
      await autoCheckpointStaleHeldItems({
        ownerId,
        workspaceId: 'default',
        sessionId: 'host-snapshot-session',
        sinceIso: new Date(Date.now() - 60_000).toISOString(),
        journalNote: 'Initial mandatory host snapshot.',
        mode: 'respawn',
      });
    } catch (error) {
      caught = error;
    } finally {
      try {
        await db.sql.unsafe(`DROP TRIGGER IF EXISTS delay_checkpoint_write ON harness_shared.carry_notes`);
        await db.sql.unsafe(`DROP FUNCTION IF EXISTS harness_shared.delay_checkpoint_write()`);
      } finally {
        warningSpy.mockRestore();
      }
    }

    expect(caught).toBeInstanceOf(CheckpointSnapshotFailureError);
    expect(caught).toMatchObject({
      code: '57014',
      checkpointStage: 'write-item',
      workItemId: secondId,
      completedWorkItemIds: [firstId],
    });
    const waitSnapshot = (caught as InstanceType<typeof CheckpointSnapshotFailureError>).waitSnapshot;
    expect(waitSnapshot).toMatchObject({
      status: 'sampled',
      waitEvent: 'PgSleep',
    });
    expect(warningMessages).toHaveLength(1);
    expect(JSON.parse(String(warningMessages[0]).replace(/^\[host-checkpoint\] /, ''))).toMatchObject({
      checkpointStage: 'write-item',
      workItemId: secondId,
      completedWorkItemIds: [firstId],
      code: '57014',
      waitSnapshot: { status: 'sampled', waitEvent: 'PgSleep' },
    });

    const firstAfterFailure = await getWorkItemCheckpoint(firstRef);
    expect(firstAfterFailure).toContain(firstAuthored);
    expect(firstAfterFailure).toContain('Initial mandatory host snapshot.');
    expect(await getWorkItemCheckpoint(secondRef)).toBe(secondAuthored);

    const retried = await autoCheckpointStaleHeldItems({
      ownerId,
      workspaceId: 'default',
      sessionId: 'host-snapshot-session',
      sinceIso: new Date(Date.now() - 60_000).toISOString(),
      journalNote: 'Successful host snapshot retry.',
      mode: 'respawn',
    });
    expect(retried).toEqual([
      { id: firstId, mechanical: true },
      { id: secondId, mechanical: true },
    ]);
    const firstAfterRetry = await getWorkItemCheckpoint(firstRef);
    const secondAfterRetry = await getWorkItemCheckpoint(secondRef);
    expect(firstAfterRetry).toContain(firstAuthored);
    expect(firstAfterRetry).toContain('Successful host snapshot retry.');
    expect(firstAfterRetry).not.toContain('Initial mandatory host snapshot.');
    expect(secondAfterRetry).toContain(secondAuthored);
    expect(secondAfterRetry).toContain('Successful host snapshot retry.');
  });
});
