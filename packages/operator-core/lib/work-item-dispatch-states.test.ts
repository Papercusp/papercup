import { describe, it, expect, afterEach } from 'vitest';
import {
  FEATURE_DISPATCHABLE_STATE,
  FEATURE_TERMINAL_STATES,
  ISSUE_TERMINAL_STATES,
  ANY_FAMILY_TERMINAL_STATES,
  FEATURE_NON_REQUEUE_STATES,
  FEATURE_FAMILY_STATES,
  DEFAULT_STALE_RECLAIM_REQUEUE_CAP,
  isRequeueableFeatureState,
  normalizeFeatureStateInput,
  staleReclaimRequeueCap,
} from './work-item-dispatch-states';

describe('cross-family terminal union (EI-18653071581558556)', () => {
  it('covers BOTH kind-family terminal dialects', () => {
    for (const s of FEATURE_TERMINAL_STATES) expect(ANY_FAMILY_TERMINAL_STATES).toContain(s);
    for (const s of ISSUE_TERMINAL_STATES) expect(ANY_FAMILY_TERMINAL_STATES).toContain(s);
  });

  it('includes the unified terminals `done` and `dropped` that the drifted copies missed', () => {
    // placement-watchdog hand-copied this union and stopped at
    // ['passed','deprecated','resolved','closed']. Every consumer reads
    // "not terminal => still active", so finished work scored as a FAILED
    // placement: ~88% of papercusp's reported stranded/cursed units were already
    // `done`/`dropped` (measured live 2026-07-25). Never re-list these words in a
    // consumer — derive from ANY_FAMILY_TERMINAL_STATES.
    expect(ANY_FAMILY_TERMINAL_STATES).toContain('done');
    expect(ANY_FAMILY_TERMINAL_STATES).toContain('dropped');
  });

  it('is de-duplicated even though the families overlap', () => {
    expect(ANY_FAMILY_TERMINAL_STATES.length).toBe(new Set(ANY_FAMILY_TERMINAL_STATES).size);
  });
});

describe('feature-state constant invariants', () => {
  it('the dispatchable state and terminal states are members of the family vocabulary', () => {
    expect(FEATURE_FAMILY_STATES).toContain(FEATURE_DISPATCHABLE_STATE);
    for (const t of FEATURE_TERMINAL_STATES) expect(FEATURE_FAMILY_STATES).toContain(t);
  });

  it('non-requeue states = dispatchable + terminal + blocked + needs-human + open, with no duplicates', () => {
    // work-item-status-full-unify: `open` (the unified claimable token) is non-requeue for the
    // same reason as `todo` — already claimable, nothing to do.
    expect(new Set(FEATURE_NON_REQUEUE_STATES)).toEqual(
      new Set([FEATURE_DISPATCHABLE_STATE, ...FEATURE_TERMINAL_STATES, 'blocked', 'needs-human', 'open']),
    );
    expect(FEATURE_NON_REQUEUE_STATES.length).toBe(new Set(FEATURE_NON_REQUEUE_STATES).size);
  });

  it('the family vocabulary has no duplicates', () => {
    expect(FEATURE_FAMILY_STATES.length).toBe(new Set(FEATURE_FAMILY_STATES).size);
  });
});

describe('isRequeueableFeatureState', () => {
  it('is false for null/undefined/empty (nothing to requeue)', () => {
    expect(isRequeueableFeatureState(null)).toBe(false);
    expect(isRequeueableFeatureState(undefined)).toBe(false);
    expect(isRequeueableFeatureState('')).toBe(false);
  });

  it('is false for the already-dispatchable, terminal, and deliberate-park states', () => {
    expect(isRequeueableFeatureState('todo')).toBe(false);
    expect(isRequeueableFeatureState('passed')).toBe(false);
    expect(isRequeueableFeatureState('deprecated')).toBe(false);
    expect(isRequeueableFeatureState('blocked')).toBe(false);
    // P-004 (fleet-scheduler-hardening-2026-07-03): needs-human is an OWNER-park —
    // a dead holder must NOT return owner-gated work to the claimable pool (the
    // WI-1774/WI-1775 re-grind loop of 2026-07-03).
    expect(isRequeueableFeatureState('needs-human')).toBe(false);
  });

  it('is true for any mid-flight state stranded by a dead/releasing holder', () => {
    for (const s of ['in_progress', 'validating', 'failing', 'wip']) {
      expect(isRequeueableFeatureState(s)).toBe(true);
    }
  });
});

