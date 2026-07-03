import { describe, it, expect, afterEach } from 'vitest';
import {
  FEATURE_DISPATCHABLE_STATE,
  FEATURE_TERMINAL_STATES,
  FEATURE_NON_REQUEUE_STATES,
  FEATURE_FAMILY_STATES,
  DEFAULT_STALE_RECLAIM_REQUEUE_CAP,
  isRequeueableFeatureState,
  normalizeFeatureStateInput,
  staleReclaimRequeueCap,
} from './work-item-dispatch-states';

describe('feature-state constant invariants', () => {
  it('the dispatchable state and terminal states are members of the family vocabulary', () => {
    expect(FEATURE_FAMILY_STATES).toContain(FEATURE_DISPATCHABLE_STATE);
    for (const t of FEATURE_TERMINAL_STATES) expect(FEATURE_FAMILY_STATES).toContain(t);
  });

  it('non-requeue states = dispatchable + terminal + blocked, with no duplicates', () => {
    expect(new Set(FEATURE_NON_REQUEUE_STATES)).toEqual(
      new Set([FEATURE_DISPATCHABLE_STATE, ...FEATURE_TERMINAL_STATES, 'blocked', 'needs-human']),
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
  it('passes a canonical family state through unchanged', () => {
    expect(normalizeFeatureStateInput('in_progress')).toEqual({ ok: true, state: 'in_progress' });
    expect(normalizeFeatureStateInput('passed')).toEqual({ ok: true, state: 'passed' });
  });

  it('folds the canonical lifecycle dialect onto the native vocabulary', () => {
    expect(normalizeFeatureStateInput('done')).toEqual({ ok: true, state: 'passed' });
    expect(normalizeFeatureStateInput('resolved')).toEqual({ ok: true, state: 'passed' });
    expect(normalizeFeatureStateInput('dropped')).toEqual({ ok: true, state: 'deprecated' });
    expect(normalizeFeatureStateInput('closed')).toEqual({ ok: true, state: 'deprecated' });
    expect(normalizeFeatureStateInput('open')).toEqual({ ok: true, state: 'todo' });
  });

  it('folds separator/case drift variants to canonical so a typo lands in the right state', () => {
    expect(normalizeFeatureStateInput('in-progress')).toEqual({ ok: true, state: 'in_progress' });
    expect(normalizeFeatureStateInput('IN_PROGRESS')).toEqual({ ok: true, state: 'in_progress' });
    expect(normalizeFeatureStateInput('needs_human')).toEqual({ ok: true, state: 'needs-human' });
    expect(normalizeFeatureStateInput('needs human')).toEqual({ ok: true, state: 'needs-human' });
    expect(normalizeFeatureStateInput('need-human')).toEqual({ ok: true, state: 'needs-human' });
  });

  it('trims surrounding whitespace before lookup', () => {
    expect(normalizeFeatureStateInput('  Done  ')).toEqual({ ok: true, state: 'passed' });
  });

  it('rejects a truly-unknown state and reports the valid set', () => {
    const res = normalizeFeatureStateInput('frobnicate');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.valid).toEqual(FEATURE_FAMILY_STATES);
  });

  it('accepts every status the features UI can submit, so the /harness/:slug/features guard (WI-195 C2) can never 400 a real save', () => {
    // Mirror of apps/operator/app/harness/FeatureEditor.tsx VALID_STATUSES. The POST
    // /features + PATCH /features/:id endpoints now validate body.status through
    // normalizeFeatureStateInput; if a UI-selectable status were NOT in the family
    // vocab this guard would reject a legitimate human save. Fails loudly on divergence.
    const UI_VALID_STATUSES = ['todo', 'in_progress', 'validating', 'failing', 'passed', 'blocked', 'deprecated'];
    for (const s of UI_VALID_STATUSES) {
      expect(normalizeFeatureStateInput(s)).toEqual({ ok: true, state: s });
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
