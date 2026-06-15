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

  test('acceptance human-gate BLOCKS done until approved (hive-blueprint-generalization P-009)', () => {
    const gated = planFinalization({ ...base, acceptanceKind: 'human-gate' });
    expect(gated.blocked).toBe(true);
    expect(gated.steps).toEqual([]);
    const approved = planFinalization({ ...base, acceptanceKind: 'human-gate', acceptanceApproved: true });
    expect(approved.blocked).toBe(false);
    expect(approved.steps[0]).toEqual({ kind: 'invoke', role: 'curator', extras: ['TRIGGER=done'] });
  });

  test('acceptance judge inserts a judge step before the onDone recipe (P-009)', () => {
    const { blocked, steps } = planFinalization({ ...base, acceptanceKind: 'judge' });
    expect(blocked).toBe(false);
    expect(steps[0]).toEqual({
      kind: 'invoke',
      role: 'judge',
      extras: ['TRIGGER=done', 'FEATURE_ID=F-001'],
    });
    expect(steps[1]).toEqual({ kind: 'invoke', role: 'curator', extras: ['TRIGGER=done'] });
  });

  test('acceptance tests/none/undefined → unchanged straight-through finalize (coding backward-compat)', () => {
    for (const acceptanceKind of [undefined, 'tests', 'none'] as const) {
      const { blocked, steps } = planFinalization({ ...base, acceptanceKind });
      expect(blocked).toBe(false);
      expect(steps.some((s) => s.kind === 'invoke' && s.role === 'judge')).toBe(false);
      expect(steps[0]).toEqual({ kind: 'invoke', role: 'curator', extras: ['TRIGGER=done'] });
    }
  });

  test('output.kind: artifacts tags the output roles with OUTPUT_KIND (P-010); repo-commit/undefined unchanged', () => {
    const extrasFor = (p: ReturnType<typeof planFinalization>, role: string): string[] => {
      const s = p.steps.find((x) => x.kind === 'invoke' && x.role === role);
      return s && s.kind === 'invoke' ? s.extras : [];
    };
    const artifacts = planFinalization({ ...base, outputKind: 'artifacts' });
    expect(extrasFor(artifacts, 'documenter')).toContain('OUTPUT_KIND=artifacts');
    expect(extrasFor(artifacts, 'curator')).not.toContain('OUTPUT_KIND=artifacts'); // curator has no work output
    // repo-commit (the coding default) + undefined ⇒ no OUTPUT_KIND extra (backward-compat).
    for (const outputKind of [undefined, 'repo-commit'] as const) {
      const p = planFinalization({ ...base, outputKind });
      expect(extrasFor(p, 'documenter').some((e) => e.startsWith('OUTPUT_KIND='))).toBe(false);
    }
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

describe('reconcileDoneStatus (validator omitted the validating→passed write)', () => {
  function fakeDbc(initialStatus: string | undefined) {
    const state = { status: initialStatus, updates: 0, sqls: [] as string[] };
    return {
      state,
      prepare(sql: string) {
        state.sqls.push(sql);
        return {
          get: () => (state.status === undefined ? undefined : { status: state.status }),
          run: () => {
            if (sql.includes("SET status = 'passed'") && state.status === 'validating') {
              state.status = 'passed';
              state.updates++;
            }
            return {};
          },
        };
      },
    };
  }

  test('flips validating → passed on an unblocked DONE and reports true', async () => {
    const { reconcileDoneStatus } = await import('./orchestrator-finalize');
    const dbc = fakeDbc('validating');
    const logs: string[] = [];
    const flipped = await reconcileDoneStatus('h', 'F-001', dbc, (m) => logs.push(m));
    expect(flipped).toBe(true);
    expect(dbc.state.status).toBe('passed');
    expect(logs.some((m) => m.includes('reconciled validating→passed'))).toBe(true);
  });

  test('queries the consolidated relation, never the dropped per-harness harness_features (EI-213)', async () => {
    const { reconcileDoneStatus } = await import('./orchestrator-finalize');
    const dbc = fakeDbc('validating');
    await reconcileDoneStatus('h', 'F-001', dbc);
    expect(dbc.state.sqls.length).toBeGreaterThan(0);
    for (const sql of dbc.state.sqls) {
      // The unqualified relation was dropped by the work-items unification —
      // every read/write must hit harness_shared.harness_features_consolidated.
      expect(sql).toMatch(/harness_shared\.harness_features_consolidated/);
      expect(sql).not.toMatch(/(?<!harness_shared\.)\bFROM harness_features\b/i);
    }
  });

  test('any other status is untouched — a hallucinated DONE can never force-pass', async () => {
    const { reconcileDoneStatus } = await import('./orchestrator-finalize');
    for (const status of ['failing', 'todo', 'in_progress', 'passed', undefined] as const) {
      const dbc = fakeDbc(status);
      const flipped = await reconcileDoneStatus('h', 'F-001', dbc);
      expect(flipped).toBe(false);
      expect(dbc.state.status).toBe(status);
      expect(dbc.state.updates).toBe(0);
    }
  });
});
