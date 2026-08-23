/**
 * goal-holder-respawn.integration.test — P-010 of work-on-everything-goal-2026-08-23
 * (WI-41132): CONSUME the shipped goal-live-holder-guarantee-2026-08-18 holder policy +
 * respawner (its P-004/P-009) and verify respawn-on-loss END-TO-END for a started,
 * package-shaped goal against a real Postgres: kill its session (expressed as the
 * presence signals a dead session actually presents), watch it come back, no human.
 *
 * What the unit suite (goal-liveness-watchdog.test.ts) fakes and this file proves
 * actually COMPOSES (the same lesson as convert/spend-rollup integration tests —
 * unit-mocked halves had never been proven to compose):
 *
 *  - the REAL goals read (`makeReadGoals` via the default deps): the SQL status
 *    predicate, `launch_settings` jsonb → `parseGoalLaunchSettings` →
 *    `resolveGoalHolderPolicy` eligibility — over a STANDING, budget-windowed,
 *    package-shaped goal row (work-on-everything D-002 shape: installed row ≠ started);
 *  - the REAL holder-row read (`readGoalHolderRows`, mode='goal' filter) and the REAL
 *    fold (`resolveGoalHoldersFromRows`) over rows the REAL `setMode` wrote;
 *  - the REAL oracle derivation: `resolveSessionStates` → `deriveVerdict`, driven only
 *    through its DESIGNED DI fetch seams. "Kill its session" is not an injected
 *    verdict: it is the signal set a killed session presents (not wakeable, stale
 *    heartbeat, positive recorded-session-ended evidence), classified by the real code;
 *  - the REAL attach: the default `deps.attach` → `setMode` → agent_modes upsert +
 *    agent_mode_changes audit + the GOAL⇒AUTO/IDEATE implication cascade;
 *  - stability: the tick after recovery folds 'held' and does NOT double-launch.
 *
 * Only the spawn itself is stubbed (`deps.launch` returns a fresh pre-pinned ownerId,
 * exactly the contract `launchGoalHolderSession` documents): opening a real process is
 * the launch door's own tested seam (goal-holder-launch-action.test.ts), and P-010
 * forbids rebuilding anything the holder plan ships. FLAGS.GOAL_HOLDER_RESPAWN stays
 * dark (owner-authority, registered in DARK_FLAGS): these ticks inject
 * `flagEnabled: true` per tick, exactly what the armed timer's per-tick gate resolves
 * to after the owner flips the flag — the flag itself is deliberately NOT flipped here.
 *
 * ⚠ Fixture DDL below is hand-rolled to the columns the code under test touches
 * (precedent: spend-rollup.integration.test.ts, and its recorded drift trap —
 * EI-21270668928342264): adding a column that `makeReadGoals` / `setMode` reads means
 * auditing this block by hand.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';

import {
  runGoalHolderRespawnOnce,
  type GoalHolderRespawnDeps,
} from './goal-liveness-watchdog';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import type { WakeabilitySignals } from '../agent-tools/coordination/presence-wakeability';
import type { SelfWakeSignals } from '../agent-tools/coordination/presence-selfwake';
import {
  readGoalHolderRows,
  resolveGoalHoldersFromRows,
} from '../goals/holder';
import { GOAL_MODE } from '../modes/goal-session';
import { setMode } from '../modes/store';

const WS = 'ws-woe-p010';
const HARNESS = 'papercusp-p010';
const GOAL = 'goal-woe-package-1';
const INITIAL_HOLDER = 'su-initial-holder';

let rootSql: postgres.Sql;

/* ── the presence-signal fixture: what each session's substrate looks like ── */

interface SessionSignals {
  wakeable: boolean;
  liveTurn: boolean;
  stale: boolean;
  heartbeatAt: string;
  recordedLive: boolean;
  recordedEnded: boolean;
  selfWake?: SelfWakeSignals;
}

/** A healthy, working session: warm heartbeat, wakeable, recorded-live. */
function liveSignals(): SessionSignals {
  return {
    wakeable: true,
    liveTurn: true,
    stale: false,
    heartbeatAt: new Date().toISOString(),
    recordedLive: true,
    recordedEnded: false,
    selfWake: { loopArmed: true, selfWake: 'loop' } as SelfWakeSignals,
  };
}

/**
 * The KILL: the signal set a dead session actually presents — no wake await, a
 * stale heartbeat, and positive session-log evidence the recorded session ended.
 * `deriveVerdict` (the real classifier) must read this as 'ended'; nothing here
 * hands the code a verdict.
 */
function killedSignals(): SessionSignals {
  return {
    wakeable: false,
    liveTurn: false,
    stale: true,
    heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
    recordedLive: false,
    recordedEnded: true,
    selfWake: { loopArmed: false, selfWake: 'none' } as SelfWakeSignals,
  };
}

const sessions = new Map<string, SessionSignals>();

