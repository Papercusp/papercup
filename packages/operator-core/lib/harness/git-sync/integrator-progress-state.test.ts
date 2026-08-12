import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTEGRATOR_STALL_PREEMPT_MS,
  isIntegratorNamespaceBacklogged,
  nextIntegratorProgressState,
  shouldPreemptStalledIntegrator,
  type IntegratorProgressState,
} from './integrator-progress-state';

const T0 = 1_700_000_000_000;
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('isIntegratorNamespaceBacklogged', () => {
  it('does not admit a peer whose namespace ref is absent', () => {
    expect(isIntegratorNamespaceBacklogged({ namespaceSha: null, canonicalSha: SHA_A, aheadCommits: 3 })).toBe(false);
  });

  it('excludes a peer whose namespace is at or behind canonical', () => {
    expect(isIntegratorNamespaceBacklogged({ namespaceSha: SHA_A, canonicalSha: SHA_A, aheadCommits: 0 })).toBe(false);
    expect(isIntegratorNamespaceBacklogged({ namespaceSha: SHA_A, canonicalSha: SHA_B, aheadCommits: 0 })).toBe(false);
  });

  it('keeps a peer with verified unintegrated commits eligible', () => {
    expect(isIntegratorNamespaceBacklogged({ namespaceSha: SHA_B, canonicalSha: SHA_A, aheadCommits: 2 })).toBe(true);
  });

  it('fails open when canonical or the ahead count cannot be measured', () => {
    expect(isIntegratorNamespaceBacklogged({ namespaceSha: SHA_B, canonicalSha: null, aheadCommits: null })).toBe(true);
    expect(isIntegratorNamespaceBacklogged({ namespaceSha: SHA_B, canonicalSha: SHA_A, aheadCommits: null })).toBe(true);
  });
});

