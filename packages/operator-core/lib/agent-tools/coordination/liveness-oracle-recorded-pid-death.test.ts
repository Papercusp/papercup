/**
 * liveness-oracle-recorded-pid-death.test.ts — EI-21572355077403526.
 *
 * THE EXECUTABLE SPEC: an affirmative ESRCH (`probePidFn` → `false`) beats the
 * `recorded` session-log rescue, and NOTHING WEAKER does.
 *
 * WHY THIS IS GUARDED. `recorded` infers liveness from
 * `adv_sessions.ended_at IS NULL`. That column is written by a session-end hook
 * that **SIGKILL bypasses**, so for a killed session the row is STALE rather
 * than live. The classification short-circuited to `recorded` BEFORE the
 * heartbeat/pid path, so the stale row outranked a direct OS observation that
 * the process was gone — permanently, since nothing would ever come back to
 * write `ended_at`.
 *
 * The consequence was not cosmetic. `holderCountsAsAlive` (goals/holder.ts)
 * treats `recorded` as alive, so a goal whose holder had been killed:
 *   - refused every relaunch with `already-held`, forever, AND
 *   - never fired `launch_settings.holder.onLoss: 'deactivate'`,
 * leaving the goal wedged `active` behind a dead holder. Observed 2026-08-27 on
 * goal `…-9425fe`; the only way out was hand-retiring the stale `agent_modes`
 * row via `mode:set { enabled:false }`, which is undiscoverable.
 *
 * THE SHAPE OF THIS TEST. Each case is a PAIR sharing one subject and one
 * wakeability map, differing ONLY in the pid probe. That is what makes it a
 * measurement rather than an assertion: the `null` twin is a positive control
 * proving the setup really does produce `recorded`, so a green `false` twin
 * cannot be an artifact of a subject that was never `recorded` to begin with.
 * A fix that simply deleted the `recorded` branch would pass the first
 * assertion of every pair and fail the second.
 */
import { describe, expect, it } from 'vitest';
import { resolveSessionStates, type LivenessSubject } from './liveness-oracle';
import type { WakeabilitySignals } from './presence-wakeability';
import { holderCountsAsAlive, resolveGoalHoldersFromRows } from '../../goals/holder';

