import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { setMode } from '../../modes/store';

const fixture = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => true }));
// Redirect only the module's documented SQL seams into the isolated, migrated DB.
// Both the elected-holder fence and the actual routine writes remain production code.
vi.mock('../../harness/routines/materialize-goal-schedule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/routines/materialize-goal-schedule')>();
  return {
    ...actual,
    materializeGoalSchedule: (input: Parameters<typeof actual.materializeGoalSchedule>[0]) =>
      actual.materializeGoalSchedule({ ...input, sql: fixture.sql() }),
    armGoalSchedule: (input: Parameters<typeof actual.armGoalSchedule>[0]) =>
      actual.armGoalSchedule({ ...input, sql: fixture.sql() }),
  };
});

const setScheduleTool = (await import('./set-schedule')).default;
const armScheduleTool = (await import('./arm-schedule')).default;
const WS = 'ws-goal-authority';
const HARNESS = 'goal-authority-fixture';
const GOAL = 'goal-authority-causal';
const OLD = 'su-authority-old';
const ELECTED = 'su-authority-elected';
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql.mockReturnValue(db.adminSql);
}, 300_000);
afterAll(async () => { await db?.cleanup(); }, 120_000);
beforeEach(async () => {
  await db.adminSql`TRUNCATE harness_shared.routines, harness_shared.agent_modes,
    harness_shared.agent_mode_changes, harness_shared.goals CASCADE`;
  await db.adminSql`INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, status)
    VALUES (${GOAL}, ${WS}, ${HARNESS}, ${'Authority causal fixture'}, 'active')`;
  for (const ownerId of [OLD, ELECTED]) {
    const result = await setMode({ workspaceId: WS, ownerId, modeId: 'goal', enabled: true,
      reason: 'WI-1074216 authority integration fixture', setBy: OLD, subject: GOAL, sql: db.adminSql });
    expect(result.ok).toBe(true);
  }
  // Expire the bounded handoff; the predecessor must now be superseded.
  await db.adminSql`UPDATE harness_shared.agent_modes SET goal_handoff_expires_at = NOW() - INTERVAL '1 minute'
    WHERE workspace_id = ${WS} AND owner_id = ${ELECTED} AND mode = 'goal'`;
});

const ctx = (ownerId: string) => ({
  workspaceId: WS, harnessSlug: HARNESS, tx: db.adminSql, role: 'su',
  isSuperuser: true, uiClientId: ownerId,
});
const scheduleArgs = () => ({ harness: HARNESS, goalId: GOAL,
  schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' } });
const routines = () => db.adminSql<{ active: boolean }[]>`SELECT active FROM harness_shared.routines
  WHERE workspace_id = ${WS} AND install_slug = ${HARNESS}`;

describe('goal authority SQL-to-write integration (WI-1074216)', () => {
  it('superseded-set-schedule: expired predecessor cannot create a routine', async () => {
    await expect(setScheduleTool.handler(scheduleArgs() as never, ctx(OLD) as never))
      .rejects.toMatchObject({ code: 'goal_holder_superseded' });
    expect(await routines()).toEqual([]);
  });

  it('superseded-arm-schedule: expired predecessor cannot arm the elected schedule', async () => {
    await setScheduleTool.handler(scheduleArgs() as never, ctx(ELECTED) as never);
    expect(await routines()).toEqual([{ active: false }]);
    await expect(armScheduleTool.handler({ harness: HARNESS, goalId: GOAL } as never, ctx(OLD) as never))
      .rejects.toMatchObject({ code: 'goal_holder_superseded' });
    expect(await routines()).toEqual([{ active: false }]);
  });

  it('elected-write: current elected lease creates and arms the same routine', async () => {
    await setScheduleTool.handler(scheduleArgs() as never, ctx(ELECTED) as never);
    expect(await routines()).toEqual([{ active: false }]);
    await armScheduleTool.handler({ harness: HARNESS, goalId: GOAL } as never, ctx(ELECTED) as never);
    expect(await routines()).toEqual([{ active: true }]);
  });
});