describe('normalizeFeatureStateInput', () => {
  // work-item-status-full-unify (P-003 writer-flip): the feature writer now STORES the
  // unified enum. Legacy feature dialect + phase spellings fold to unified.
  it('passes a unified in-flight/claimable token through unchanged', () => {
    expect(normalizeFeatureStateInput('open')).toEqual({ ok: true, state: 'open' });
    expect(normalizeFeatureStateInput('wip')).toEqual({ ok: true, state: 'wip' });
    expect(normalizeFeatureStateInput('blocked')).toEqual({ ok: true, state: 'blocked' });
    expect(normalizeFeatureStateInput('needs-human')).toEqual({ ok: true, state: 'needs-human' });
  });

  it('folds the legacy feature dialect + phase spellings onto the unified enum', () => {
    expect(normalizeFeatureStateInput('passed')).toEqual({ ok: true, state: 'done' });
    expect(normalizeFeatureStateInput('done')).toEqual({ ok: true, state: 'done' });
    expect(normalizeFeatureStateInput('resolved')).toEqual({ ok: true, state: 'done' });
    expect(normalizeFeatureStateInput('deprecated')).toEqual({ ok: true, state: 'dropped' });
    expect(normalizeFeatureStateInput('dropped')).toEqual({ ok: true, state: 'dropped' });
    expect(normalizeFeatureStateInput('closed')).toEqual({ ok: true, state: 'dropped' });
    expect(normalizeFeatureStateInput('todo')).toEqual({ ok: true, state: 'open' });
    expect(normalizeFeatureStateInput('failing')).toEqual({ ok: true, state: 'open' });
    expect(normalizeFeatureStateInput('in_progress')).toEqual({ ok: true, state: 'wip' });
    expect(normalizeFeatureStateInput('validating')).toEqual({ ok: true, state: 'wip' });
  });

  it('folds separator/case drift variants to unified so a typo lands in the right state', () => {
    expect(normalizeFeatureStateInput('in-progress')).toEqual({ ok: true, state: 'wip' });
    expect(normalizeFeatureStateInput('IN_PROGRESS')).toEqual({ ok: true, state: 'wip' });
    expect(normalizeFeatureStateInput('needs_human')).toEqual({ ok: true, state: 'needs-human' });
    expect(normalizeFeatureStateInput('needs human')).toEqual({ ok: true, state: 'needs-human' });
    expect(normalizeFeatureStateInput('need-human')).toEqual({ ok: true, state: 'needs-human' });
  });

  it('trims surrounding whitespace before lookup', () => {
    expect(normalizeFeatureStateInput('  Passed  ')).toEqual({ ok: true, state: 'done' });
  });

  it('rejects a truly-unknown state and reports the valid set', () => {
    const res = normalizeFeatureStateInput('frobnicate');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.valid).toEqual(FEATURE_FAMILY_STATES);
  });

  it('accepts every status the features UI can submit, so the /harness/:slug/features guard (WI-195 C2) can never 400 a real save', () => {
    // Mirror of apps/operator/app/harness/FeatureEditor.tsx VALID_STATUSES. The POST
    // /features + PATCH /features/:id endpoints validate body.status through
    // normalizeFeatureStateInput. Post-writer-flip these legacy UI spellings FOLD to the
    // unified enum (e.g. passed→done) rather than round-tripping as identity — the guard
    // must still ACCEPT every one (ok:true) so a legitimate human save is never 400'd.
    // (Surfacing the unified vocabulary in the editor itself is P-007.)
    const UI_VALID_STATUSES = ['todo', 'in_progress', 'validating', 'failing', 'passed', 'blocked', 'deprecated'];
    for (const s of UI_VALID_STATUSES) {
      const res = normalizeFeatureStateInput(s);
      expect(res.ok).toBe(true);
      if (res.ok) expect(FEATURE_FAMILY_STATES).toContain(res.state);
    }
  });
});

describe('staleReclaimRequeueCap', () => {
  const KEY = 'PAPERCUSP_STALE_RECLAIM_REQUEUE_CAP';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('falls back to the default when the env var is unset', () => {
    delete process.env[KEY];
    expect(staleReclaimRequeueCap()).toBe(DEFAULT_STALE_RECLAIM_REQUEUE_CAP);
  });

  it('uses a valid positive integer override', () => {
    process.env[KEY] = '7';
    expect(staleReclaimRequeueCap()).toBe(7);
  });

  it('floors a fractional override', () => {
    process.env[KEY] = '4.9';
    expect(staleReclaimRequeueCap()).toBe(4);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env[KEY] = 'lots';
    expect(staleReclaimRequeueCap()).toBe(DEFAULT_STALE_RECLAIM_REQUEUE_CAP);
  });

  it('falls back to the default for a below-minimum value (< 1)', () => {
    process.env[KEY] = '0';
    expect(staleReclaimRequeueCap()).toBe(DEFAULT_STALE_RECLAIM_REQUEUE_CAP);
    process.env[KEY] = '-3';
    expect(staleReclaimRequeueCap()).toBe(DEFAULT_STALE_RECLAIM_REQUEUE_CAP);
  });
});
