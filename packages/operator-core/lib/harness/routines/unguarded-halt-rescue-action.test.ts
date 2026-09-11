import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectUnguardedHalt } from '../../turn-end-tracking';
import { VERDICT_SPEAKING_FRESH_MS } from '../../agent-tools/fleet/assignments';
import { getSystemAction } from './system-actions';
import {
  DEFAULT_HALT_IDLE_MS,
  DEFAULT_HALT_MAX_IDLE_MS,
  DEFAULT_RESCUE_THROTTLE_MS,
  MAX_RESCUES_PER_TICK,
  partitionStoodDown,
  RESCUE_PREFIX,
  rescueBody,
  selectSweepCandidates,
  wakeReasonFor,
  type HaltCandidate,
} from './unguarded-halt-rescue-action';

const NOW = 1_700_000_000_000;
const IDLE = 15 * 60_000;
const MAX_IDLE = 6 * 60 * 60_000;
const OPTS = { idleMs: IDLE, maxIdleMs: MAX_IDLE };
const NONE = new Set<string>();

/** Default: an empty-handed fleet member, idle inside the window. Fleet membership
 *  is carried for message context only — it is never an eligibility input. */
function candidate(agentId: string, over: Partial<HaltCandidate> = {}): HaltCandidate {
  return {
    agentId,
    fleetSlug: 'drain-fleet',
    load: 0,
    lastToolCallMs: NOW - (IDLE + 60_000),
    ...over,
  };
}

