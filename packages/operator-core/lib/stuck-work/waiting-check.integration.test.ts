/**
 * Waiting check over the real waits and work-item tables
 * (stuck-work-detection-and-honest-waits-2026-11-13 P-002, bar R-2).
 *
 * The unit test pins the pure rule; this one pins the parts a pure test cannot see:
 * the loader's SQL (episode reset on an `event` fire, source-side exclusion of the
 * routine shared signals, the 3-alarm HAVING), the key → item resolution through a
 * work-item key and through an announcement row, and the durable notice state
 * (condition singleton from migration 741 + the compare-and-set repeat stamp). A run
 * over that state after a "restart" must not send a second first notice.
 *
 * Only message delivery is a spy: the notice ITEM is the durable product here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import type { WaitingCheckDeps } from './waiting-check';

const WS = 'waiting-check-it';
const H = 'papercusp';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../agent-tools/coordination/log', async (orig) => ({ ...(await orig<Record<string, unknown>>()), coordScopeWorkspace: () => WS }));
vi.mock('../pot-membership', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveWorkItemPot: async ({ rawSlug }: { rawSlug?: string }) => rawSlug ?? null,
}));
vi.mock('../modes/goal-context', async (orig) => ({ ...(await orig<Record<string, unknown>>()), resolveGoalContext: async () => null }));
vi.mock('../blueprint/operation-worker-binding', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' }),
}));

const { runWaitingCheck } = await import('./waiting-check');
const { defaultWaitingCheckDeps, loadWaitKeyStats, resolveWaitKeys } = await import('./waiting-check-adapters');

const HOUR = 3_600_000;
let db: FreshPgDb;
let savedWorkspace: string | undefined;

beforeAll(async () => {
  savedWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  db = await createFreshPgDb('waiting-check');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe('ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS first_claimed_at timestamptz');
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(`ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS assignee_rank integer,
    ADD COLUMN IF NOT EXISTS rank_writer text, ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz`);
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'waiting-check.integration',
    extra: [
      '741-work-items-condition-key-singleton.sql', '777-work-items-embedding-recipe-discriminator.sql',
      '1110-work-items-admission-flags-generated-columns.sql', '1135-work-items-epoch-ms-timestamp-guard.sql',
      '1194-work-items-directive-ref.sql', '1294-work-item-readiness-payload-projections.sql',
      '1308-work-items-severity-projection.sql',
    ],
    knownInapplicable: [{
      file: '1534-work-items-duplicate-of.sql',
      reason: 'Canonical work-item fixture DDL already carries duplicate verdict columns. This fixture does not build the work_items_claimable view that migration 1534 rewrites; claimability is outside the waiting check.',
    }],
  });
}, 120_000);

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`DELETE FROM harness_shared.event_awaits`;
});

afterAll(async () => {
  if (savedWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = savedWorkspace;
  await db?.cleanup();
});

async function addItem(id: string, opts: { takenBy?: string | null; status?: string; plan?: string } = {}) {
  await db.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, title, status, taken_by, taken_at, source_plan_slug, updated_ts)
    VALUES (${WS}, ${H}, ${id}, ${`item ${id}`}, ${opts.status ?? 'wip'}, ${opts.takenBy ?? null},
            ${opts.takenBy ? new Date() : null}, ${opts.plan ?? null}, ${Date.now()})`;
}

/** One wait row. `firedReason` null + `firedAgoH` null = still live. */
async function addWait(key: string, subscriber: string, createdAgoH: number,
  fired: { reason: 'timeout' | 'event' | 'verified-timeout'; agoH: number } | null, policy = 'wake') {
  const now = Date.now();
  await db.sql`
    INSERT INTO harness_shared.event_awaits (workspace_id, event_key, subscriber_id, policy, created_at, fired_at, fired_reason)
    VALUES (${WS}, ${key}, ${subscriber}, ${policy}, ${new Date(now - createdAgoH * HOUR)},
            ${fired ? new Date(now - fired.agoH * HOUR) : null}, ${fired?.reason ?? null})`;
}

/** A stuck episode: `alarms` timeout fires spread over the last 5h, plus one live wait now. */
async function stuckEpisode(key: string, waiters: string[], alarms = 3) {
  for (let i = 0; i < alarms; i += 1) {
    await addWait(key, waiters[i % waiters.length], 5 - i, { reason: 'timeout', agoH: 4.5 - i });
  }
  await addWait(key, waiters[0], 0.1, null);
}

/** Production deps at a controlled clock; only delivery is observed. */
function depsAt(nowMs: number, notify = vi.fn<WaitingCheckDeps['notify']>(async () => {})) {
  return {
    notify,
    deps: {
      ...defaultWaitingCheckDeps(WS),
      nowMs: () => nowMs,
      loadStats: () => loadWaitKeyStats(db.sql, WS, nowMs),
      notify,
    },
  };
}

async function noticeRows() {
  return db.sql<{ feature_id: string; condition_key: string; status: string; payload: { stuckWait?: Record<string, unknown> } }[]>`
    SELECT feature_id, condition_key, status, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND condition_key LIKE 'stuck-wait:%' ORDER BY condition_key`;
}