describe('nextIntegratorProgressState', () => {
  it('never reports a stall on the first-ever observation (no cold-start alarm)', () => {
    const s = nextIntegratorProgressState(null, { canonicalSha: SHA_A, backlogCommits: 99, nowMs: T0 });
    // Backlog is huge, but we have NO evidence canonical stood still — there is
    // no remembered sha to compare against. A guard must not fire on its own
    // cold start, or every fresh row preempts immediately.
    expect(s.stalledSinceMs).toBeNull();
    expect(s.canonicalSha).toBe(SHA_A);
  });

  it('clears the stall when canonical ADVANCES', () => {
    const prior = { canonicalSha: SHA_A, stalledSinceMs: T0, at: T0 };
    const s = nextIntegratorProgressState(prior, { canonicalSha: SHA_B, backlogCommits: 5, nowMs: T0 + 60_000 });
    expect(s.stalledSinceMs).toBeNull();
    expect(s.canonicalSha).toBe(SHA_B);
  });

  it('THE FALSE-ALARM CASE: same sha but NO backlog is healthy idle, not a stall', () => {
    // An integrator with nothing to merge is CORRECT to leave canonical alone.
    // Counting that as a stall is the exact false alarm that nearly shipped on
    // the detector side, where the instantaneous backlog delta is nonzero on a
    // busy pot almost always.
    const prior = { canonicalSha: SHA_A, stalledSinceMs: null, at: T0 };
    const s = nextIntegratorProgressState(prior, { canonicalSha: SHA_A, backlogCommits: 0, nowMs: T0 + 60_000 });
    expect(s.stalledSinceMs).toBeNull();
  });

  it('clears an EXISTING stall the moment backlog drains, even if canonical never moved', () => {
    const prior = { canonicalSha: SHA_A, stalledSinceMs: T0, at: T0 };
    const s = nextIntegratorProgressState(prior, { canonicalSha: SHA_A, backlogCommits: 0, nowMs: T0 + 60_000 });
    expect(s.stalledSinceMs).toBeNull();
  });

  it('starts the clock when canonical is stuck AND there is backlog', () => {
    const prior = { canonicalSha: SHA_A, stalledSinceMs: null, at: T0 };
    const s = nextIntegratorProgressState(prior, { canonicalSha: SHA_A, backlogCommits: 3, nowMs: T0 + 60_000 });
    expect(s.stalledSinceMs).toBe(T0 + 60_000);
  });

  it('NEVER restarts a running stall clock — the regression that would make preemption unreachable', () => {
    // If each tick reset stalledSinceMs to now, the elapsed budget could never
    // be reached and the takeover would be dead code that looks healthy. This
    // is the `worktree_bridge` accept-free failure mode, one layer more costly.
    let state: IntegratorProgressState = { canonicalSha: SHA_A, stalledSinceMs: T0, at: T0 };
    for (let i = 1; i <= 200; i++) {
      state = nextIntegratorProgressState(state, {
        canonicalSha: SHA_A,
        backlogCommits: 7,
        nowMs: T0 + i * 60_000,
      });
    }
    expect(state.stalledSinceMs).toBe(T0);
    expect(state.at).toBe(T0 + 200 * 60_000);
  });

  it('carries the prior verdict verbatim when canonical is UNREADABLE (an IO blip is not progress)', () => {
    const prior = { canonicalSha: SHA_A, stalledSinceMs: T0, at: T0 };
    const s = nextIntegratorProgressState(prior, { canonicalSha: null, backlogCommits: 4, nowMs: T0 + 60_000 });
    // Must not read as progress (that would reset a real stall) nor invent one.
    expect(s.stalledSinceMs).toBe(T0);
    expect(s.canonicalSha).toBe(SHA_A);
  });

  it('an unreadable tick does not invent a stall out of a healthy prior', () => {
    const prior = { canonicalSha: SHA_A, stalledSinceMs: null, at: T0 };
    const s = nextIntegratorProgressState(prior, { canonicalSha: null, backlogCommits: 4, nowMs: T0 + 60_000 });
    expect(s.stalledSinceMs).toBeNull();
  });

  it('tolerates a malformed/partial prior jsonb row without throwing', () => {
    const s = nextIntegratorProgressState({}, { canonicalSha: SHA_A, backlogCommits: 5, nowMs: T0 });
    expect(s.stalledSinceMs).toBeNull();
    expect(s.canonicalSha).toBe(SHA_A);
  });

  it('writes EVERY field on every transition (patchRoutineMetadata is a top-level merge)', () => {
    // An omitted field is DELETED silently. Assert the full key set on each of
    // the four transitions rather than trusting a spot check.
    const ticks = [
      { prior: null, tick: { canonicalSha: SHA_A, backlogCommits: 0, nowMs: T0 } },
      { prior: { canonicalSha: SHA_A, stalledSinceMs: T0, at: T0 }, tick: { canonicalSha: SHA_B, backlogCommits: 1, nowMs: T0 } },
      { prior: { canonicalSha: SHA_A, stalledSinceMs: null, at: T0 }, tick: { canonicalSha: SHA_A, backlogCommits: 9, nowMs: T0 } },
      { prior: { canonicalSha: SHA_A, stalledSinceMs: T0, at: T0 }, tick: { canonicalSha: null, backlogCommits: 9, nowMs: T0 } },
    ];
    for (const { prior, tick } of ticks) {
      const s = nextIntegratorProgressState(prior, tick);
      expect(Object.keys(s).sort()).toEqual(['at', 'canonicalSha', 'stalledSinceMs']);
    }
  });
});

