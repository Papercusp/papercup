/**
 * dead-target-sweep.integration.test.ts — the sweep's WRITE side against a real, fully-migrated
 * Postgres (dead-target-routine-reaper-2026-08-30 P-006, from EI-19278517916030043).
 *
 * WHY THIS FILE EXISTS, AND WHAT THE UNIT TESTS STRUCTURALLY CANNOT COVER.
 *
 * The sweep's decisions are pure and already proven: `classifyTargetHealth` and
 * `confirmPermanence` have 32 unit tests including permanently-kept wrong-decider controls.
 * What no unit test can reach is the ROUND TRIP — the stamp the sweep WRITES to
 * `metadata.health.dead_target` on one tick is the same value `priorRecord` READS on the next.
 * A unit test hands `priorRecord` a hand-built `PermanenceRecord`, so writer and reader can
 * disagree about the persisted shape and every unit test still passes. That is not
 * hypothetical: this file is what caught it (`stampHealth` persisted `first_seen_at` as an
 * ISO string while the decider wanted `firstSeenAtMs`, so the second sighting threw and the
 * reaper could never actually park anything). Two real sweeps against one real row are the
 * only instrument that sees it.
 *
 * So the assertions here are deliberately about PERSISTED STATE across ticks — active flags,
 * the stamp, the watchdog ledger — never about the return value alone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import type { TargetProbe } from './dead-target-routine-reaper';

const WS = 'ws-dead-target-integration';
const HOME = 'home-pot';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  ws: 'ws-dead-target-integration',
  /** installSlug -> the probe result the (mocked) probe should return. */
  probes: new Map<string, unknown>(),
  /** Every install the sweep actually probed, in order. */
  probed: [] as string[],
  /** Every observation the sweep filed. */
  captured: [] as Array<Record<string, unknown>>,
  /** What the (mocked) flag store answers for FLAGS.DEAD_TARGET_REAPER: true | false | throw. */
  flag: 'on' as 'on' | 'off' | 'unreadable',
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('./dead-target-probe', () => ({
  probeTarget: async (installSlug: string, workspaceId: string) => {
    h.probed.push(installSlug);
    return (
      h.probes.get(installSlug) ?? {
        installSlug,
        workspaceId,
        resolution: { kind: 'resolved', path: `/tmp/${installSlug}` },
        rootExists: true,
        gitObjectStore: 'readable',
      }
    );
  },
}));
vi.mock('../improvements/capture-core', () => ({
  captureImprovement: async (a: Record<string, unknown>) => {
    h.captured.push(a);
    return { ok: true };
  },
}));
// The registered gate. `unreadable` is not decoration: a flag lookup that throws must land on
// the same inert behaviour as an explicit OFF, and that is only observable end-to-end here.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => {
    if (h.flag === 'unreadable') throw new Error('flag store unreachable');
    return h.flag === 'on';
  },
}));

const { deadTargetReaperSweep } = await import('./dead-target-sweep');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

/** Probe shapes, written out so each test reads as the physical situation it describes. */
function rootGone(installSlug: string): TargetProbe {
  return {
    installSlug,
    workspaceId: WS,
    resolution: { kind: 'resolved', path: `/tmp/${installSlug}` },
    rootExists: false,
  };
}
function healthy(installSlug: string): TargetProbe {
  return {
    installSlug,
    workspaceId: WS,
    resolution: { kind: 'resolved', path: `/tmp/${installSlug}` },
    rootExists: true,
    gitObjectStore: 'readable',
  };
}
/** The fail-closed case: we could not establish anything, so nothing may be concluded. */
function couldNotLook(installSlug: string): TargetProbe {
  return {
    installSlug,
    workspaceId: WS,
    resolution: { kind: 'read-failed', detail: 'registry unreadable' },
  };
}

const T0 = Date.parse('2026-08-30T12:00:00.000Z');
/** Comfortably past the 10-minute default spacing between the two agreeing sightings. */
const T1 = T0 + 11 * 60 * 1000;
const T2 = T1 + 11 * 60 * 1000;

let db: OrgTestDb;
let sql: OrgTestDb['adminSql'];
const originalHome = process.env.PAPERCUSP_POT_HOME_SLUG;

interface SeenRow {
  id: string;
  name: string;
  active: boolean;
  active_changed_at: Date | null;
  stamp: Record<string, unknown> | null;
}

async function seedRoutine(installSlug: string, name: string, workspaceId = WS): Promise<string> {
  const id = `rt-${installSlug}-${name}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id)
    VALUES (${id}, ${installSlug}, ${name}, 'schedule', ${sql.json({ intervalSec: 180 })}, 'system',
            true, ${workspaceId})`;
  return id;
}

async function rowsFor(installSlug: string): Promise<SeenRow[]> {
  return (await sql<SeenRow[]>`
    SELECT id, name, active, active_changed_at,
           metadata->'health'->'dead_target' AS stamp
      FROM harness_shared.routines
     WHERE install_slug = ${installSlug}
     ORDER BY name`) as unknown as SeenRow[];
}