/**
 * The REAL oracle over the fixture substrate: `resolveSessionStates` runs its own
 * hydration + `deriveVerdict`; only the batched FETCHES (its documented DI seams)
 * read from the fixture map. An owner with no fixture entry gets NO verdict — the
 * oracle's own degraded-fetch contract, which the fold must render as 'unknown'.
 */
const resolveLiveness: GoalHolderRespawnDeps['resolveLiveness'] = async (ownerIds) =>
  await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    {
      hydratePerId: true,
      selfWake: true,
      getPresenceFn: async (ownerId) => {
        const s = sessions.get(ownerId);
        if (!s) return null;
        return { heartbeatAt: s.heartbeatAt, stale: s.stale, host: null, pid: null, source: 'psu' };
      },
      fetchWakeabilityFn: async (ids) => {
        const out = new Map<string, WakeabilitySignals>();
        for (const id of ids) {
          const s = sessions.get(id);
          if (s) out.set(id, { wakeable: s.wakeable, liveTurn: s.liveTurn } as WakeabilitySignals);
        }
        return out;
      },
      fetchSelfWakeFn: async (ids) => {
        const out = new Map<string, SelfWakeSignals>();
        for (const id of ids) {
          const s = sessions.get(id);
          if (s?.selfWake) out.set(id, s.selfWake);
        }
        return out;
      },
      fetchRecordedLiveFn: async (ids) =>
        new Set(ids.filter((id) => sessions.get(id)?.recordedLive === true)),
      fetchRecordedEndedFn: async (ids) =>
        new Set(ids.filter((id) => sessions.get(id)?.recordedEnded === true)),
      probePidFn: () => null,
      findHostFn: () => null,
    },
  );

/* ── goal seeding: the package-shaped standing goal (D-002 / D-005 shape) ── */