const NOW = Date.parse('2026-08-27T02:45:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const OWNER = 'su-test-killed-holder';
/** Any non-null host; the pid probe is injected, so the value is inert here. */
const HOST = 'test-host';

/** A killed holder: heartbeat still warm, no live turn, not wakeable. */
const killedHolder: LivenessSubject = {
  ownerId: OWNER,
  heartbeatAt: iso(5_000),
  stale: false,
  host: HOST,
  pid: 3959493,
};

/** Not wakeable + no turn in flight — the exact gate `recordedLiveOnly` opens on. */
const NOT_WAKEABLE: WakeabilitySignals = { wakeable: false, liveTurn: false };

/**
 * Everything pinned to a PG-free seam. `pidProbe` is the ONLY variable; the
 * owner is always in the recorded-live set, so absent a pid verdict the subject
 * is unambiguously `recorded`.
 */
const opts = (pidProbe: () => boolean | null) => ({
  nowMs: NOW,
  fetchWakeabilityFn: async () => new Map([[OWNER, NOT_WAKEABLE]]),
  fetchRecordedLiveFn: async () => new Set<string>([OWNER]),
  fetchRecordedEndedFn: async () => new Set<string>(),
  probePidFn: pidProbe,
  findHostFn: () => null,
});

const verdictFor = async (pidProbe: () => boolean | null) => {
  const out = await resolveSessionStates([killedHolder], opts(pidProbe));
  const v = out.get(OWNER);
  if (!v) throw new Error('oracle omitted the subject — totality contract broken');
  return v;
};

describe('EI-21572355077403526 — an affirmative ESRCH disqualifies the `recorded` rescue', () => {
  it('POSITIVE CONTROL: with an inconclusive probe the subject really is `recorded`', async () => {
    // If this ever stops being `recorded`, every other case below is measuring
    // nothing and their green means nothing.
    expect((await verdictFor(() => null)).sessionState).toBe('recorded');
  });

  it('a CONFIRMED-DEAD pid is no longer `recorded`', async () => {
    const v = await verdictFor(() => false);
    expect(v.sessionState).not.toBe('recorded');
    // No claims held ⇒ the honest verdict is positively gone.
    expect(v.sessionState).toBe('ended');
  });

  it('repaired PID loss contract: real-pid-loss (WI-1074216)', async () => {
    // This is the oracle's unit seam, paired with the existing real-process
    // integration receipt. The wrong probe preserves the stale recorded rescue.
    const wrongProbe = process.env.PAPERCUSP_GOAL_PID_LOSS_CONTROL === 'real-pid-loss';
    const v = await verdictFor(() => wrongProbe ? true : false);
    expect(v.sessionState, 'pid-loss-contract:real-pid-loss').toBe('ended');
  });

  it('a probe reporting the process ALIVE leaves `recorded` intact', async () => {
    // Guards the disqualifier against being written as a mere truthiness check:
    // only `=== false` may disqualify, never `true`.
    expect((await verdictFor(() => true)).sessionState).toBe('recorded');
  });
});

describe('EI-21572355077403526 — the SECOND resurrection path: the psu-host positive rescue', () => {
  /**
   * Guarding only `recordedLiveOnly` would have been a HALF-FIX. A
   * confirmed-dead subject falls through to `deriveSessionState` (→ `ended`)
   * and the psu-host "positive" leg then flips `ended` straight back to
   * `recorded` for a non-wakeable owner — re-arming the identical
   * unrelaunchable-goal trap through a different leg.
   *
   * This subject is deliberately NOT in the recorded-live set, so the ONLY
   * thing that can produce `recorded` here is the psu-host leg.
   */
  const hostRescued: LivenessSubject = {
    ...killedHolder,
    ownerId: 'su-test-host-rescued',
    agentRole: 'su', // must be a known non-cup role for psuHostKnownRole
  };

  const hostOpts = (pidProbe: () => boolean | null) => ({
    nowMs: NOW,
    fetchWakeabilityFn: async () => new Map([[hostRescued.ownerId, NOT_WAKEABLE]]),
    fetchRecordedLiveFn: async () => new Set<string>(), // NOT recorded-live
    fetchRecordedEndedFn: async () => new Set<string>(),
    probePidFn: pidProbe,
    psuHostPositiveAuthority: true,
    findHostFn: () => ({ live: true }), // a live psu host witness
  });

  const stateFor = async (pidProbe: () => boolean | null) => {
    const out = await resolveSessionStates([hostRescued], hostOpts(pidProbe));
    return out.get(hostRescued.ownerId)?.sessionState;
  };

  it('POSITIVE CONTROL: an inconclusive probe still lets the host rescue produce `recorded`', async () => {
    // Proves the rescue leg is genuinely reachable in this setup. Without this,
    // the assertion below could pass simply because nothing ever rescued.
    expect(await stateFor(() => null)).toBe('recorded');
  });

  it('a confirmed-dead pid is NOT rescued back to `recorded` by a live host witness', async () => {
    expect(await stateFor(() => false)).not.toBe('recorded');
  });
});

describe('EI-21572355077403526 — the goal-holder consequence that actually broke', () => {
  const holderRow = {
    goalId: 'the-papercusp-desktop-gui-is-verified-end-to-end-9425fe',
    workspaceId: 'papercusp-workspace',
    ownerId: OWNER,
    setAtMs: NOW - 7_000_000,
  };

  const holdersWith = async (pidProbe: () => boolean | null) => {
    const verdicts = await resolveSessionStates([killedHolder], opts(pidProbe));
    return resolveGoalHoldersFromRows(
      holderRow.goalId,
      holderRow.workspaceId,
      [holderRow],
      verdicts as never,
    );
  };

  it('POSITIVE CONTROL: an inconclusive probe still reads `held` (generosity preserved)', async () => {
    // This is the behaviour the holder.ts docblock deliberately wants: a false
    // "abandoned" on a goal someone is actively working is worse than a late
    // alarm. The fix must NOT cost us this.
    expect((await holdersWith(() => null)).liveness).toBe('held');
  });

  it('a killed holder no longer blocks relaunch: liveness is `lost`, not `held`', async () => {
    const holders = await holdersWith(() => false);
    // `held` here is what produced the permanent `already-held` refusal.
    expect(holders.liveness).not.toBe('held');
    expect(holders.liveness).toBe('lost');
    expect(holders.live).toHaveLength(0);
    expect(holders.holders[0]?.live).toBe(false);
  });

  it('holderCountsAsAlive agrees, so onLoss:deactivate can finally fire', async () => {
    const holders = await holdersWith(() => false);
    const verdict = {
      ownerId: OWNER,
      sessionState: holders.holders[0]!.sessionState,
      selfWake: holders.holders[0]!.selfWake,
    };
    expect(holderCountsAsAlive(verdict as never)).toBe(false);
  });
});