async function watchdogFireCount(installSlug: string): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.pot_watchdog_fires
     WHERE install_slug = ${installSlug} AND source = 'dead-target-reaper'`;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = db.adminSql;
  process.env.PAPERCUSP_POT_HOME_SLUG = HOME;
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.PAPERCUSP_POT_HOME_SLUG;
  else process.env.PAPERCUSP_POT_HOME_SLUG = originalHome;
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
  await sql`TRUNCATE harness_shared.pot_watchdog_fires`;
  h.probes.clear();
  h.probed.length = 0;
  h.captured.length = 0;
  h.flag = 'on';
});

afterEach(() => {
  delete process.env.PAPERCUSP_DEAD_TARGET_REAPER;
});

describe('dead-target sweep — one tick', () => {
  it('confirms a missing root without parking, and stamps the evidence a human will read', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    await seedRoutine('dead-pot', 'green-checkpoint');
    h.probes.set('dead-pot', rootGone('dead-pot'));

    const [result] = await deadTargetReaperSweep(T0);

    expect(result).toMatchObject({ installSlug: 'dead-pot', outcome: 'confirming', state: 'root-missing' });

    const rows = await rowsFor('dead-pot');
    expect(rows.map((r) => r.active)).toEqual([true, true]); // a single sighting NEVER parks
    for (const r of rows) {
      expect(r.stamp).toMatchObject({ state: 'root-missing', confirmations: 1, parked: false });
      // The reason is evidence, not a label — it must name the path a human would go look at.
      expect(String(r.stamp?.reason)).toContain('/tmp/dead-pot');
      expect(r.stamp?.path).toBe('/tmp/dead-pot');
      expect(r.stamp?.parked_at).toBeNull();
    }
    expect(h.captured).toHaveLength(0); // nothing was parked, so nobody is paged
  });

  it('never probes and never parks the operator home harness', async () => {
    await seedRoutine(HOME, 'system:git-sync');
    // Even if the probe WOULD say the tree is gone, the guard runs first.
    h.probes.set(HOME, rootGone(HOME));

    const [result] = await deadTargetReaperSweep(T0);

    expect(result).toMatchObject({ installSlug: HOME, outcome: 'protected', state: 'not-probed' });
    expect(h.probed).not.toContain(HOME); // the guard is BEFORE the probe, not after it
    expect((await rowsFor(HOME))[0]?.active).toBe(true);
  });

  it('parks nothing when the probe could not establish anything (fail-closed)', async () => {
    await seedRoutine('opaque-pot', 'system:git-sync');
    h.probes.set('opaque-pot', couldNotLook('opaque-pot'));

    const [result] = await deadTargetReaperSweep(T0);

    expect(result).toMatchObject({ outcome: 'inconclusive', state: 'unknown' });
    const rows = await rowsFor('opaque-pot');
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.stamp).toBeNull();
  });

  it('reads only its own workspace', async () => {
    await seedRoutine('foreign-pot', 'system:git-sync', 'some-other-workspace');
    h.probes.set('foreign-pot', rootGone('foreign-pot'));

    expect(await deadTargetReaperSweep(T0)).toEqual([]);
    expect(h.probed).toEqual([]);
    expect((await rowsFor('foreign-pot'))[0]?.active).toBe(true);
  });

  it('touches nothing at all when the kill switch is off', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    h.probes.set('dead-pot', rootGone('dead-pot'));
    process.env.PAPERCUSP_DEAD_TARGET_REAPER = '0';

    expect(await deadTargetReaperSweep(T0)).toEqual([]);
    expect(h.probed).toEqual([]);
    const rows = await rowsFor('dead-pot');
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.stamp).toBeNull();
  });

  // The two gates are independent on purpose, so each needs its own inertness proof against a
  // pot the sweep would otherwise park. Asserting `probed` empty is the load-bearing half: a
  // gate that returned [] but still probed would read as inert here while doing real I/O.
  it('touches nothing at all when the registered feature flag is off', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    h.probes.set('dead-pot', rootGone('dead-pot'));
    h.flag = 'off';

    expect(await deadTargetReaperSweep(T0)).toEqual([]);
    expect(h.probed).toEqual([]);
    const rows = await rowsFor('dead-pot');
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.stamp).toBeNull();
  });

  it('treats an unreadable flag store as OFF, never as permission to park', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    h.probes.set('dead-pot', rootGone('dead-pot'));
    h.flag = 'unreadable';

    expect(await deadTargetReaperSweep(T0)).toEqual([]);
    expect(h.probed).toEqual([]);
    const rows = await rowsFor('dead-pot');
    expect(rows[0]?.active).toBe(true);
  });
});

describe('dead-target sweep — across ticks (the stamp round trip)', () => {
  it('parks every routine of a confirmed-dead install and files ONE observation', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    await seedRoutine('dead-pot', 'green-checkpoint');
    h.probes.set('dead-pot', rootGone('dead-pot'));

    const first = await deadTargetReaperSweep(T0);
    expect(first[0]?.outcome).toBe('confirming');

    // THE ROUND TRIP: this second sweep reads back the stamp the first one wrote. If writer
    // and reader disagree about the persisted shape, this is where it surfaces.
    const second = await deadTargetReaperSweep(T1);

    expect(second[0]).toMatchObject({ installSlug: 'dead-pot', outcome: 'parked', state: 'root-missing', routinesParked: 2 });

    const rows = await rowsFor('dead-pot');
    expect(rows.map((r) => r.active)).toEqual([false, false]);
    for (const r of rows) {
      expect(r.active_changed_at).toBeInstanceOf(Date);
      expect(r.stamp).toMatchObject({ state: 'root-missing', confirmations: 2, parked: true });
      expect(r.stamp?.parked_by).toBe('dead-target-reaper sweep');
      expect(Date.parse(String(r.stamp?.parked_at))).toBe(T1);
      // The run's own history survives the park, so a human can see how long it was dead.
      expect(Date.parse(String(r.stamp?.first_seen_at))).toBe(T0);
      expect(Date.parse(String(r.stamp?.last_seen_at))).toBe(T1);
    }

    expect(h.captured).toHaveLength(1);
    const filed = h.captured[0]!;
    expect(String(filed.title)).toContain('dead-pot');
    expect(filed.kind).toBe('bug');
    expect(filed.scope).toBe('harness:dead-pot');
    // The escalation must carry a WORKING un-park command per parked routine (routines:set
    // takes one routine at a time and requires `name`), or the reader cannot act on it.
    expect(String(filed.body)).toContain(`routines:set { name: 'system:git-sync', installSlug: 'dead-pot', active: true }`);
    expect(String(filed.body)).toContain(`routines:set { name: 'green-checkpoint', installSlug: 'dead-pot', active: true }`);

    expect(await watchdogFireCount('dead-pot')).toBe(1);
  });

  it('does not park two sightings that are too close together', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    h.probes.set('dead-pot', rootGone('dead-pot'));

    await deadTargetReaperSweep(T0);
    const second = await deadTargetReaperSweep(T0 + 60_000); // one minute later — inside the window

    expect(second[0]?.outcome).toBe('confirming');
    const rows = await rowsFor('dead-pot');
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.stamp).toMatchObject({ confirmations: 2, parked: false });
    expect(h.captured).toHaveLength(0);
  });

  it('clears the run when the tree comes back, leaving no stale watermark', async () => {
    await seedRoutine('flappy-pot', 'system:git-sync');
    h.probes.set('flappy-pot', rootGone('flappy-pot'));
    await deadTargetReaperSweep(T0);
    expect((await rowsFor('flappy-pot'))[0]?.stamp).toMatchObject({ confirmations: 1 });

    // The pot home was lazily materialized between ticks. EI-6765: a stale record surviving
    // this reading is exactly how a live install gets parked by a watermark nobody reset.
    h.probes.set('flappy-pot', healthy('flappy-pot'));
    const recovered = await deadTargetReaperSweep(T1);
    expect(recovered[0]).toMatchObject({ outcome: 'healthy', state: 'ok' });
    expect((await rowsFor('flappy-pot'))[0]?.stamp).toBeNull();

    // ...and the run really did restart: it goes missing again and STILL does not park.
    h.probes.set('flappy-pot', rootGone('flappy-pot'));
    const relapsed = await deadTargetReaperSweep(T2);
    expect(relapsed[0]?.outcome).toBe('confirming');
    expect((await rowsFor('flappy-pot'))[0]).toMatchObject({ active: true });
    expect((await rowsFor('flappy-pot'))[0]?.stamp).toMatchObject({ confirmations: 1 });
  });

  it('re-parks a re-armed install without paging anyone twice inside the 24h window', async () => {
    await seedRoutine('dead-pot', 'system:git-sync');
    h.probes.set('dead-pot', rootGone('dead-pot'));
    await deadTargetReaperSweep(T0);
    await deadTargetReaperSweep(T1);
    expect(h.captured).toHaveLength(1);

    // A human (or a hopeful automation) re-arms the routine without fixing the tree.
    await sql`UPDATE harness_shared.routines SET active = true WHERE install_slug = 'dead-pot'`;

    const third = await deadTargetReaperSweep(T2);

    // It parks again — that is correct, the tree is still gone — but the escalation is
    // debounced through the SAME watchdog ledger the rest of the system triages, so a
    // re-arm loop cannot turn into an observation flood.
    expect(third[0]).toMatchObject({ outcome: 'debounced', state: 'root-missing', routinesParked: 1 });
    expect((await rowsFor('dead-pot'))[0]?.active).toBe(false);
    expect(h.captured).toHaveLength(1);
    expect(await watchdogFireCount('dead-pot')).toBe(1);
  });
});
