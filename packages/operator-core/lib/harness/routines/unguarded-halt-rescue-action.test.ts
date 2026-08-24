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
  type HaltCandidate,
} from './unguarded-halt-rescue-action';

const NOW = 1_700_000_000_000;
const IDLE = 15 * 60_000;
const MAX_IDLE = 6 * 60 * 60_000;
const OPTS = { idleMs: IDLE, maxIdleMs: MAX_IDLE };
const ACTIVE = new Set(['drain-fleet']);
const NONE = new Set<string>();

/** Default: an empty-handed member of an ACTIVE fleet, idle inside the window. */
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
  it('sweeps an empty-handed member of an active fleet, idle inside the window', () => {
    const got = selectSweepCandidates([candidate('a')], NONE, ACTIVE, NOW, OPTS);
    expect(got.map((c) => c.agentId)).toEqual(['a']);
  });

  /**
   * THE WAKE-STORM CLASS. Measured on live data: 30+ agents had made no tool call
   * for 6-9 DAYS while still heartbeating every ~50s, and read
   * state='parked', wakeable=true — INDISTINGUISHABLE from a real orphan on every
   * liveness surface. Only the fleet-active + idle-upper-bound conjuncts exclude
   * them. Each spurious wake is a real billable turn.
   */
  it('does NOT wake a 9-day-abandoned session (past the idle upper bound)', () => {
    const nineDays = 9 * 24 * 60 * 60_000;
    const got = selectSweepCandidates(
      [candidate('zombie', { lastToolCallMs: NOW - nineDays })],
      NONE,
      ACTIVE,
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
    const got = selectSweepCandidates(orphans, NONE, ACTIVE, NOW, OPTS);
    expect(got).toHaveLength(4);
  });

  it('does NOT wake a member whose fleet is winding down or unknown', () => {
    const got = selectSweepCandidates([candidate('a')], NONE, NONE, NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('does NOT wake a non-member (no fleet at all)', () => {
    const got = selectSweepCandidates([candidate('a', { fleetSlug: null })], NONE, ACTIVE, NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('does NOT wake an agent that still holds work — it has something to resume', () => {
    const got = selectSweepCandidates([candidate('a', { load: 1 })], NONE, ACTIVE, NOW, OPTS);
    expect(got).toEqual([]);
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
      ACTIVE,
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
      ACTIVE,
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  it('skips an agent that has never made a tool call — no turn taken, so no halt', () => {
    const got = selectSweepCandidates([candidate('a', { lastToolCallMs: null })], NONE, ACTIVE, NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('skips an agent rescued within the throttle window, so a rescue never becomes a wake loop', () => {
    const got = selectSweepCandidates([candidate('a')], new Set(['a']), ACTIVE, NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('orders deterministically so a capped tick never starves the same agent', () => {
    const got = selectSweepCandidates(
      [candidate('c'), candidate('a'), candidate('b')],
      NONE,
      ACTIVE,
      NOW,
      OPTS,
    );
    expect(got.map((c) => c.agentId)).toEqual(['a', 'b', 'c']);
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

  it('fails OPEN: a failed reader (null) suppresses nobody — pre-fix behavior', () => {
    const { rescuable, stoodDown } = partitionStoodDown([a, b], null);
    expect(stoodDown).toEqual([]);
    expect(rescuable.map((c) => c.agentId)).toEqual(['stood-down', 'never-armed']);
  });

  it('wires the partition BEFORE the per-agent claimability fan-out (order pin)', () => {
    const src = readFileSync(join(__dirname, 'unguarded-halt-rescue-action.ts'), 'utf8');
    const sweepAt = src.indexOf('selectSweepCandidates(');
    const partitionAt = src.indexOf('partitionStoodDown(candidates, loopRows)');
    const claimableAt = src.indexOf('claimableForCandidate(candidate, ctx.workspaceId)');
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
