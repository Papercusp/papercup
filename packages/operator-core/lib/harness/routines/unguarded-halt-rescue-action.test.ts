import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectUnguardedHalt } from '../../turn-end-tracking';
import { VERDICT_SPEAKING_FRESH_MS } from '../../agent-tools/fleet/assignments';
import { getSystemAction } from './system-actions';
import {
  DEFAULT_HALT_IDLE_MS,
  DEFAULT_RESCUE_THROTTLE_MS,
  MAX_RESCUES_PER_TICK,
  RESCUE_PREFIX,
  rescueBody,
  selectSweepCandidates,
  type HaltCandidate,
} from './unguarded-halt-rescue-action';

const NOW = 1_700_000_000_000;
const STALE = 5 * 60_000;
const IDLE = 15 * 60_000;
const OPTS = { staleMs: STALE, idleMs: IDLE };

/** Default candidate: process alive, and idle long enough to be a real halt. */
function candidate(
  agentId: string,
  over: Partial<HaltCandidate> = {},
): HaltCandidate {
  return {
    agentId,
    workspaceId: 'ws',
    heartbeatMs: NOW - 1_000,
    lastToolCallMs: NOW - (IDLE + 1_000),
    ...over,
  };
}

describe('unguarded-halt rescue — candidate selection (WI-6054)', () => {
  it('sweeps a live-but-idle agent — heartbeat fresh, no turn for well over the idle window', () => {
    const got = selectSweepCandidates([candidate('a')], new Set(), NOW, OPTS);
    expect(got.map((c) => c.agentId)).toEqual(['a']);
  });

  it('skips an agent whose heartbeat is stale — a dead session is the reaper\'s job, not a wake target', () => {
    const got = selectSweepCandidates(
      [candidate('a', { heartbeatMs: NOW - (STALE + 1) })],
      new Set(),
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  it('skips an agent with no heartbeat at all', () => {
    const got = selectSweepCandidates([candidate('a', { heartbeatMs: null })], new Set(), NOW, OPTS);
    expect(got).toEqual([]);
  });

  /**
   * THE FALSE-POSITIVE CLASS. A busy agent has autonomous mode, no armed loop and
   * no await — identical to a halted one on those three signals — because it does
   * not NEED a wake source while it is taking turns. Heartbeat cannot separate
   * them either: a halted agent keeps heartbeating (the observed orphans read
   * heartbeatFresh:true with lastActive 3-4h ago). Only turn-recency can.
   * Waking a working agent is a spurious billable interruption.
   */
  it('does NOT wake an agent that is mid-turn', () => {
    const got = selectSweepCandidates(
      [candidate('busy', { lastToolCallMs: NOW - 30_000 })],
      new Set(),
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  it('does NOT wake an agent inside a long single call (build / test suite) below the idle window', () => {
    // 6 min of silence: past the 5-min "speaking" window, but plainly still working.
    const got = selectSweepCandidates(
      [candidate('building', { lastToolCallMs: NOW - 6 * 60_000 })],
      new Set(),
      NOW,
      OPTS,
    );
    expect(got).toEqual([]);
  });

  it('skips an agent that has never made a tool call — no turn taken, so no halt to rescue', () => {
    const got = selectSweepCandidates([candidate('a', { lastToolCallMs: null })], new Set(), NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('uses an idle window well beyond the speaking window, so a long call is never mistaken for a halt', () => {
    expect(DEFAULT_HALT_IDLE_MS).toBeGreaterThan(VERDICT_SPEAKING_FRESH_MS * 2);
  });

  it('skips an agent rescued within the throttle window, so a rescue never becomes a wake loop', () => {
    const got = selectSweepCandidates([candidate('a')], new Set(['a']), NOW, OPTS);
    expect(got).toEqual([]);
  });

  it('orders deterministically so a capped tick never starves the same agent', () => {
    const got = selectSweepCandidates(
      [candidate('c'), candidate('a'), candidate('b')],
      new Set(),
      NOW,
      OPTS,
    );
    expect(got.map((c) => c.agentId)).toEqual(['a', 'b', 'c']);
  });

  it('bounds wake cost by default', () => {
    expect(DEFAULT_RESCUE_THROTTLE_MS).toBe(60 * 60 * 1000);
    expect(MAX_RESCUES_PER_TICK).toBeGreaterThan(0);
    expect(MAX_RESCUES_PER_TICK).toBeLessThanOrEqual(25);
  });
});

describe('unguarded-halt rescue — the halt predicate it acts on', () => {
  // These pin the exact condition that stranded 4 of 10 members of
  // nonp2p-bug-drain-0725 for 3.3-4.1h. The predicate lives in
  // turn-end-tracking (one definition, shared with the agent-side warning);
  // these assert the rescue routine is acting on the RIGHT one.
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

describe('unguarded-halt rescue — wiring', () => {
  it('is registered as a SYSTEM action', () => {
    expect(getSystemAction('unguarded-halt-rescue')).toBeTypeOf('function');
  });

  it('tells a rescued agent to re-measure rather than trust its stale drained verdict', () => {
    const body = rescueBody();
    expect(body).toContain('work_items:claimable');
    expect(body).toContain('loop:arm');
    // The rescue must not read as a peer message — an agent that thinks a human
    // pinged it will reply instead of resuming work.
    expect(body).toContain('system-side unguarded-halt sweep');
  });

  it('marks its own outbox rows so the throttle can find them', () => {
    expect(RESCUE_PREFIX.length).toBeGreaterThan(0);
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
});