async function seedGoal(opts: {
  id: string;
  status?: string;
  launchSettings?: unknown;
  standing?: boolean;
}): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.goals
      (id, workspace_id, install_slug, title, status, launch_settings, standing, budget_window_sec)
    VALUES (${opts.id}, ${WS}, ${HARNESS}, ${'Work on everything (package goal) ' + opts.id},
            ${opts.status ?? 'active'},
            ${opts.launchSettings === undefined ? null : rootSql.json(opts.launchSettings as never)},
            ${opts.standing ?? true}, ${86_400})`;
}

const RESPAWN_SETTINGS = { holder: { requireLive: true, onLoss: 'respawn' } };

/** Attach a holder the way the start door does: the REAL setMode, subject = goal id. */
async function attachHolder(ownerId: string, goalId: string, setBy = ownerId): Promise<void> {
  const res = await setMode({
    workspaceId: WS,
    ownerId,
    modeId: GOAL_MODE,
    enabled: true,
    reason: `test: started package goal ${goalId}`,
    setBy,
    subject: goalId,
    sql: rootSql,
  });
  expect(res.ok).toBe(true);
}

function drillDeps(overrides: Partial<GoalHolderRespawnDeps> = {}): {
  deps: Partial<GoalHolderRespawnDeps>;
  launches: string[];
} {
  const launches: string[] = [];
  const deps: Partial<GoalHolderRespawnDeps> = {
    resolveLiveness,
    flagEnabled: async () => true,
    launch: async (goal) => {
      launches.push(goal.goalId);
      return { ownerId: `su-replacement-${launches.length}`, warnings: [] };
    },
    // attach stays the DEFAULT: the real setMode against the fixture sql.
    escalateGiveUp: async () => {},
    states: new Map(),
    ...overrides,
  };
  return { deps, launches };
}

async function goalModeRows(goalId: string) {
  return await rootSql<
    { owner_id: string; mode: string; subject: string | null; set_by: string }[]
  >`
    SELECT owner_id, mode, subject, set_by FROM harness_shared.agent_modes
     WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${goalId}
     ORDER BY set_at`;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `goalrespawn_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Minimal fixture DDL — the columns makeReadGoals / readGoalHolderRows / setMode
  // touch (see the header's drift caveat).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.goals (
      id text PRIMARY KEY,
      install_slug text NOT NULL,
      title text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      workspace_id text NOT NULL,
      launch_settings jsonb,
      standing boolean NOT NULL DEFAULT false,
      budget_window_sec integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_modes (
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id text NOT NULL,
      axis_key text NOT NULL,
      mode text NOT NULL,
      reason text NOT NULL DEFAULT '',
      set_by text NOT NULL,
      owner_directed boolean NOT NULL DEFAULT false,
      set_at timestamptz NOT NULL DEFAULT now(),
      subject text,
      PRIMARY KEY (workspace_id, owner_id, axis_key)
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_mode_changes (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      owner_id text NOT NULL,
      axis_key text NOT NULL,
      old_mode text,
      new_mode text,
      reason text NOT NULL DEFAULT '',
      set_by text NOT NULL,
      owner_directed boolean NOT NULL DEFAULT false,
      changed_at timestamptz NOT NULL DEFAULT now()
    )`);
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  sessions.clear();
  await rootSql`TRUNCATE harness_shared.goals, harness_shared.agent_modes, harness_shared.agent_mode_changes`;
});

describe('respawn-on-loss for a started package goal (P-010, end-to-end)', () => {
  it('kill its session → the respawner brings it back → stable, no double launch, no human', async () => {
    await seedGoal({ id: GOAL, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, GOAL);
    sessions.set(INITIAL_HOLDER, liveSignals());

    const { deps, launches } = drillDeps();

    // Tick A — the holder is alive: the real oracle classifies it, the real fold
    // says 'held', and the respawner leaves the goal alone.
    const tickA = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tickA).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0, skipped: false });
    expect(launches).toEqual([]);

    // THE KILL — the session dies: its substrate now presents dead-session
    // signals. No verdict is injected anywhere.
    sessions.set(INITIAL_HOLDER, killedSignals());

    // Tick B — loss detected via the real chain; a replacement is launched and
    // the REAL setMode attaches the pre-pinned identity.
    const tickB = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tickB).toMatchObject({
      scanned: 1,
      eligible: 1,
      attempted: 1,
      respawned: 1,
      launchFailed: 0,
      attachFailed: 0,
    });
    expect(launches).toEqual([GOAL]);

    // The attach is real durable state: a second mode='goal' row for the
    // replacement, stamped by the respawner, subject = the goal.
    const rows = await goalModeRows(GOAL);
    expect(rows.map((r) => r.owner_id).sort()).toEqual([INITIAL_HOLDER, 'su-replacement-1'].sort());
    const replacement = rows.find((r) => r.owner_id === 'su-replacement-1');
    expect(replacement).toMatchObject({ mode: GOAL_MODE, subject: GOAL, set_by: 'goal-holder-respawner' });

    // ...and it is audited (append-only agent_mode_changes).
    const audit = await rootSql<{ new_mode: string | null }[]>`
      SELECT new_mode FROM harness_shared.agent_mode_changes
       WHERE workspace_id = ${WS} AND owner_id = ${'su-replacement-1'} AND new_mode = ${GOAL_MODE}`;
    expect(audit.length).toBe(1);

    // "Watch it come back": the replacement session boots and registers live
    // presence; the REAL read-side fold over the REAL rows now says 'held' with
    // the replacement as the live holder.
    sessions.set('su-replacement-1', liveSignals());
    const holderRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [GOAL] });
    const verdicts = await resolveLiveness(holderRows.map((r) => r.ownerId));
    const fold = resolveGoalHoldersFromRows(GOAL, WS, holderRows, verdicts);
    expect(fold.liveness).toBe('held');
    expect(fold.live.map((h) => h.ownerId)).toEqual(['su-replacement-1']);

    // Tick C — stability: held ⇒ no second launch, damping heals, nothing new.
    const tickC = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tickC).toMatchObject({ attempted: 0, respawned: 0 });
    expect(launches).toEqual([GOAL]);
  }, 60_000);

  it('install ≠ start (D-002): an installed-but-never-started package goal is never auto-spawned', async () => {
    await seedGoal({ id: 'goal-installed-only', launchSettings: RESPAWN_SETTINGS });
    // No holder was ever attached: the row exists (installed), nobody started it.
    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
    expect(await goalModeRows('goal-installed-only')).toEqual([]);
  }, 60_000);

  it('a goal on the DEFAULT holder policy (onLoss=deactivate) loses its holder without respawn', async () => {
    // launch_settings NULL: the real parse chain resolves the D-001 default —
    // requireLive true, onLoss 'deactivate' — so the respawner must not touch it.
    await seedGoal({ id: 'goal-default-policy', launchSettings: undefined });
    await attachHolder('su-default-holder', 'goal-default-policy');
    sessions.set('su-default-holder', killedSignals());

    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 1, eligible: 0, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
    expect((await goalModeRows('goal-default-policy')).map((r) => r.owner_id)).toEqual([
      'su-default-holder',
    ]);
  }, 60_000);

  it('a paused package goal with a dead holder is not even swept (status predicate)', async () => {
    await seedGoal({ id: 'goal-paused', status: 'paused', launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-paused-holder', 'goal-paused');
    sessions.set('su-paused-holder', killedSignals());

    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 0, eligible: 0, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  }, 60_000);

  it("an UNRESOLVABLE holder (degraded oracle fetch) is 'unknown', never 'lost' — no spawn", async () => {
    await seedGoal({ id: 'goal-unknown', launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-vanished-holder', 'goal-unknown');
    // No fixture entry: the oracle's wakeability fetch yields no signal for this
    // owner, so it emits NO verdict — the degraded-fetch contract. The fold must
    // read that as 'unknown' and the respawner must not treat it as death.
    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  }, 60_000);
});
