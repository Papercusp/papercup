/**
 * WI-37774 — the ADVERTISE side of the row-intrinsic claim floors.
 *
 * A floor meaning "agents must never get this" has TWO sides, implemented in DIFFERENT
 * functions: cannot-CLAIM (`claimNextIssueWorkItem`, work-items.ts) and is-not-OFFERED
 * (`issueAdmissibleWhereSql`, issues-engineer.ts). WI-2633 guarded only the claim side and
 * its test file guarded only the claim side, so the advertise side sat unguarded for months
 * while LOOKING covered. WI-37761 fixed one such floor (federation-detector); this file
 * covers the three siblings found by auditing for the same shape rather than by hitting them:
 *
 *   - loop-noise                    (EI-8802, loopIterationNoiseExclusionSql)
 *   - already-terminally-completed  (EI-8972, alreadyTerminallyCompletedExclusionSql)
 *   - an ACTIVE typed external blocker      (externalBlockersExclusionSql)
 *
 * Each is ROW-INTRINSIC — its helper takes only `sql`, no assignee/rigAvailable/swarmId — so
 * each is one of the "unconditional per-row floors" WI-4405's contract already claims to
 * mirror, as opposed to the readiness/rig/cooldown/swarm/redundancy floors it deliberately
 * omits for needing live claim context.
 *
 * THE LAST DESCRIBE IS THE POINT. The per-floor cases below pin the three floors I fixed;
 * the INVARIANT case pins the RULE ("nothing advertised is unclaimable") against the real
 * claim oracle, so a FOURTH floor added to the claim path and not here fails without anyone
 * remembering this file exists. Enumerating floors is what let the gap open in the first
 * place — a test that only enumerates would reproduce the original defect one floor later.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, USER_TRUST_LIST_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedIssue(
  id: string,
  opts: {
    title?: string;
    status?: string;
    payload?: Record<string, unknown> | null;
    terminalOwner?: string | null;
    terminalCompletionRef?: string | null;
    authority?: string | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts,
       payload, terminal_owner, terminal_completion_ref, authority)
    VALUES (${H}, ${id}, 'bug', ${opts.title ?? `title ${id}`}, ${opts.status ?? 'open'}, ${null},
       ${WS}, 0, 0,
       ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null},
       ${opts.terminalOwner ?? null}, ${opts.terminalCompletionRef ?? null}, ${opts.authority ?? null})`;
}

const advertisedIds = async () =>
  (await wi.listWorkItems({ harness: H, state: 'open', admissibleOnly: true })).map((r) => r.id);
const allIds = async () => (await wi.listWorkItems({ harness: H, state: 'open' })).map((r) => r.id);

beforeAll(async () => {
  db = await createFreshPgDb('wi-advertise-floor-parity');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('admissibleOnly EXCLUDES a loop-iteration bookkeeping marker (WI-37774 / EI-8802)', () => {
  it('is offered WITHOUT admissibleOnly but NOT with it (the floor is what removes it)', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-WAKE', { title: 'Loop wake #9775: continue papercusp backlog drain' });
    // The without-flag leg is the POSITIVE CONTROL: without it, the exclusion assertion
    // below would pass just as well if the fixture never seeded the row at all.
    expect(await allIds()).toEqual(expect.arrayContaining(['WI-REAL', 'WI-WAKE']));
    const admissible = await advertisedIds();
    expect(admissible).toContain('WI-REAL');
    expect(admissible).not.toContain('WI-WAKE');
  });

  it('excludes the OTHER marker form too ("AUTO loop iteration:")', async () => {
    await seedIssue('WI-AUTO', { title: 'AUTO loop iteration: delta rollout contract runtime policy' });
    expect(await allIds()).toContain('WI-AUTO');
    expect(await advertisedIds()).not.toContain('WI-AUTO');
  });

  it('a row merely MENTIONING a loop wake mid-title is still advertised (prefix-anchored, not a substring)', async () => {
    // Guards against "fixing" the floor into a substring match, which would silently swallow
    // legitimate work — e.g. a bug report ABOUT the loop-wake markers, like this very item.
    await seedIssue('WI-ABOUT', { title: 'Stale "Loop wake #" rows are advertised but unclaimable' });
    expect(await advertisedIds()).toContain('WI-ABOUT');
  });
});

describe('admissibleOnly EXCLUDES an already-terminally-completed row (WI-37774 / EI-8972)', () => {
  it('terminal_owner + terminal_completion_ref ⇒ advertised without the flag, excluded with it', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-DONE', { terminalOwner: 'su-someone', terminalCompletionRef: 'WI-DONE#completion' });
    expect(await allIds()).toEqual(expect.arrayContaining(['WI-REAL', 'WI-DONE']));
    const admissible = await advertisedIds();
    expect(admissible).toContain('WI-REAL');
    expect(admissible).not.toContain('WI-DONE');
  });

  it('terminal_owner + authority (no completion ref) is also excluded', async () => {
    await seedIssue('WI-AUTH', { terminalOwner: 'su-someone', authority: 'committed' });
    expect(await advertisedIds()).not.toContain('WI-AUTH');
  });

  it('a BARE terminal_owner with neither ref nor authority is STILL advertised', async () => {
    // Mirrors alreadyTerminallyCompletedExclusionSql's own shape: an owner alone is not a
    // genuine terminal completion, so this row must stay claimable.
    await seedIssue('WI-BARE', { terminalOwner: 'su-someone' });
    expect(await advertisedIds()).toContain('WI-BARE');
  });
});

describe('admissibleOnly EXCLUDES a row with an ACTIVE external blocker (WI-37774)', () => {
  it('advertised without the flag, excluded with it', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-BLOCKED', {
      payload: { externalBlockers: [{ ref: 'mac-rig-vm', kind: 'runtime', status: 'active' }] },
    });
    expect(await allIds()).toEqual(expect.arrayContaining(['WI-REAL', 'WI-BLOCKED']));
    const admissible = await advertisedIds();
    expect(admissible).toContain('WI-REAL');
    expect(admissible).not.toContain('WI-BLOCKED');
  });

  it('EI-20213672709897481: excludes legacy uppercase ACTIVE blockers too', async () => {
    await seedIssue('WI-UPPERCASE-BLOCKED', {
      payload: {
        externalBlockers: [{ ref: '2-machine-rig', kind: 'runtime', status: 'ACTIVE', capability: 'physical-device' }],
      },
    });
    expect(await allIds()).toContain('WI-UPPERCASE-BLOCKED');
    expect(await advertisedIds()).not.toContain('WI-UPPERCASE-BLOCKED');
    const [verdict] = await wi.explainIssueClaimFloors(H, ['WI-UPPERCASE-BLOCKED']);
    expect(verdict).toMatchObject({ admissible: false, refusedBy: 'external-blocker' });
  });

  it('a RESOLVED blocker does not exclude (only status=="active" gates)', async () => {
    await seedIssue('WI-CLEARED', {
      payload: { externalBlockers: [{ ref: 'mac-rig-vm', kind: 'runtime', status: 'resolved' }] },
    });
    expect(await advertisedIds()).toContain('WI-CLEARED');
  });

  it('an empty/absent externalBlockers array does not exclude (NULL-safe)', async () => {
    await seedIssue('WI-EMPTY', { payload: { externalBlockers: [] } });
    await seedIssue('WI-NOPAYLOAD', { payload: null });
    const admissible = await advertisedIds();
    expect(admissible).toEqual(expect.arrayContaining(['WI-EMPTY', 'WI-NOPAYLOAD']));
  });
});

/**
 * THE CLASS GUARD. Everything above enumerates the floors I happened to fix; this asserts the
 * RULE they are instances of, against the real per-id claim oracle (`explainIssueClaimFloors`,
 * which is built from the SAME exported sql fragments the claim itself ANDs in).
 *
 * A future floor added to the claim path and not to issueAdmissibleWhereSql makes some seeded
 * row advertised-but-refused, and this fails naming the exact floor — no one has to remember
 * this file exists. That is the property whose absence let WI-37761 and WI-37774 happen.
 */
