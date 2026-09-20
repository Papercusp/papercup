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
 * ⚠ Schema: this fixture stands up the REAL head schema via `createOrgTestDb()`
 * (packages/operator-core/test/_org-test-db.ts — the real boot-path migration runner,
 * template-cached on a content hash of the whole migration set). It deliberately does
 * NOT hand-roll DDL, because this file did and drifted TWICE: first `agent_modes`
 * gained `implied_by jsonb` and `setMode`'s INSERT failed (WI-10002085, 8 tests red),
 * then `harness_shared.adv_sessions` was missing entirely, so `setMode`'s control-anchor
 * refresh degraded and 3 tests failed on its `console.warn` (WI-10002090) — a warn that
 * was telling the truth, which is why silencing it in the console-noise filter would have
 * been the wrong layer (that filter is deliberately scoped so a genuine bounded-timeout
 * failure still fails loudly). A hand-rolled fixture cannot track a migration on its own;
 * the real runner cannot fall behind one, because any new migration changes the template
 * key and forces a rebuild. Do not reintroduce inline `CREATE TABLE` here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

import {
  GOAL_HOLDER_RESPAWN_RATE_LIMIT,
  GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
  pauseGoalForHolderRespawnRateCap,
  reserveGoalHolderRespawnRateSlot,
  runGoalHolderRespawnOnce,
  type GoalHolderRespawnDeps,
} from './goal-liveness-watchdog';
import { setGoalTransitionExecutor, type GoalStopReport } from '@papercusp/agent-mcp';
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