describe('shouldPreemptStalledIntegrator', () => {
  const stalled = (sinceMs: number | null): IntegratorProgressState => ({
    canonicalSha: SHA_A,
    stalledSinceMs: sinceMs,
    at: T0,
  });

  it('does not preempt when there is nothing to integrate', () => {
    // The holder is not failing at anything if there is no work.
    expect(
      shouldPreemptStalledIntegrator({ state: stalled(T0), backlogCommits: 0, nowMs: T0 + 10 * 60 * 60 * 1000 }),
    ).toBe(false);
  });

  it('does not preempt when not stalled', () => {
    expect(
      shouldPreemptStalledIntegrator({ state: stalled(null), backlogCommits: 50, nowMs: T0 + 10 * 60 * 60 * 1000 }),
    ).toBe(false);
  });

  it('does not preempt below the budget', () => {
    expect(
      shouldPreemptStalledIntegrator({
        state: stalled(T0),
        backlogCommits: 28,
        nowMs: T0 + DEFAULT_INTEGRATOR_STALL_PREEMPT_MS - 1,
      }),
    ).toBe(false);
  });

  it('preempts exactly AT the budget boundary', () => {
    expect(
      shouldPreemptStalledIntegrator({
        state: stalled(T0),
        backlogCommits: 28,
        nowMs: T0 + DEFAULT_INTEGRATOR_STALL_PREEMPT_MS,
      }),
    ).toBe(true);
  });

  it('honours an explicit stallMs override', () => {
    expect(
      shouldPreemptStalledIntegrator({ state: stalled(T0), backlogCommits: 1, nowMs: T0 + 1000, stallMs: 999 }),
    ).toBe(true);
    expect(
      shouldPreemptStalledIntegrator({ state: stalled(T0), backlogCommits: 1, nowMs: T0 + 1000, stallMs: 1001 }),
    ).toBe(false);
  });

  it('reproduces the 2026-08-03 incident: 5.4h stuck with 28 commits behind ⇒ preempt', () => {
    const state = stalled(T0);
    const nowMs = T0 + Math.round(5.4 * 60 * 60 * 1000);
    expect(shouldPreemptStalledIntegrator({ state, backlogCommits: 28, nowMs })).toBe(true);
  });

  it('reproduces the 2026-08-02 incident: ~5h stuck with 70 commits behind ⇒ preempt', () => {
    const state = stalled(T0);
    const nowMs = T0 + 5 * 60 * 60 * 1000;
    expect(shouldPreemptStalledIntegrator({ state, backlogCommits: 70, nowMs })).toBe(true);
  });

  it('NEVER preempts a healthy busy pot, however long it runs (end-to-end over both fns)', () => {
    // The realistic false-positive shape: backlog is CONTINUOUSLY nonzero
    // because git-sync keeps committing, but canonical advances each tick.
    // A naive "backlog > 0 for N ticks" rule would preempt here within the hour.
    let state = nextIntegratorProgressState(null, { canonicalSha: `sha0`, backlogCommits: 4, nowMs: T0 });
    for (let i = 1; i <= 500; i++) {
      const nowMs = T0 + i * 3 * 60_000; // a tick every 3 minutes for 25h
      state = nextIntegratorProgressState(state, {
        canonicalSha: `sha${i}`, // canonical MOVES every tick — a working integrator
        backlogCommits: 4, // and there is always fresh work
        nowMs,
      });
      expect(shouldPreemptStalledIntegrator({ state, backlogCommits: 4, nowMs })).toBe(false);
    }
  });

  it('preempts a pot that goes from healthy into a genuine stall, once the budget elapses', () => {
    let state = nextIntegratorProgressState(null, { canonicalSha: SHA_A, backlogCommits: 2, nowMs: T0 });
    state = nextIntegratorProgressState(state, { canonicalSha: SHA_B, backlogCommits: 2, nowMs: T0 + 60_000 });
    expect(shouldPreemptStalledIntegrator({ state, backlogCommits: 2, nowMs: T0 + 60_000 })).toBe(false);

    // Canonical now freezes at SHA_B while work keeps arriving.
    const freezeAt = T0 + 120_000;
    state = nextIntegratorProgressState(state, { canonicalSha: SHA_B, backlogCommits: 3, nowMs: freezeAt });
    expect(state.stalledSinceMs).toBe(freezeAt);

    const justBefore = freezeAt + DEFAULT_INTEGRATOR_STALL_PREEMPT_MS - 1;
    state = nextIntegratorProgressState(state, { canonicalSha: SHA_B, backlogCommits: 9, nowMs: justBefore });
    expect(shouldPreemptStalledIntegrator({ state, backlogCommits: 9, nowMs: justBefore })).toBe(false);

    const atBudget = freezeAt + DEFAULT_INTEGRATOR_STALL_PREEMPT_MS;
    state = nextIntegratorProgressState(state, { canonicalSha: SHA_B, backlogCommits: 9, nowMs: atBudget });
    expect(shouldPreemptStalledIntegrator({ state, backlogCommits: 9, nowMs: atBudget })).toBe(true);
  });

  it('budget is 2h and is 2x the detector alert budget (warn first, act at double)', () => {
    expect(DEFAULT_INTEGRATOR_STALL_PREEMPT_MS).toBe(2 * 60 * 60 * 1000);
  });
});