describe('INVARIANT: nothing advertised by admissibleOnly is refused by the claim floors (WI-37774)', () => {
  it('every advertised row is admissible per explainIssueClaimFloors', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-REAL-2', { payload: { externalBlockers: [{ ref: 'x', status: 'resolved' }] } });
    await seedIssue('WI-WAKE', { title: 'Loop wake #9775: continue papercusp backlog drain' });
    await seedIssue('WI-AUTO', { title: 'AUTO loop iteration: something' });
    await seedIssue('WI-DONE', { terminalOwner: 'su-someone', terminalCompletionRef: 'ref' });
    await seedIssue('WI-BLOCKED', { payload: { externalBlockers: [{ ref: 'rig', status: 'active' }] } });
    await seedIssue('WI-HUMAN', { payload: { needsHuman: true } });
    await seedIssue('WI-HOLD', { payload: { _claimHold: true } });

    const advertised = await advertisedIds();
    // Guard the guard: if the fixture stopped seeding, an empty advertised set would make the
    // assertion below vacuously true — the exact false-green this whole file is about.
    expect(advertised.length).toBeGreaterThan(0);

    const verdicts = await wi.explainIssueClaimFloors(H, advertised);
    const refused = verdicts.filter((v) => !v.admissible).map((v) => `${v.id}:${v.refusedBy}`);
    expect(refused).toEqual([]);
  });

  it('and the rows it withholds really are the unclaimable ones (no over-exclusion)', async () => {
    await seedIssue('WI-REAL');
    await seedIssue('WI-WAKE', { title: 'Loop wake #1: x' });
    const advertised = new Set(await advertisedIds());
    const withheld = (await allIds()).filter((id) => !advertised.has(id));
    const verdicts = await wi.explainIssueClaimFloors(H, withheld);
    // Every withheld row must have a REASON — withholding a claimable row is the dual
    // defect (a fleet idles while claimable work exists) and is just as wrong.
    expect(verdicts.filter((v) => v.admissible)).toEqual([]);
  });
});