let db: OrgTestDb;
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
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.goals
      (id, workspace_id, install_slug, title, status, launch_settings, standing, budget_window_sec, metadata)
    VALUES (${opts.id}, ${WS}, ${HARNESS}, ${'Work on everything (package goal) ' + opts.id},
            ${opts.status ?? 'active'},
            ${opts.launchSettings === undefined ? null : rootSql.json(opts.launchSettings as never)},
            ${opts.standing ?? true}, ${86_400},
            ${rootSql.json((opts.metadata ?? {}) as never)})`;
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
    neutralize: async () => {},
    notifyHandoff: async () => {},
    escalateGiveUp: async () => {},
    // WI-2140573 finding 5: the default assessor reads the box's LIVE account
    // pool, which this drill must not depend on — measure capacity as clear.
    assessLaunchCapacity: async () => ({
      kind: 'clear',
      target: { provider: 'claude', accountId: null, agent: 'claude' },
      reason: 'drill fixture: capacity clear',
    }),
    escalateCapacityDeferral: async () => {},
    capacityDeferrals: new Map(),
    states: new Map(),
    ...overrides,
  };
  return { deps, launches };
}

async function goalModeRows(goalId: string) {
  return await rootSql<
    {
      owner_id: string;
      mode: string;
      subject: string | null;
      set_by: string;
      goal_lease_epoch: string | null;
      goal_handoff_from_owner_id: string | null;
      goal_handoff_expires_at: Date | null;
    }[]
  >`
    SELECT owner_id, mode, subject, set_by, goal_lease_epoch,
           goal_handoff_from_owner_id, goal_handoff_expires_at
      FROM harness_shared.agent_modes
     WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${goalId}
     ORDER BY set_at`;
}

beforeAll(async () => {
  // Real head schema via the real boot-path migration runner (see the header note).
  // `adminSql` is the RLS-BYPASS client, which is what these assertions want — and it
  // mirrors the canonical operator client's bigint/timestamp parsers and raw
  // Date/jsonb serializers, so a raw read or write here binds exactly as production
  // does instead of in the opposite direction (EI-18698602043482898).
  db = await createOrgTestDb();
  rootSql = db.adminSql;
}, 300_000);

// Explicit timeout: dropping a throwaway database has to terminate other backends
// first, and under concurrent fleet load that has exceeded Vitest's default 10s hook
// timeout and failed suites whose assertions all passed (EI-23128538923529753,
// EI-22778982473804010).
afterAll(async () => {
  await db?.cleanup();
}, 120_000);

beforeEach(async () => {
  sessions.clear();
  await rootSql`TRUNCATE harness_shared.goals, harness_shared.agent_modes, harness_shared.agent_mode_changes`;
});

describe('respawn-on-loss for a started package goal (P-010, end-to-end)', () => {
  it('persists a pruned trailing-hour launch ledger and closes the seventh reservation', async () => {
    const goalId = 'goal-durable-respawn-cap';
    const nowMs = Date.now();
    const priorAttempt = nowMs - 5_000;
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: {
        preserved: 'goal-metadata',
        holderRespawn: {
          preserved: 'respawn-metadata',
          attempts: [nowMs - GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS - 1, priorAttempt],
        },
      },
    });

    for (let expected = 2; expected <= GOAL_HOLDER_RESPAWN_RATE_LIMIT; expected += 1) {
      await expect(reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs)).resolves.toEqual({
        kind: 'reserved',
        attemptsInWindow: expected,
      });
    }
    await expect(reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs)).resolves.toEqual({
      kind: 'capped',
      attemptsInWindow: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
    });

    const [row] = await rootSql<{ metadata: Record<string, any> }[]>`
      SELECT metadata FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(row?.metadata).toMatchObject({
      preserved: 'goal-metadata',
      holderRespawn: {
        preserved: 'respawn-metadata',
        attempts: [priorAttempt, ...Array(GOAL_HOLDER_RESPAWN_RATE_LIMIT - 1).fill(nowMs)],
        limit: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
        windowMs: GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
        needsHuman: true,
        needsHumanAtMs: nowMs,
        reason: 'hourly-respawn-cap',
      },
    });
  }, 60_000);

  it('row-locks concurrent reservations so only one caller receives the sixth slot', async () => {
    const goalId = 'goal-concurrent-respawn-cap';
    const nowMs = Date.now();
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: {
        holderRespawn: {
          attempts: Array(GOAL_HOLDER_RESPAWN_RATE_LIMIT - 1).fill(nowMs - 1_000),
        },
      },
    });

    const decisions = await Promise.all([
      reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs),
      reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs),
    ]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['capped', 'reserved']);
    expect(decisions.map((decision) => decision.attemptsInWindow)).toEqual([
      GOAL_HOLDER_RESPAWN_RATE_LIMIT,
      GOAL_HOLDER_RESPAWN_RATE_LIMIT,
    ]);

    const [row] = await rootSql<{ attempts: unknown[] }[]>`
      SELECT metadata #> '{holderRespawn,attempts}' AS attempts
        FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(row?.attempts).toHaveLength(GOAL_HOLDER_RESPAWN_RATE_LIMIT);
  }, 60_000);

  it('concurrent GOAL entries atomically elect one successor and persist a bounded handoff', async () => {
    const goalId = 'goal-concurrent-election';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    const enter = (ownerId: string) =>
      setMode({
        workspaceId: WS,
        ownerId,
        modeId: GOAL_MODE,
        enabled: true,
        reason: `concurrent election ${ownerId}`,
        setBy: ownerId,
        subject: goalId,
        sql: rootSql,
      });
    const [a, b] = await Promise.all([enter('su-election-a'), enter('su-election-b')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const refused = a.ok ? b : a;
    expect(refused).toMatchObject({
      goalElectionConflict: { goalId, electedEpoch: 1 },
    });

    const rows = await goalModeRows(goalId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.goal_lease_epoch)).toBe(1);
    expect(rows[0]?.goal_handoff_from_owner_id).toBeNull();

    const elected = rows[0]!;
    sessions.set(elected.owner_id, liveSignals());
    const holderRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [goalId] });
    const verdicts = await resolveLiveness(holderRows.map((holder) => holder.ownerId));
    const fold = resolveGoalHoldersFromRows(
      goalId,
      WS,
      holderRows,
      verdicts,
    );
    expect(fold.elected?.ownerId).toBe(elected.owner_id);
    expect(fold.live.map((holder) => holder.ownerId)).toEqual([elected.owner_id]);
    expect(fold.overlap.status).toBe('none');
  }, 60_000);

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
    expect(replacement).toMatchObject({
      mode: GOAL_MODE,
      subject: GOAL,
      set_by: 'goal-holder-respawner',
      goal_handoff_from_owner_id: INITIAL_HOLDER,
    });
    expect(Number(replacement?.goal_lease_epoch)).toBe(2);

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

  it('started metadata + lost GOAL row is recovered, then remains stable without a double launch', async () => {
    const goalId = 'goal-started-row-lost';
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: { agentOwnerId: INITIAL_HOLDER },
    });
    // The goal was started (the post-attach metadata stamp survived), but its
    // canonical GOAL-mode row was lost. This is the production failure: before
    // EI-211659 the respawner folded it as `unheld` and confused it with the
    // installed-only control above.
    expect(await goalModeRows(goalId)).toEqual([]);

    const { deps, launches } = drillDeps();
    const recovered = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(recovered).toMatchObject({ attempted: 1, respawned: 1 });
    expect(launches).toEqual([goalId]);
    expect((await goalModeRows(goalId)).map((r) => r.owner_id)).toEqual(['su-replacement-1']);

    sessions.set('su-replacement-1', liveSignals());
    const stable = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(stable).toMatchObject({ attempted: 0, respawned: 0 });
    expect(launches).toEqual([goalId]);
  }, 60_000);

  it('respawns the lost elected lease even when an older historical GOAL row is still live', async () => {
    const goalId = 'goal-elected-lost-historical-live';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-historical-live', goalId);
    await attachHolder('su-elected-dead', goalId, 'su-historical-live');
    sessions.set('su-historical-live', liveSignals());
    sessions.set('su-elected-dead', killedSignals());

    const beforeRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [goalId] });
    const beforeVerdicts = await resolveLiveness(beforeRows.map((holder) => holder.ownerId));
    const before = resolveGoalHoldersFromRows(goalId, WS, beforeRows, beforeVerdicts);
    expect(before.elected?.ownerId).toBe('su-elected-dead');
    expect(before.liveness).toBe('lost');
    expect(before.allLive.map((holder) => holder.ownerId)).toEqual(['su-historical-live']);

    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ attempted: 1, respawned: 1 });
    expect(launches).toEqual([goalId]);
    const rows = await goalModeRows(goalId);
    const replacement = rows.find((row) => row.owner_id === 'su-replacement-1')!;
    expect(Number(replacement.goal_lease_epoch)).toBe(3);
    expect(replacement.goal_handoff_from_owner_id).toBe('su-elected-dead');
  }, 60_000);

  it('refuses and neutralizes a stale respawn attach after a concurrent legitimate takeover', async () => {
    const goalId = 'goal-respawn-cas-race';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, goalId);
    sessions.set(INITIAL_HOLDER, killedSignals());

    let releaseLaunch!: () => void;
    let launchReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      launchReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const neutralize = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = drillDeps({
      launch: async () => {
        launchReached();
        await release;
        return { ownerId: 'su-stale-respawn', warnings: [] };
      },
      neutralize,
    });

    const tickPromise = runGoalHolderRespawnOnce(rootSql, deps);
    await reached;
    await attachHolder('su-legitimate-takeover', goalId, INITIAL_HOLDER);
    sessions.set('su-legitimate-takeover', liveSignals());
    releaseLaunch();

    const tick = await tickPromise;
    expect(tick).toMatchObject({ attempted: 1, respawned: 0, attachFailed: 1 });
    expect(neutralize).toHaveBeenCalledWith(
      expect.objectContaining({ goalId }),
      'su-stale-respawn',
      expect.stringContaining('already elected to su-legitimate-takeover at epoch 2'),
    );
    const rows = await goalModeRows(goalId);
    expect(rows.map((row) => row.owner_id).sort()).toEqual(
      [INITIAL_HOLDER, 'su-legitimate-takeover'].sort(),
    );
    expect(rows.find((row) => row.owner_id === 'su-legitimate-takeover')?.goal_lease_epoch).toBe('2');
    expect(rows.some((row) => row.owner_id === 'su-stale-respawn')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('already elected to su-legitimate-takeover at epoch 2'),
    );
    warn.mockRestore();
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

/**
 * WI-10002085 — the safety cap must actually PAUSE, against a real server.
 *
 * Why this exists. `pauseGoalForHolderRespawnRateCap` shipped with an uncast parameter inside
 * jsonb_build_object (VARIADIC "any"), so Postgres refused the UPDATE at PARSE time — "could
 * not determine data type of parameter $4" — on every call. The rail could therefore NEVER
 * pause a goal: one tripped the cap, was marked needsHuman at 15:37:31Z, and kept running as
 * status='active' for ~50 minutes with `pause` and `escalatedAtMs` both absent.
 *
 * It was invisible because the only coverage this statement had mocked `sql`, which asserts the
 * statement was BUILT correctly and cannot observe a server-side PARSE failure by construction.
 * So the test that closes it has to execute the real statement against a real Postgres.
 */
describe('holder-respawn safety cap actually pauses the goal (WI-10002085)', () => {
  type GoalMeta = {
    pause?: { reason?: string; pausedBy?: string; pausedAtMs?: number };
    holderRespawn?: { needsHuman?: boolean; escalatedAtMs?: number; attemptsInWindow?: number };
  };

  it('flips status to paused and records the pause + escalation stamps', async () => {
    const goalId = `goal-cap-${randomBytes(4).toString('hex')}`;
    await seedGoal({
      id: goalId,
      status: 'active',
      metadata: {
        holderRespawn: {
          needsHuman: true,
          reason: 'hourly-respawn-cap',
          limit: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
          windowMs: GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
        },
      },
    });

    // The executor is installed by importing goals/stop-fanout for its side effect; stubbing the
    // seam keeps this test on the SQL. The code under test reads only `unattributedActiveLoops`
    // and `degraded` from the report, so the rest is filler for the interface.
    const stops: Array<{ goalId: string; status: string }> = [];
    setGoalTransitionExecutor(async (input) => {
      stops.push({ goalId: input.goalId, status: input.status });
      return {
        goalId: input.goalId,
        status: input.status,
        potsStopped: [],
        unattributedActiveLoops: 0,
        degraded: false,
      } as unknown as GoalStopReport;
    });

    const nowMs = Date.now();
    await pauseGoalForHolderRespawnRateCap(rootSql, { goalId, workspaceId: WS }, 6, nowMs);

    const [row] = await rootSql<Array<{ status: string; metadata: GoalMeta }>>`
      SELECT status, metadata FROM harness_shared.goals WHERE id = ${goalId}`;

    // metadata.pause must be an OBJECT, not a JSON string — and which of those you get depends
    // on the CLIENT, which is worth stating precisely because it is easy to misread as a
    // production bug (EI-18698602043482898). A pre-stringified `${v}::jsonb` param is resolved
    // to OID 3802 by the cast, so postgres-js serializes it through serializers['3802']: the
    // DEFAULT one JSON.stringifies it AGAIN and the value lands as a jsonb scalar string. The
    // canonical operator client is not affected — buildClient installs restoreRawJsonbSerializer,
    // a hybrid that passes an already-stringified string through unchanged. But THIS test (like
    // every integration test in this file) uses a raw postgres() client, where the default
    // serializer applies. `::text::jsonb` types the parameter as text first and so behaves
    // identically under BOTH clients, which is what lets this assertion mean the same thing here
    // as in production instead of diverging from it.
    // The symptom, inverted: status moved, and both stamps the live incident lacked are present.
    expect(row?.status).toBe('paused');
    expect(row?.metadata.pause?.reason).toMatch(/human review is required/i);
    expect(row?.metadata.pause?.pausedAtMs).toBe(nowMs);
    expect(row?.metadata.holderRespawn?.escalatedAtMs).toBe(nowMs);
    expect(row?.metadata.holderRespawn?.attemptsInWindow).toBe(6);
    expect(row?.metadata.holderRespawn?.needsHuman).toBe(true); // preserved, not clobbered
    expect(stops).toEqual([{ goalId, status: 'paused' }]);
  }, 60_000);

  it('is a no-op for a goal that is not flagged needsHuman (the WHERE guard holds)', async () => {
    const goalId = `goal-nocap-${randomBytes(4).toString('hex')}`;
    await seedGoal({ id: goalId, status: 'active', metadata: {} });
    const stops: string[] = [];
    setGoalTransitionExecutor(async (input) => {
      stops.push(input.goalId);
      return { goalId: input.goalId, status: input.status, potsStopped: [] } as unknown as GoalStopReport;
    });

    await pauseGoalForHolderRespawnRateCap(rootSql, { goalId, workspaceId: WS }, 6, Date.now());

    const [row] = await rootSql<Array<{ status: string }>>`
      SELECT status FROM harness_shared.goals WHERE id = ${goalId}`;
    expect(row?.status).toBe('active');
    expect(stops).toEqual([]); // no row changed => no stop fan-out
  }, 60_000);

  it('NEGATIVE CONTROL: the uncast form this bug shipped cannot even PARSE', async () => {
    // Reproduced inline rather than by mutating the source tree — a mutate-and-restore probe
    // races git-sync's whole-tree sweep and has committed a mutant in this repo before. This is
    // what proves the two assertions above are not passing for some unrelated reason.
    await expect(rootSql`SELECT jsonb_build_object('attemptsInWindow', ${6}) AS v`).rejects.toThrow(
      /could not determine data type of parameter/i,
    );

    // ...and the cast — exactly the fix — is what makes it parse.
    const [ok] = await rootSql<Array<{ v: { attemptsInWindow: number } }>>`
      SELECT jsonb_build_object('attemptsInWindow', ${6}::int) AS v`;
    expect(ok?.v).toEqual({ attemptsInWindow: 6 });
  }, 60_000);
});
