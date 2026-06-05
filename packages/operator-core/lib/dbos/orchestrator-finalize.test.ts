import { describe, test, expect } from 'vitest';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import { planFinalization, needsHumanGateUrl, DEFAULT_FINALIZE_RECIPE } from './orchestrator-finalize';

describe('needsHumanGateUrl — harness-scoped needs-human DONE gate (P-008 gate fix)', () => {
  test('scopes by the `harness` param (the plans:items tool key), NOT the ignored `harness_slugs`', () => {
    const url = needsHumanGateUrl('http://localhost:3070', 'sheets');
    expect(url).toContain('needsHuman=true');
    expect(url).toContain('harness=sheets');
    // The bug: harness_slugs was silently ignored → the tool defaulted to
    // harness='all' (operator plans), so unrelated operator needs-human items
    // blocked every harness's finalization.
    expect(url).not.toContain('harness_slugs');
  });

  test('url-encodes the slug + uses the given base', () => {
    const url = needsHumanGateUrl('http://h:3070', 'a/b');
    expect(url.startsWith('http://h:3070/api/admin/plans/items?')).toBe(true);
    expect(url).toContain('harness=a%2Fb');
  });
});

describe('planFinalization — DONE (porting legacy handleDone)', () => {
  const base = {
    outcome: 'done' as const,
    featureId: 'F-001',
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
      { kind: 'invoke', role: 'documenter', extras: ['TRIGGER=done', 'FEATURE_ID=F-001'] },
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
      featureId: 'F-001',
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
      featureId: 'F-001',
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
      featureId: 'F-001',
      reason: 'x',
      needsHumanOpen: true,
      smokeEnabled: true,
      smokePassed: false,
      archiveOnDone: true,
    });
    expect(blocked).toBe(false);
  });
});

describe('planFinalization — declarative recipe (unify-launches P-007)', () => {
  const base = {
    outcome: 'done' as const,
    featureId: 'F-001',
    needsHumanOpen: false,
    smokeEnabled: false,
    smokePassed: null,
    archiveOnDone: false,
  };

  test('DEFAULT_FINALIZE_RECIPE matches the coding blueprint gates.finalize', () => {
    const coding = loadBuiltinBlueprint('coding').blueprint;
    expect(coding.gates.finalize).toEqual(DEFAULT_FINALIZE_RECIPE);
  });

  test("the default recipe reproduces the legacy steps (curator → postCuratorOutputs → documenter)", () => {
    // No `finalize` → DEFAULT_FINALIZE_RECIPE; identical to the pre-P-007 hardcode.
    const explicit = planFinalization({ ...base, finalize: DEFAULT_FINALIZE_RECIPE });
    const defaulted = planFinalization(base);
    expect(explicit).toEqual(defaulted);
  });

  test("a blueprint recipe drives the finalize roles (gym's onDone: [committer])", () => {
    const { steps } = planFinalization({ ...base, finalize: { onDone: ['committer'], onEscalate: ['curator'] } });
    expect(steps).toEqual([
      { kind: 'invoke', role: 'committer', extras: ['TRIGGER=done', 'FEATURE_ID=F-001'] },
      { kind: 'hook', hook: 'afterDone' },
    ]);
  });

  test('a fork can reorder + drop finalize roles (e.g. documenter-only, no curator/archive)', () => {
    const { steps } = planFinalization({
      ...base,
      archiveOnDone: true, // archive NOT in the recipe → not emitted despite the flag
      finalize: { onDone: ['documenter'], onEscalate: [] },
    });
    expect(steps).toEqual([
      { kind: 'invoke', role: 'documenter', extras: ['TRIGGER=done', 'FEATURE_ID=F-001'] },
      { kind: 'hook', hook: 'afterDone' },
    ]);
  });

  test('escalate honors the onEscalate recipe (curator gets TRIGGER=escalate + REASON, no FEATURE_ID)', () => {
    const { steps } = planFinalization({
      ...base,
      outcome: 'escalate',
      reason: 'stuck',
      finalize: { onDone: ['curator'], onEscalate: ['curator'] },
    });
    expect(steps).toEqual([
      { kind: 'hook', hook: 'on-escalate' },
      { kind: 'invoke', role: 'curator', extras: ['TRIGGER=escalate', 'REASON=stuck'] },
    ]);
  });
});
