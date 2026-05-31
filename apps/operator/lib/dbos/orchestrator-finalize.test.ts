import { describe, test, expect } from 'vitest';
import { planFinalization } from './orchestrator-finalize';

describe('planFinalization — DONE (porting legacy handleDone)', () => {
  const base = {
    outcome: 'done' as const,
    needsHumanOpen: false,
    smokeEnabled: false,
    smokePassed: null,
    archiveOnDone: false,
  };

  test('clean DONE → curator(TRIGGER=done) → postCuratorOutputs → documenter → afterDone hook', () => {
    const { blocked, steps } = planFinalization(base);
    expect(blocked).toBe(false);
    expect(steps).toEqual([
      { kind: 'invoke', role: 'curator', extras: ['TRIGGER=done'] },
      { kind: 'postCuratorOutputs' },
      { kind: 'invoke', role: 'documenter', extras: ['TRIGGER=done', 'FEATURE_ID=-'] },
      { kind: 'hook', hook: 'afterDone' },
    ]);
  });

  test('archiveOnDone=true inserts an archive step before afterDone', () => {
    const { steps } = planFinalization({ ...base, archiveOnDone: true });
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toEqual(['invoke', 'postCuratorOutputs', 'invoke', 'archive', 'hook']);
  });

  test('open needs-human plan item BLOCKS done — no curator/documenter run', () => {
    const { blocked, steps } = planFinalization({ ...base, needsHumanOpen: true });
    expect(blocked).toBe(true);
    expect(steps).toEqual([]);
  });

  test('smoke gate enabled + passed → finalization proceeds', () => {
    const { blocked, steps } = planFinalization({
      ...base,
      smokeEnabled: true,
      smokePassed: true,
    });
    expect(blocked).toBe(false);
    expect(steps[0]).toEqual({ kind: 'invoke', role: 'curator', extras: ['TRIGGER=done'] });
  });

  test('smoke gate enabled + FAILED → blocked (feature reopened, no finalize)', () => {
    const { blocked, steps } = planFinalization({
      ...base,
      smokeEnabled: true,
      smokePassed: false,
    });
    expect(blocked).toBe(true);
    expect(steps).toEqual([]);
  });
});

describe('planFinalization — ESCALATE (porting legacy handleEscalate)', () => {
  test('escalate → on-escalate hook → curator(TRIGGER=escalate, REASON=…)', () => {
    const { blocked, steps } = planFinalization({
      outcome: 'escalate',
      reason: 'stuck after 3 attempts',
      needsHumanOpen: false,
      smokeEnabled: false,
      smokePassed: null,
      archiveOnDone: false,
    });
    expect(blocked).toBe(false);
    expect(steps).toEqual([
      { kind: 'hook', hook: 'on-escalate' },
      { kind: 'invoke', role: 'curator', extras: ['TRIGGER=escalate', 'REASON=stuck after 3 attempts'] },
    ]);
  });

  test('escalate with empty reason → curator still runs, REASON= empty', () => {
    const { steps } = planFinalization({
      outcome: 'escalate',
      reason: '',
      needsHumanOpen: false,
      smokeEnabled: false,
      smokePassed: null,
      archiveOnDone: false,
    });
    expect(steps).toContainEqual({
      kind: 'invoke',
      role: 'curator',
      extras: ['TRIGGER=escalate', 'REASON='],
    });
  });

  test('escalate ignores done-only gates (needs-human / smoke do not block memory distillation)', () => {
    const { blocked } = planFinalization({
      outcome: 'escalate',
      reason: 'x',
      needsHumanOpen: true,
      smokeEnabled: true,
      smokePassed: false,
      archiveOnDone: true,
    });
    expect(blocked).toBe(false);
  });
});
