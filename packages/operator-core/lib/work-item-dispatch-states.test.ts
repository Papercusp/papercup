import { describe, it, expect, afterEach } from 'vitest';
import { CLAIM_STATES_ALLOWLIST } from './scheduler/claim-states';
import {
  FEATURE_TERMINAL_STATES,
  ISSUE_TERMINAL_STATES,
  ANY_FAMILY_TERMINAL_STATES,
  FEATURE_NON_REQUEUE_STATES,
  FEATURE_FAMILY_STATES,
  DEFAULT_STALE_RECLAIM_REQUEUE_CAP,
  TERMINAL_INPUT_STATES,
  NON_TERMINAL_INPUT_STATES,
  isTerminalStateInput,
  isRequeueableFeatureState,
  normalizeFeatureStateInput,
  staleReclaimRequeueCap,
} from './work-item-dispatch-states';

describe('terminal/non-terminal input partition (P-005 — the set_state evidence gate)', () => {
  it('partitions every accepted spelling exactly once (total + disjoint)', () => {
    const overlap = TERMINAL_INPUT_STATES.filter((s) => NON_TERMINAL_INPUT_STATES.includes(s));
    expect(overlap).toEqual([]);
    // Every spelling the runtime writer accepts must be classifiable — otherwise the
    // schema gate would reject a write the writer would have happily performed.
    for (const s of FEATURE_FAMILY_STATES) {
      expect([...TERMINAL_INPUT_STATES, ...NON_TERMINAL_INPUT_STATES]).toContain(s);
    }
  });

  it('classifies BOTH families\' legacy terminals as terminal, not just the unified pair', () => {
    // The whole point: `passed`/`resolved`/`closed`/`deprecated` are terminal only
    // AFTER aliasing, so a gate keyed on ANY_FAMILY_TERMINAL_STATES membership of the
    // RAW input would wave these through without evidence.
    for (const s of ['done', 'dropped', 'passed', 'deprecated', 'resolved', 'closed']) {
      expect(isTerminalStateInput(s)).toBe(true);
    }
  });

  it('does NOT treat a mid-flight or parked state as terminal', () => {
    // `todo` is live in the census (49 rows) yet absent from the tool description's
    // enum — a gate built from that prose would have rejected legitimate writes.
    for (const s of ['open', 'todo', 'wip', 'in_progress', 'validating', 'failing', 'blocked', 'needs-human']) {
      expect(isTerminalStateInput(s)).toBe(false);
    }
  });

  it('folds case + separator drift the same way normalizeFeatureStateInput does', () => {
    expect(isTerminalStateInput('DONE')).toBe(true);
    expect(isTerminalStateInput('  Passed  ')).toBe(true);
    expect(isTerminalStateInput('In_Progress')).toBe(false);
    expect(isTerminalStateInput('needs_human')).toBe(false);
  });

  it('stays derived — a terminal added upstream cannot drift out of the gate', () => {
    // Guards the hand-copy drift class that caused EI-18653071581558556: every
    // ANY_FAMILY_TERMINAL_STATES entry must be gated as terminal, by construction.
    for (const s of ANY_FAMILY_TERMINAL_STATES) expect(TERMINAL_INPUT_STATES).toContain(s);
  });
});

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

describe('ISSUE_TERMINAL_STATES recognizes the unified `dropped` terminal (EI-21921121818266895)', () => {
  it('includes `dropped` — the unified spelling `closed`/`deprecated` issue writes normalize onto', () => {
    // Regression: this list omitted `dropped` for over a month after the issue-family
    // writer started storing it (work-item-status-full-unify), making 3,992+ live
    // dropped issue rows invisible to every terminal-scoped issue diagnostic
    // (issues-engineer.ts's audit + completionAuthority buckets) and to
    // premise-probes.ts's `#completion`-anchor terminality check.
    expect(ISSUE_TERMINAL_STATES).toContain('dropped');
  });

  it('still carries the pre-unification legacy issue spellings', () => {
    for (const s of ['resolved', 'closed', 'deprecated', 'done']) {
      expect(ISSUE_TERMINAL_STATES).toContain(s);
    }
  });
});

