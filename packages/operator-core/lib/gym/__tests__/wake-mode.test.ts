/**
 * Unit tests for the wake-mode E2E's pure parts (hive-loop-e2e-testing-2026-06-10
 * P-006): the wake blueprint resolves through the REAL blueprint loader into the
 * exact trigger + dispatch shape the autonomous chain needs, the boot spec arms
 * the autoloop, and `evaluateWakeOracles` enforces all four oracle families.
 * The full boot E2E is the wake-mode-run.ts runnable (fake mode = zero-LLM).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { triggerRoutineSpecs } from '../../blueprint/materialize-triggers';
import { buildGymOperatorBootSpec } from '../boot-spec';
import { wakeBlueprintYaml, evaluateWakeOracles, type WakeEvidence } from '../wake-mode';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('wakeBlueprintYaml', () => {
  it('resolves through the real loader: extends coding, declares the trigger + dispatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-bp-'));
    try {
      mkdirSync(join(dir, '.papercusp'), { recursive: true });
      const file = join(dir, '.papercusp', 'blueprint.yaml');
      writeFileSync(file, wakeBlueprintYaml('wakehive', { cron: '*/15 * * * * *', concurrency: 1 }));
      const { blueprint } = loadBlueprintFromFile(file);
      // The coding spine came through the extends-merge (the chain under test
      // dispatches director → worker → validator off this).
      expect(blueprint.spine.decider).toBe('director');
      expect(blueprint.workItem.kind).toBe('feature');
      // The autoloop enablement: the blueprint carries its OWN schedule trigger.
      expect(blueprint.triggers?.schedule).toHaveLength(1);
      expect(blueprint.triggers!.schedule![0].cron).toBe('*/15 * * * * *');
      // The dispatch policy the orchestrator sweep enforces (cap = 1 serializes).
      expect(blueprint.dispatch?.concurrency).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives exactly the bp-schedule-0 → system:blueprint-run routine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-bp-'));
    try {
      mkdirSync(join(dir, '.papercusp'), { recursive: true });
      const file = join(dir, '.papercusp', 'blueprint.yaml');
      writeFileSync(file, wakeBlueprintYaml('wakehive', { cron: '*/15 * * * * *', concurrency: 1 }));
      const { blueprint } = loadBlueprintFromFile(file);
      const specs = triggerRoutineSpecs(blueprint);
      expect(specs).toEqual([
        { name: 'bp-schedule-0', cron: '*/15 * * * * *', targetRole: 'system:blueprint-run' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('boot spec arms the autoloop', () => {
  it('autoloopScope=<slug> sets PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES to that slug (not none)', () => {
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: '/repo',
      harnessCommit: COMMIT,
      gymDatabaseUrl: 'postgresql://u:p@127.0.0.1:5/x',
      honoPort: 3978,
      workspaceId: 'gym-wake-ws',
      autoloopScope: 'wakehive',
    });
    expect(spec.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES).toBe('wakehive');
    expect(spec.env.PAPERCUSP_DBOS_ENABLE).toBe('1');
    expect(spec.env.PAPERCUSP_DBOS_ROUTINES).toBe('1');
  });
});

// ─── evaluateWakeOracles ─────────────────────────────────────────────────────

function greenEvidence(): WakeEvidence {
  return {
    featureIds: ['F-1', 'F-2'],
    features: [
      { id: 'F-1', status: 'passed' },
      { id: 'F-2', status: 'passed' },
    ],
    pipelines: [
      { id: 'pipeline:wakehive:F-1:e0', status: 'SUCCESS' },
      { id: 'pipeline:wakehive:F-2:e0', status: 'SUCCESS' },
    ],
    maxConcurrentPipelines: 1,
    cap: 1,
    maxTurns: 30,
    decideStepsByPipeline: { 'pipeline:wakehive:F-1:e0': 3, 'pipeline:wakehive:F-2:e0': 3 },
    finalizeStepsByPipeline: { 'pipeline:wakehive:F-1:e0': 1, 'pipeline:wakehive:F-2:e0': 1 },
    deciderFires: [{ role: 'director', lastStatus: 'ok', consecutiveErrors: 0 }],
    routineFireRuns: 4,
    routineSeeded: true,
    runningRunOutputRows: 0,
    runningNurseryRows: 0,
  };
}

describe('evaluateWakeOracles', () => {
  it('passes on a fully-green autonomous run', () => {
    const v = evaluateWakeOracles(greenEvidence());
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it('liveness: a feature that never passed fails', () => {
    const ev = greenEvidence();
    ev.features[1] = { id: 'F-2', status: 'todo' };
    const v = evaluateWakeOracles(ev);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes("F-2 ended 'todo'"))).toBe(true);
  });

  it('liveness: a feature with no autonomous pipeline fails', () => {
    const ev = greenEvidence();
    ev.pipelines = ev.pipelines.filter((p) => !p.id.includes(':F-2:'));
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.includes('no autonomous pipeline ever started for F-2'))).toBe(true);
  });

  it('trigger: no routineFire run fails (links 1–2 never engaged)', () => {
    const ev = greenEvidence();
    ev.routineFireRuns = 0;
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.startsWith('trigger: routinesTick never fired'))).toBe(true);
  });

  it('trigger: no fire-gate ledger row fails', () => {
    const ev = greenEvidence();
    ev.deciderFires = [];
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.includes('never fired through the fire-gate'))).toBe(true);
  });

  it('safety: a double finalizer fails', () => {
    const ev = greenEvidence();
    ev.finalizeStepsByPipeline['pipeline:wakehive:F-1:e0'] = 2;
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.includes('finalizer ran 2×'))).toBe(true);
  });

  it('safety: exceeding maxTurns fails', () => {
    const ev = greenEvidence();
    ev.decideStepsByPipeline['pipeline:wakehive:F-1:e0'] = 31;
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.includes('decide turns > maxTurns'))).toBe(true);
  });

  it('resources: concurrency above the declared cap fails', () => {
    const ev = greenEvidence();
    ev.maxConcurrentPipelines = 2;
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.includes('concurrent pipelines > cap'))).toBe(true);
  });

  it('hygiene: a stuck running nursery row fails', () => {
    const ev = greenEvidence();
    ev.runningNurseryRows = 1;
    const v = evaluateWakeOracles(ev);
    expect(v.failures.some((f) => f.includes("stuck 'running'"))).toBe(true);
  });
});