describe('waiting check over the real waits table', () => {
  it('files one durable notice per blocked item, addressed to its assignee, and stays silent after a restart', async () => {
    await addItem('WI-900', { takenBy: 'su-owner' });
    // Two signals behind the same item: one notice, not two.
    await stuckEpisode('work-item:done:WI-900', ['su-a', 'su-b']);
    await stuckEpisode('work-item:status:WI-900', ['su-c']);

    const first = depsAt(Date.now());
    const res = await runWaitingCheck(first.deps);
    expect(res.firstNotices).toBe(1);
    const rows = await noticeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].condition_key).toBe('stuck-wait:item:WI-900');
    expect(rows[0].payload.stuckWait).toMatchObject({
      itemId: 'WI-900', recipient: 'su-owner', missedAlarms: 6,
      waiters: ['su-a', 'su-b', 'su-c'],
    });
    expect((rows[0].payload.stuckWait?.keys as string[]).sort()).toEqual(['work-item:done:WI-900', 'work-item:status:WI-900']);
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(first.notify.mock.calls[0][0]).toMatchObject({ recipient: 'su-owner', action: 'first-notice' });

    // A fresh process reads the same tables: the durable item suppresses a second first notice.
    const second = depsAt(Date.now() + 20 * 60_000);
    const again = await runWaitingCheck(second.deps);
    expect(again.firstNotices).toBe(0);
    expect(again.repeatNotices).toBe(0);
    expect(second.notify).not.toHaveBeenCalled();
    expect(await noticeRows()).toHaveLength(1);
  });

  it('with the notice switch off, reports the flag but files and sends nothing (D-003 silent run)', async () => {
    await addItem('WI-906', { takenBy: 'su-owner' });
    await stuckEpisode('work-item:done:WI-906', ['su-a']);
    const silent = depsAt(Date.now());
    const res = await runWaitingCheck({ ...silent.deps, noticesEnabled: false });
    expect(res).toMatchObject({ silent: true, flags: 1, firstNotices: 0, repeatNotices: 0 });
    expect(res.flagged[0]).toMatchObject({ groupKey: 'item:WI-906', recipient: 'su-owner', action: 'first-notice' });
    expect(silent.notify).not.toHaveBeenCalled();
    expect(await noticeRows()).toHaveLength(0);
  });

  it('repeats exactly once at 24 hours, through the compare-and-set stamp', async () => {
    await addItem('WI-901', { takenBy: null });
    await stuckEpisode('work-item:done:WI-901', ['su-a']);
    await runWaitingCheck(depsAt(Date.now()).deps);

    const later = depsAt(Date.now() + 25 * HOUR);
    const repeat = await runWaitingCheck(later.deps);
    expect(repeat.repeatNotices).toBe(1);
    expect(later.notify.mock.calls[0][0]).toMatchObject({ action: 'repeat-notice', recipient: 'human' });
    const [row] = await noticeRows();
    expect(typeof row.payload.stuckWait?.repeatSentAt).toBe('string');

    const evenLater = depsAt(Date.now() + 30 * HOUR);
    const none = await runWaitingCheck(evenLater.deps);
    expect(none.repeatNotices).toBe(0);
    expect(evenLater.notify).not.toHaveBeenCalled();
  });

  it('excludes the routine shared signals at the source and resets an episode on a real result', async () => {
    await stuckEpisode('git-sync:committed:papercusp', ['su-a', 'su-b'], 5);
    await stuckEpisode('resource:released:git-sync', ['su-a'], 4);
    // Three old alarms, then a real result: the episode starts over and has no alarms yet.
    await stuckEpisode('work-item:done:WI-902', ['su-a']);
    await addWait('work-item:done:WI-902', 'su-a', 0.5, { reason: 'event', agoH: 0.2 });
    // Two alarms only: below the 3-alarm floor.
    await stuckEpisode('work-item:done:WI-903', ['su-a'], 2);

    const stats = await loadWaitKeyStats(db.sql, WS, Date.now());
    expect(stats.map((s) => s.eventKey)).toEqual([]);
    const res = await runWaitingCheck(depsAt(Date.now()).deps);
    expect(res.flags).toBe(0);
    expect(await noticeRows()).toHaveLength(0);
  });

  it('resolves an announced plan gate to the declarer\'s open item on that plan', async () => {
    const key = 'plan:demo-plan:gate-open';
    await addWait(key, 'su-declarer', 6, null, 'announce');
    await addItem('WI-904', { takenBy: 'su-declarer', plan: 'demo-plan' });
    await addItem('WI-905', { takenBy: 'su-declarer', plan: 'other-plan' });
    await stuckEpisode(key, ['su-a', 'su-b']);

    const stats = await loadWaitKeyStats(db.sql, WS, Date.now());
    expect(stats.map((s) => s.eventKey)).toEqual([key]);
    const resolved = await resolveWaitKeys(db.sql, WS, stats);
    expect(resolved.get(key)).toMatchObject({ declarer: 'su-declarer', item: { id: 'WI-904', assignee: 'su-declarer' } });

    const run = depsAt(Date.now());
    expect((await runWaitingCheck(run.deps)).firstNotices).toBe(1);
    expect((await noticeRows()).map((r) => r.condition_key)).toEqual(['stuck-wait:item:WI-904']);
  });
});
