import { describe, expect, it } from 'vitest';
import {
  FEATURE_STATES,
  FEATURE_STATE_FORWARD,
  FEATURE_STATE_ORDER,
  FEATURE_TERMINAL_STATES,
  attemptTransition,
  compareFeatureStatesByLifecycle,
  hasCompletionRefSurface,
  isActiveState,
  isLegalTransition,
  isOrchestratorPickable,
  isTerminal,
  resetTargetForFailure,
} from './feature-state-types';
import { type CompletionRef } from './completion-ref-types';

const SHA1 = 'a'.repeat(40);

const SAMPLE_COMPLETION_REF: CompletionRef = {
  remote: 'git@github.com:x/y.git',
  branch: 'user/12345',
  commit_sha: SHA1,
  pr_url: 'https://github.com/x/y/pull/1',
  schema_version: 1,
};

describe('constants', () => {
  it('FEATURE_STATES enumerates the 5 §0.5 states in order', () => {
    expect([...FEATURE_STATES]).toEqual([
      'backlog',
      'in_queue',
      'working',
      'pending_done',
      'shipped',
    ]);
  });

  it('FEATURE_TERMINAL_STATES contains shipped only', () => {
    expect(FEATURE_TERMINAL_STATES.has('shipped')).toBe(true);
    expect(FEATURE_TERMINAL_STATES.size).toBe(1);
  });

  it('FEATURE_STATE_ORDER is contiguous 0-4', () => {
    expect(FEATURE_STATE_ORDER.backlog).toBe(0);
    expect(FEATURE_STATE_ORDER.shipped).toBe(4);
  });
});

describe('isLegalTransition', () => {
  it('backlog → in_queue', () => {
    expect(isLegalTransition('backlog', 'in_queue')).toBe(true);
  });

  it('in_queue → working OR backlog', () => {
    expect(isLegalTransition('in_queue', 'working')).toBe(true);
    expect(isLegalTransition('in_queue', 'backlog')).toBe(true);
  });

  it('working → pending_done OR in_queue', () => {
    expect(isLegalTransition('working', 'pending_done')).toBe(true);
    expect(isLegalTransition('working', 'in_queue')).toBe(true);
  });

  it('pending_done → shipped OR in_queue', () => {
    expect(isLegalTransition('pending_done', 'shipped')).toBe(true);
    expect(isLegalTransition('pending_done', 'in_queue')).toBe(true);
  });

  it('shipped → nothing (terminal)', () => {
    expect(isLegalTransition('shipped', 'backlog')).toBe(false);
    expect(isLegalTransition('shipped', 'in_queue')).toBe(false);
    expect(FEATURE_STATE_FORWARD.shipped.size).toBe(0);
  });

  it('rejects illegal skips', () => {
    expect(isLegalTransition('backlog', 'shipped')).toBe(false);
    expect(isLegalTransition('backlog', 'working')).toBe(false);
    expect(isLegalTransition('working', 'shipped')).toBe(false);
    expect(isLegalTransition('in_queue', 'pending_done')).toBe(false);
  });
});

describe('isTerminal', () => {
  it('true for shipped only', () => {
    expect(isTerminal('shipped')).toBe(true);
    for (const s of ['backlog', 'in_queue', 'working', 'pending_done'] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('attemptTransition', () => {
  it('ok for legal transitions (non-shipping)', () => {
    expect(attemptTransition({ from: 'backlog', to: 'in_queue' })).toEqual({ kind: 'ok' });
    expect(attemptTransition({ from: 'in_queue', to: 'working' })).toEqual({ kind: 'ok' });
    expect(attemptTransition({ from: 'working', to: 'pending_done' })).toEqual({ kind: 'ok' });
  });

  it('illegal for non-graph transitions', () => {
    const r = attemptTransition({ from: 'backlog', to: 'working' });
    expect(r.kind).toBe('illegal');
    if (r.kind === 'illegal') {
      expect(r.from).toBe('backlog');
      expect(r.to).toBe('working');
    }
  });

  it('already_terminal when from === shipped', () => {
    const r = attemptTransition({ from: 'shipped', to: 'in_queue' });
    expect(r.kind).toBe('already_terminal');
    if (r.kind === 'already_terminal') {
      expect(r.from).toBe('shipped');
    }
  });

  it('missing_completion_ref when shipping without ref', () => {
    expect(attemptTransition({ from: 'pending_done', to: 'shipped' })).toEqual({
      kind: 'missing_completion_ref',
    });
  });

  it('ok when shipping with completion_ref supplied', () => {
    expect(
      attemptTransition({
        from: 'pending_done',
        to: 'shipped',
        completion_ref: SAMPLE_COMPLETION_REF,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('completion_ref ignored on non-shipping transitions', () => {
    // Supplying completion_ref on a backlog→in_queue should still ok.
    expect(
      attemptTransition({
        from: 'backlog',
        to: 'in_queue',
        completion_ref: SAMPLE_COMPLETION_REF,
      }),
    ).toEqual({ kind: 'ok' });
  });
});

describe('isActiveState', () => {
  it('true for all non-shipped states', () => {
    for (const s of ['backlog', 'in_queue', 'working', 'pending_done'] as const) {
      expect(isActiveState(s)).toBe(true);
    }
  });

  it('false for shipped', () => {
    expect(isActiveState('shipped')).toBe(false);
  });
});

describe('isOrchestratorPickable', () => {
  it('true for in_queue only', () => {
    expect(isOrchestratorPickable('in_queue')).toBe(true);
    for (const s of ['backlog', 'working', 'pending_done', 'shipped'] as const) {
      expect(isOrchestratorPickable(s)).toBe(false);
    }
  });
});

describe('hasCompletionRefSurface', () => {
  it('true for pending_done + shipped', () => {
    expect(hasCompletionRefSurface('pending_done')).toBe(true);
    expect(hasCompletionRefSurface('shipped')).toBe(true);
  });

  it('false for pre-PR states', () => {
    for (const s of ['backlog', 'in_queue', 'working'] as const) {
      expect(hasCompletionRefSurface(s)).toBe(false);
    }
  });
});

describe('resetTargetForFailure', () => {
  it('all failure reasons reset to in_queue', () => {
    for (const r of [
      'rebase_conflict',
      'worker_crashed',
      'user_abandoned',
      'pr_closed_without_merge',
    ] as const) {
      expect(resetTargetForFailure(r)).toBe('in_queue');
    }
  });
});

describe('compareFeatureStatesByLifecycle', () => {
  it('sorts by lifecycle position', () => {
    const states = ['shipped', 'backlog', 'working', 'in_queue', 'pending_done'] as const;
    const sorted = [...states].sort(compareFeatureStatesByLifecycle);
    expect(sorted).toEqual([
      'backlog',
      'in_queue',
      'working',
      'pending_done',
      'shipped',
    ]);
  });

  it('returns 0 for same state', () => {
    expect(compareFeatureStatesByLifecycle('working', 'working')).toBe(0);
  });
});