describe('unguarded-halt rescue — targeting is by REASON TO WAKE (WI-6054)', () => {
  it('sweeps an empty-handed agent idle inside the window', () => {
    const got = selectSweepCandidates([candidate('a')], NONE, NOW, OPTS);
    expect(got.map((c) => c.agentId)).toEqual(['a']);
  });

  /**
   * THE WAKE-STORM CLASS. Measured on live data: 30+ agents had made no tool call
   * for 6-9 DAYS while still heartbeating every ~50s, and read
   * state='parked', wakeable=true — INDISTINGUISHABLE from a real orphan on every
   * liveness surface. Since WI-10001032 removed the fleet-activity conjunct, the
   * idle UPPER BOUND is the only thing excluding them, which is why it is load-
   * bearing rather than a nicety: abandonment is a time question, not a topology
   * one. Each spurious wake is a real billable turn.
   */
  it('does NOT wake a 9-day-abandoned session (past the idle upper bound)', () => {
    const nineDays = 9 * 24 * 60 * 60_000;
    const got = selectSweepCandidates(
      [candidate('zombie', { lastToolCallMs: NOW - nineDays })],
      NONE,
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  /**
   * THE INCIDENT ITSELF, pinned with its measured numbers. These are the four
   * real members of nonp2p-bug-drain-0725 (an ACTIVE fleet) at the idle times
   * observed at 14:05Z on 2026-07-26, each holding zero work while 13 items were
   * claimable under their own spec. A selector that excludes these has silently
   * regressed to the behaviour that cost ~14 agent-hours.
   */
  it('WOULD have woken all four real orphans at their observed idle times', () => {
    const observedIdleSec = [14912, 14898, 12365, 11905]; // 4.1h, 4.1h, 3.4h, 3.3h
    const orphans = observedIdleSec.map((s, i) =>
      candidate(`orphan-${i}`, { lastToolCallMs: NOW - s * 1000 }),
    );
    const got = selectSweepCandidates(orphans, NONE, NOW, OPTS);
    expect(got).toHaveLength(4);
  });

  /**
   * WI-10001032, CONJUNCT 1 REMOVED — this assertion is INVERTED from what it
   * pinned before, deliberately. The old selector required an active fleet, so
   * every solo/interactive su session was structurally invisible to the sweep.
   * The reporting agent WAS the specimen: fleet=null, halted ~2 days, and the
   * routine built for exactly that failure could not see it.
   *
   * Restoring a fleet-membership exclusion here reds this test.
   */
  it('sweeps a NON-FLEET (solo/interactive) agent — membership is never an exclusion', () => {
    const got = selectSweepCandidates([candidate('a', { fleetSlug: null })], NONE, NOW, OPTS);
    expect(got.map((c) => c.agentId)).toEqual(['a']);
  });

  /**
   * WI-10001032, CONJUNCT 2 REMOVED — also INVERTED deliberately.
   *
   * The old rule read `load > 0 => skip`, encoding "an idle agent with a nonempty
   * queue is a bug". A halted agent that HOLDS a claim is strictly worse than an
   * idle one: the item is claimed, so no peer will pick it up, and the holder is
   * silent — a deadlock with no discovery path. The old filter dropped precisely
   * that case while rescuing the benign one.
   *
   * Eligibility is universal; whether a wake is WARRANTED is `wakeReasonFor`'s
   * job (see below), which is what keeps this from becoming a wake storm.
   */
  it('sweeps a halted agent that still HOLDS work — the deadlock case', () => {
    const got = selectSweepCandidates([candidate('a', { load: 1 })], NONE, NOW, OPTS);
    expect(got.map((c) => c.agentId)).toEqual(['a']);
  });

  /**
   * A working agent has autonomous mode, no armed loop and no await — identical to
   * a halted one on those signals — because it does not NEED a wake source while
   * it is taking turns. Only turn-recency separates them.
   */
  it('does NOT wake an agent that is mid-turn', () => {
    const got = selectSweepCandidates(
      [candidate('busy', { lastToolCallMs: NOW - 30_000 })],
      NONE,
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  it('does NOT wake an agent inside a long single call (build / test suite)', () => {
    // 6 min of silence: past the 5-min "speaking" window, but plainly still working.
    const got = selectSweepCandidates(
      [candidate('building', { lastToolCallMs: NOW - 6 * 60_000 })],
      NONE,
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  it('skips an agent that has never made a tool call — no turn taken, so no halt', () => {
    const got = selectSweepCandidates([candidate('a', { lastToolCallMs: null })], NONE, NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('skips an agent rescued within the throttle window, so a rescue never becomes a wake loop', () => {
    const got = selectSweepCandidates([candidate('a')], new Set(['a']), NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('orders deterministically so a capped tick never starves the same agent', () => {
    const got = selectSweepCandidates(
      [candidate('c'), candidate('a'), candidate('b')],
      NONE,
      NOW,
      OPTS,
    );
    expect(got.map((c) => c.agentId)).toEqual(['a', 'b', 'c']);
  });
});

/**
 * THE OTHER HALF OF WI-10001032, and the reason removing two eligibility
 * conjuncts is not a wake storm.
 *
 * `selectSweepCandidates` is now universal — it asks only "is this agent halted?"
 * Whether a halt is WORTH a billable wake moved here. Detection is agent-blind;
 * waking is reason-gated. If this gate ever returns non-null for a candidate with
 * neither a held item nor claimable work, the sweep becomes a wake storm over
 * every idle agent on the box — which is exactly what the deleted conjuncts were
 * incidentally providing cover for.
 */
describe('unguarded-halt rescue — the wake REASON gate (WI-10001032)', () => {
  it('wakes a HOLDER: a claimed item nobody else can take is the deadlock case', () => {
    expect(wakeReasonFor({ load: 1, fleetSlug: null }, 0)).toEqual({ kind: 'holding', load: 1 });
  });

  it('prefers the holding reason over claimable — the deadlock is the worse story', () => {
    expect(wakeReasonFor({ load: 2, fleetSlug: 'drain-fleet' }, 13)).toEqual({
      kind: 'holding',
      load: 2,
    });
  });

  it('wakes an EMPTY-HANDED agent only when work is actually claimable', () => {
    expect(wakeReasonFor({ load: 0, fleetSlug: 'drain-fleet' }, 13)).toEqual({
      kind: 'claimable',
      claimable: 13,
      fleetSlug: 'drain-fleet',
    });
  });

  /**
   * THE WAKE-STORM GUARD. An idle agent with nothing held and nothing to claim is
   * not a halt worth paying for — it has simply finished. Returning a reason here
   * would bill a turn for every such agent, every throttle window, forever.
   */
  it('returns NO reason for an idle agent with nothing held and nothing claimable', () => {
    expect(wakeReasonFor({ load: 0, fleetSlug: 'drain-fleet' }, 0)).toBeNull();
    expect(wakeReasonFor({ load: 0, fleetSlug: null }, 0)).toBeNull();
  });

  it('carries a null fleetSlug through rather than excluding on it (solo agents)', () => {
    expect(wakeReasonFor({ load: 0, fleetSlug: null }, 4)).toEqual({
      kind: 'claimable',
      claimable: 4,
      fleetSlug: null,
    });
  });
});

describe('unguarded-halt rescue — bounds', () => {
  it('uses an idle floor well beyond the speaking window, so a long call is never a "halt"', () => {
    expect(DEFAULT_HALT_IDLE_MS).toBeGreaterThan(VERDICT_SPEAKING_FRESH_MS * 2);
  });

  it('bounds idleness ABOVE, so abandoned sessions are the reaper\'s job and never woken', () => {
    expect(DEFAULT_HALT_MAX_IDLE_MS).toBeGreaterThan(DEFAULT_HALT_IDLE_MS);
    // Must comfortably cover a real halt (the observed orphans were 3.3-4.1h idle)…
    expect(DEFAULT_HALT_MAX_IDLE_MS).toBeGreaterThanOrEqual(5 * 60 * 60_000);
    // …and fall far short of the 6-9-day heartbeating population.
    expect(DEFAULT_HALT_MAX_IDLE_MS).toBeLessThan(24 * 60 * 60_000);
  });

  it('bounds wake cost per agent and per tick', () => {
    expect(DEFAULT_RESCUE_THROTTLE_MS).toBe(60 * 60 * 1000);
    expect(MAX_RESCUES_PER_TICK).toBeGreaterThan(0);
    expect(MAX_RESCUES_PER_TICK).toBeLessThanOrEqual(25);
  });
});

describe('unguarded-halt rescue — the halt predicate it acts on', () => {
  // Pins the exact condition that stranded 4 of 10 members for 3.3-4.1h. The
  // predicate lives in turn-end-tracking (ONE definition, shared with the
  // agent-side warning); these assert the routine acts on the RIGHT one.
  const halted = { autonomousModeActive: true, loopActive: false, activeAwaitCount: 0 };

  it('flags an autonomous agent with no loop and no real await', () => {
    expect(detectUnguardedHalt(halted)).not.toBeNull();
  });

  it('does NOT flag an agent with an armed loop', () => {
    expect(detectUnguardedHalt({ ...halted, loopActive: true })).toBeNull();
  });

  it('does NOT flag an agent parked on a real await', () => {
    expect(detectUnguardedHalt({ ...halted, activeAwaitCount: 1 })).toBeNull();
  });

  it('does NOT flag an interactive session — its owner is the guaranteed next wake', () => {
    expect(detectUnguardedHalt({ ...halted, autonomousModeActive: false })).toBeNull();
  });
});

/**
 * THE EI-21275606411048371 RECURRENCE GUARD. A member whose directed work is
 * terminal and which ended its engine loop (`loop:end`) must NOT be re-woken by
 * the sweep every throttle hour just because the fleet-wide queue still admits
 * items — twice reproduced 2026-08-23 (deliveries #135568/#136380), same class
 * as dropped EI-18734910825871393. Never-armed owners stay fully rescuable.
 */
describe('unguarded-halt rescue — stood-down suppression (ended engine loop)', () => {
  const a = candidate('stood-down');
  const b = candidate('never-armed');

  it('suppresses an owner whose loop row(s) are ALL inactive, keeps the rest', () => {
    const { rescuable, stoodDown } = partitionStoodDown([a, b], {
      'stood-down': [{ active: false }],
    });
    expect(stoodDown.map((c) => c.agentId)).toEqual(['stood-down']);
    expect(rescuable.map((c) => c.agentId)).toEqual(['never-armed']);
  });

  it('does NOT suppress an owner with any ACTIVE loop row (defense in depth)', () => {
    const { rescuable, stoodDown } = partitionStoodDown([a], {
      'stood-down': [{ active: false }, { active: true }],
    });
    expect(stoodDown).toEqual([]);
    expect(rescuable.map((c) => c.agentId)).toEqual(['stood-down']);
  });

  /**
   * THE HOLDER EXCEPTION (WI-10001032) — the deadlock path, and the one case
   * where stand-down must NOT win.
   *
   * Stand-down excuses an agent that finished and went quiet. It cannot excuse
   * one that went quiet still HOLDING a claim: nobody else can take that item,
   * and the holder is silent, so suppressing it parks the item behind a dead
   * holder indefinitely. Suppressing a holder here re-creates exactly the
   * deadlock this routine exists to break — so it reds a test instead.
   */
  it('does NOT suppress a HOLDER, even with an ended loop — a claim outranks wind-down', () => {
    const holder = candidate('stood-down', { load: 1 });
    const { rescuable, stoodDown } = partitionStoodDown([holder], {
      'stood-down': [{ active: false }],
    });
    expect(stoodDown).toEqual([]);
    expect(rescuable.map((c) => c.agentId)).toEqual(['stood-down']);
  });

  it('still suppresses an EMPTY-HANDED owner with the same ended loop (the contrast)', () => {
    const { rescuable, stoodDown } = partitionStoodDown([candidate('stood-down', { load: 0 })], {
      'stood-down': [{ active: false }],
    });
    expect(rescuable).toEqual([]);
    expect(stoodDown.map((c) => c.agentId)).toEqual(['stood-down']);
  });

  it('fails OPEN: a failed reader (null) suppresses nobody — pre-fix behavior', () => {
    const { rescuable, stoodDown } = partitionStoodDown([a, b], null);
    expect(stoodDown).toEqual([]);
    expect(rescuable.map((c) => c.agentId)).toEqual(['stood-down', 'never-armed']);
  });

  it('wires the partition BEFORE the per-agent claimability fan-out (order pin)', () => {
    const src = readFileSync(join(__dirname, 'unguarded-halt-rescue-action.ts'), 'utf8');
    const sweepAt = src.indexOf('selectSweepCandidates(');
    const partitionAt = src.indexOf('partitionStoodDown(candidates, loopRows)');
    const claimableAt = src.indexOf('claimabilityForCandidate(candidate, ctx.workspaceId)');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(partitionAt).toBeGreaterThan(sweepAt);
    expect(claimableAt).toBeGreaterThan(partitionAt);
  });
});

describe('unguarded-halt rescue — wiring', () => {
  it('is registered as a SYSTEM action', () => {
    expect(getSystemAction('unguarded-halt-rescue')).toBeTypeOf('function');
  });

  it('tells the agent work is actually waiting, and how to re-arm', () => {
    const body = rescueBody('drain-fleet', 13);
    expect(body).toContain('13 item(s) are claimable');
    expect(body).toContain('drain-fleet');
    expect(body).toContain('scheduler:get_next');
    expect(body).toContain('loop:arm');
    // Must not read as a peer message — an agent that thinks a human pinged it
    // will reply instead of resuming work.
    expect(body).toContain('there is no one to reply to');
  });

  it('reports the structured loop-repair outcome instead of hiding recurrence failure', () => {
    const repaired = rescueBody('drain-fleet', 2, {
      armed: true,
      reason: 'armed',
      loopName: 'loop-member-7',
    });
    expect(repaired).toContain('SYSTEM REPAIR: your recurring loop is now armed (loop-member-7).');
    expect(repaired).toContain('Verify with loop:status');

    const failed = rescueBody('drain-fleet', 2, {
      armed: false,
      reason: 'fleet-claim-spec-unresolved',
    });
    expect(failed).toContain('SYSTEM REPAIR COULD NOT ARM YOUR LOOP (fleet-claim-spec-unresolved).');
    expect(failed).toContain('restore recurrence with loop:arm');
  });

  it('arms recurrence before writing the rescue inbox row or issuing the wake', () => {
    const src = readFileSync(join(__dirname, 'unguarded-halt-rescue-action.ts'), 'utf8');
    const armAt = src.indexOf('autoArmFleetMemberLoop({');
    const inboxAt = src.indexOf('sendMessage(RESCUE_IDENTITY', armAt);
    const wakeAt = src.indexOf('wakeRecipients([c.agentId]', inboxAt);
    expect(armAt).toBeGreaterThan(-1);
    expect(inboxAt).toBeGreaterThan(armAt);
    expect(wakeAt).toBeGreaterThan(inboxAt);
  });

  it('marks its own outbox rows so the throttle can find them', () => {
    expect(RESCUE_PREFIX.length).toBeGreaterThan(0);
    expect(rescueBody('f', 1)).not.toContain(RESCUE_PREFIX);
  });

  /**
   * THE ACTUAL REGRESSION GUARD (WI-6054).
   *
   * The detector was correct and tested, yet never fired for the failure it was
   * built for, because its ONLY production caller was the AGENT-INVOKED
   * `journal:record-turn` tool — and an agent that simply stops never calls it.
   * A guard whose sole invocation path is one the failing party must
   * voluntarily take is not a guard.
   *
   * This asserts the sweep retains at least one SYSTEM-side caller (a routine),
   * so deleting or un-wiring this routine reds a test instead of silently
   * restoring the 4-agents-dark-for-4-hours behaviour.
   */
  it('keeps a SYSTEM-side caller of the halt sweep — not only the agent-invoked tool', () => {
    const dir = __dirname;
    const callers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes('boundedUnguardedHaltSweep'));
    expect(callers.length).toBeGreaterThan(0);
  });

  /**
   * OBSERVABILITY GUARD (WI-6054) — found while verifying this very routine
   * after its first deploy.
   *
   * The quiet path used to `return` silently, which made "ran, and correctly
   * found nothing to do" byte-identical to "never ran at all". The routines row
   * cannot break that tie: `last_fired_at` advances on every tick either way —
   * it advanced on schedule for the whole window in which this handler was NOT
   * yet deployed and the engine skipped it with a "no handler registered" warn.
   * So on the overwhelmingly common no-op tick there was no evidence anywhere
   * that the deployed sweep was alive, and confirming the routine actually
   * executes after a deploy was impossible.
   *
   * One line per tick restores that. Deleting it silently re-creates an
   * unverifiable guard, which is the same defect class this routine exists to
   * fix — so it reds a test instead.
   */
  it('logs on the quiet path, so a correct no-op is distinguishable from never running', () => {
    const src = readFileSync(join(__dirname, 'unguarded-halt-rescue-action.ts'), 'utf8');
    const guard = src.indexOf('candidates.length === 0');
    expect(guard).toBeGreaterThan(-1);
    const quietPath = src.slice(guard, src.indexOf('return;', guard));
    expect(quietPath).toContain('console.log');
    expect(quietPath).toContain('nothing to rescue');
  });
});