describe('feature-state constant invariants', () => {
  it('the claimable and terminal states are members of the family vocabulary', () => {
    for (const s of CLAIM_STATES_ALLOWLIST) expect(FEATURE_FAMILY_STATES).toContain(s);
    for (const t of FEATURE_TERMINAL_STATES) expect(FEATURE_FAMILY_STATES).toContain(t);
  });

  it('non-requeue states = open + legacy todo + terminal + blocked + needs-human, with no duplicates', () => {
    // work-item-status-full-unify: `open` (the unified claimable token) is non-requeue for the
    // same reason legacy `todo` is — already claimable, nothing to do.
    expect(new Set(FEATURE_NON_REQUEUE_STATES)).toEqual(
      new Set(['open', 'todo', ...FEATURE_TERMINAL_STATES, 'blocked', 'needs-human']),
    );
    expect(FEATURE_NON_REQUEUE_STATES.length).toBe(new Set(FEATURE_NON_REQUEUE_STATES).size);
  });

  it('every CLAIMABLE state is also non-requeue EXCEPT `failing` (the re-drive token)', () => {
    // The coupling that matters: a row the pool can already claim must not also be rewritten
    // by the reaper. `failing` is the deliberate exception — it IS offered to the pool (a
    // build-failed feature the pipeline may re-drive), but a FREED `failing` row is stranded
    // mid-flight and is reset to `open`. Asserted so the exception stays a decision rather
    // than becoming an accident if the allowlist grows.
    for (const s of CLAIM_STATES_ALLOWLIST) {
      if (s === 'failing') expect(FEATURE_NON_REQUEUE_STATES).not.toContain(s);
      else expect(FEATURE_NON_REQUEUE_STATES).toContain(s);
    }
  });

  it('the retired `todo` spelling is non-requeue but NOT claimable (EI-19363744726544384)', () => {
    // This pair is the whole trap. `todo` survives in the non-requeue set because ~28 live
    // feature-family rows still sit at it (see the constant's comment for the recount query),
    // and it is NOT claimable because the unify narrowed the floor to CLAIM_STATES_ALLOWLIST.
    // A fixture seeding `todo` is therefore invisible to claimNextWorkItem — which is exactly
    // how work-item-redundancy.integration.test.ts stayed red for three weeks. If someone ever
    // re-adds `todo` to the claim allowlist, this fails and points at the reaper coupling.
    expect(FEATURE_NON_REQUEUE_STATES).toContain('todo');
    expect(CLAIM_STATES_ALLOWLIST as readonly string[]).not.toContain('todo');
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

/**
 * P-028 / D-067: the cross-family terminal union has exactly ONE definition.
 *
 * `work-items.ts` carried a hand-written 6-element literal that duplicated
 * `ANY_FAMILY_TERMINAL_STATES`. It was collapsed to a re-export. This guard exists
 * because the two documented failures of this class were BOTH silent — a copy
 * agrees with its source right up until a state is added to one side
 * (EI-18653071581558556, EI-21921121818266895) — so nothing but an assertion
 * notices a re-introduced literal.
 */
describe('TERMINAL_WORK_ITEM_STATES is DERIVED, not a copy (P-028 / D-067)', () => {
  it('is the very same array object as the canonical union', async () => {
    const { TERMINAL_WORK_ITEM_STATES } = await import('./work-items');
    // Reference identity, deliberately stronger than deep-equality: a
    // re-introduced literal that happens to match today would satisfy toEqual
    // and is exactly the drift this guards. Only a re-export passes.
    expect(TERMINAL_WORK_ITEM_STATES).toBe(ANY_FAMILY_TERMINAL_STATES);
  });

  it('CALIBRATION: the union really is the union of both families, and non-trivial', () => {
    // Without this, a union that collapsed to one family — or to [] — would let
    // the identity assertion above pass while meaning nothing.
    const expected = [...new Set([...FEATURE_TERMINAL_STATES, ...ISSUE_TERMINAL_STATES])].sort();
    expect([...ANY_FAMILY_TERMINAL_STATES].sort()).toEqual(expected);
    expect(ANY_FAMILY_TERMINAL_STATES.length).toBeGreaterThanOrEqual(6);
    // Both families must contribute a member the other lacks, or "cross-family"
    // is a fiction and a single flat list would have been correct all along.
    expect(FEATURE_TERMINAL_STATES.filter((s) => !ISSUE_TERMINAL_STATES.includes(s))).not.toEqual([]);
    expect(ISSUE_TERMINAL_STATES.filter((s) => !FEATURE_TERMINAL_STATES.includes(s))).not.toEqual([]);
  });

  it('CONTROL: a hand-copied literal with identical CONTENT still fails the identity check', () => {
    // The permanent counterexample: this is precisely what was removed, and it
    // must not be able to pass. Proves the guard can fail.
    const handCopy: readonly string[] = ['done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped'];
    expect([...handCopy].sort()).toEqual([...ANY_FAMILY_TERMINAL_STATES].sort()); // same content today
    expect(handCopy).not.toBe(ANY_FAMILY_TERMINAL_STATES); // and still refused
  });
});
