/**
 * The experiment descriptors (`experiment-registry-invocation-api` P-011) — the four
 * existing eval-battery Subjects registered as discoverable {@link TestDescriptor}s
 * over the ONE engine. The descriptor's `run` DELEGATES to the Subject's existing
 * runner (no Subject is reconstructed — D-001/audit D-008).
 *
 * v1 fully wires the OFFLINE tier (replay — ~$0, deterministic, the default front
 * door per D-004). The three live-spend tiers (gym component / iq-battery
 * whole-instance / hive-eval whole-hive) are registered with COMPLETE catalog
 * metadata but their `run` is staged: it refuses until the live runner + deps are
 * bound (the P-011 follow-on), matching the staged-arming discipline — discoverable,
 * not yet executable.
 */
import { BASELINE_ID, registerTest, type TestDescriptor } from '@papercusp/eval-battery';
import {
  DEFAULT_REPLAY_RUBRIC,
  REPLAY_BASELINE_VARIANT,
  runReplayBattery,
  type ReplayBatteryResult,
} from '../replay/battery';
import type { ReplayCase, ReplayVariant } from '../replay/types';
import { partitionArm, validateArm, type KnobArm } from './knob-space';
import type { GymExperimentPayload } from './gym-run-core';
import type { ExperimentRequest, ExperimentRunCtx, ExperimentRunResult } from './types';

/** Injectable seam — the runners the descriptors delegate to (real by default; a
 *  test passes fakes so descriptor mapping is unit-tested with no LLM/PG). */
export interface ExperimentDescriptorDeps {
  runReplayBattery: typeof runReplayBattery;
}
const defaultDeps: ExperimentDescriptorDeps = { runReplayBattery };

type ExperimentDescriptor = TestDescriptor<ExperimentRequest, ExperimentRunResult, ExperimentRunCtx>;

// --------------------------------------------------------------------------
// replay (offline, fully wired) — varies the resumed agent's policy/system prompt
// --------------------------------------------------------------------------

/** Replay can vary the agent's system prompt/policy + the continuation MODEL (P-063). */
const REPLAY_KNOB_SLICE = ['overlay.systemOverlay', 'overlay.systemReplace', 'model'] as const;

interface ReplayPayload {
  cases: ReplayCase[];
}

/** Map an arm → a ReplayVariant. The empty-knobs arm IS the historical baseline.
 *  Exported for the experiment:run path (run-core), which routes the same mapping
 *  through the governed replay substrate. */
export function armToReplayVariant(arm: KnobArm): ReplayVariant {
  if (Object.keys(arm.knobs).length === 0) return REPLAY_BASELINE_VARIANT;
  const { overlay, models } = partitionArm(arm);
  const policy: ReplayVariant['policy'] = {};
  if (typeof overlay.systemReplace === 'string') policy.systemReplace = overlay.systemReplace;
  if (typeof overlay.systemOverlay === 'string') policy.systemOverlay = overlay.systemOverlay;
  // Replay has one agent, so the first model.<role> knob sets the continuation model.
  const model = Object.values(models)[0];
  if (typeof model === 'string') policy.model = model;
  return { variantId: arm.id, label: arm.label ?? arm.id, policy };
}

/** Normalize a ReplayBatteryResult → the common ExperimentRunResult. Exported for
 *  the experiment:run path (run-core). */
export function replayResultToExperimentResult(r: ReplayBatteryResult): ExperimentRunResult {
  return {
    testId: 'replay',
    tier: 'offline',
    baselineId: BASELINE_ID,
    arms: r.perVariant.map((v) => ({
      id: v.variantId,
      label: v.label,
      meanScore: v.meanComposite,
      cells: v.cells,
      scored: v.scored,
      costUsd: v.costUsd,
    })),
    comparison: r.comparison,
    winner: r.comparison?.selected ?? null,
    totalCostUsd: r.totalCostUsd,
    budgetExhausted: r.budgetExhausted,
  };
}

export function replayDescriptor(deps: ExperimentDescriptorDeps = defaultDeps): ExperimentDescriptor {
  return {
    id: 'replay',
    summary:
      'Counterfactual replay — re-run a historical/synthetic transcript point under a varied agent policy or model and score the divergence vs what actually happened. ~$0, deterministic baseline; the default offline tier (D-004).',
    kind: 'replay',
    fidelityTier: 'offline',
    costClass: 'free',
    knobSlice: [...REPLAY_KNOB_SLICE],
    metrics: {
      signals: ['divergence.tokenJaccard'],
      rubricDimensions: Object.keys(DEFAULT_REPLAY_RUBRIC.dimensions),
    },
    async run(request, ctx) {
      if (!ctx.replayRunner) throw new Error('replay descriptor requires ctx.replayRunner (the offline runner)');
      for (const arm of request.arms) {
        const v = validateArm(arm, REPLAY_KNOB_SLICE);
        if (!v.ok) {
          const bad = [...v.outOfSlice, ...v.excluded.map((e) => `${e} (safety-excluded)`)].join(', ');
          throw new Error(`replay arm "${arm.id}" has knobs outside its slice: ${bad}`);
        }
      }
      const payload = request.payload as ReplayPayload | undefined;
      if (!payload?.cases?.length) throw new Error('replay request.payload.cases is required');

      const result = await deps.runReplayBattery(
        {
          batteryId: request.batteryId,
          variants: request.arms.map(armToReplayVariant),
          cases: payload.cases,
          repeats: request.repeats,
          ...(request.maxDistillChars !== undefined ? { maxDistillChars: request.maxDistillChars } : {}),
          ...(request.budgetUsd !== undefined ? { maxSpendUsd: request.budgetUsd } : {}),
        },
        {
          runner: ctx.replayRunner,
          llmCall: ctx.llmCall,
          now: ctx.now,
          ...(ctx.store?.replay ? { store: ctx.store.replay } : {}),
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        },
      );
      return replayResultToExperimentResult(result);
    },
  };
}

// --------------------------------------------------------------------------
// the live-spend tiers — registered + discoverable, run staged until bound
// --------------------------------------------------------------------------

/**
 * The whole-instance / whole-Hive tiers (the gated cost-exception, D-002). Their live
 * runners (the iq-battery boot / hive-eval ports) are heavy infra `experiment:run`
 * cannot provision, and their OWN loops (apiary / hive-eval) already drive them — so
 * binding a live runner-config here would be speculative, unverifiable, and redundant
 * (D-017). They are therefore BOUND TO THE CONTRACT but STAGED: the run validates the
 * arm against the test's `['genome','model']` slice + the safety set (P-021) and
 * PARTITIONS it — threading the `genome.*` delta + the `model.<role>` axis exactly like
 * the reachable replay/gym tiers — then refuses with NO spend, pointing at the ctx dep
 * slot that un-stages it (the gym worked example, P-066/P-068). Wiring the live
 * runner-config + the spawn-time model override is purely additive when that infra is
 * supplied. (P-063 end-state: "discoverable-but-staged — run() refuses".)
 */
function stagedGenomeModelDescriptor(
  meta: Omit<ExperimentDescriptor, 'run'> & { fidelityTier: 'live' },
  ctxSlot: 'instance' | 'hive',
  liveDepHint: string,
): ExperimentDescriptor {
  return {
    ...meta,
    async run(request, ctx) {
      // Validate + partition every arm — proves the genome/model slice gate + that the
      // genome delta and model.<role> overrides fold cleanly, even while staged.
      for (const arm of request.arms) {
        const v = validateArm(arm, meta.knobSlice);
        if (!v.ok) {
          const bad = [...v.outOfSlice, ...v.excluded.map((e) => `${e} (safety-excluded)`)].join(', ');
          throw new Error(`${meta.id} arm "${arm.id}" has knobs outside its slice: ${bad}`);
        }
        partitionArm(arm); // throws on a malformed genome/model knob (defense in depth)
      }
      const bound = ctxSlot === 'instance' ? ctx.instance?.deps : ctx.hive?.ports;
      throw new Error(
        `the "${meta.id}" test (${meta.kind}, ${meta.fidelityTier} tier) is the gated cost-exception (D-002) and stays STAGED — ` +
          (bound
            ? `its live runner-config + spawn-time model.<role> binding is deferred to the ${liveDepHint} that owns it (D-017).`
            : `it requires ctx.${ctxSlot}.${ctxSlot === 'instance' ? 'deps' : 'ports'} (the ${liveDepHint}), which experiment:run does not provision — its own loop drives it (D-017). `) +
          `Screen the knob change on the offline replay tier instead (P-040/D-004).`,
      );
    },
  };
}

export function gymDescriptor(): ExperimentDescriptor {
  const knobSlice = ['overlay', 'model'];
  return {
    id: 'gym',
    summary:
      'Component eval — run the real coding pipeline inside a fixed harness under a per-role prompt overlay (`overlay.<role>`) / model swap (`model.<role>`) and judge the diff (the gym HarnessSubject). Live agent spend; mapped + wired but STAGED until the owner arms the gym AbDeps (P-063).',
    kind: 'component',
    fidelityTier: 'live',
    costClass: 'high',
    knobSlice,
    metrics: { signals: ['regressionsFromTests', 'plantedBugCaught', 'cost'], rubricDimensions: ['d1', 'd2', 'd3'] },
    async run(request, ctx) {
      for (const arm of request.arms) {
        const v = validateArm(arm, knobSlice);
        if (!v.ok) {
          const bad = [...v.outOfSlice, ...v.excluded.map((e) => `${e} (safety-excluded)`)].join(', ');
          throw new Error(`gym arm "${arm.id}" has knobs outside its slice: ${bad}`);
        }
      }
      const { gymRunCore } = await import('./gym-run-core');
      return gymRunCore(
        {
          batteryId: request.batteryId,
          arms: request.arms,
          payload: request.payload as GymExperimentPayload,
          repeats: request.repeats,
          ...(request.maxDistillChars !== undefined ? { maxDistillChars: request.maxDistillChars } : {}),
        },
        { workspaceId: ctx.workspaceId, ...(ctx.gym?.abDeps ? { abDeps: ctx.gym.abDeps } : {}) },
      );
    },
  };
}

export function instanceDescriptor(): ExperimentDescriptor {
  return stagedGenomeModelDescriptor(
    {
      id: 'instance',
      summary:
        'Whole-instance eval — boot a config-varied instance from a genome delta (the iq-battery InstanceSubject) and score it. The gated cost-exception, used when a component eval cannot isolate the variable (D-002).',
      kind: 'whole-instance',
      fidelityTier: 'live',
      costClass: 'high',
      knobSlice: ['genome', 'model'],
      metrics: { signals: ['status', 'tokens', 'escalation'], rubricDimensions: ['composite'] },
    },
    'instance',
    'iq-battery boot (the apiary loop)',
  );
}

export function hiveDescriptor(): ExperimentDescriptor {
  return stagedGenomeModelDescriptor(
    {
      id: 'hive',
      summary:
        'Whole-hive eval — run a seeded Hive scenario end-to-end (the hive-eval Subject) and score outcome × efficiency × speed. Live agent spend.',
      kind: 'whole-hive',
      fidelityTier: 'live',
      costClass: 'high',
      knobSlice: ['genome', 'model'],
      metrics: { signals: ['outcome', 'efficiency', 'speed'], rubricDimensions: ['outcome', 'efficiency', 'speed'] },
    },
    'hive',
    'hive-eval ports (the hive-eval loop)',
  );
}

// --------------------------------------------------------------------------
// registration
// --------------------------------------------------------------------------

let registered = false;

/** Register the four descriptors into the eval-battery default registry. Idempotent
 *  (the host calls it at boot; the catalog/run tools call it lazily). */
export function registerExperimentDescriptors(deps: ExperimentDescriptorDeps = defaultDeps): void {
  if (registered) return;
  registerTest(replayDescriptor(deps));
  registerTest(gymDescriptor());
  registerTest(instanceDescriptor());
  registerTest(hiveDescriptor());
  registered = true;
}

/** Test seam — reset the idempotency latch (pair with `resetTestRegistry`). */
export function _resetExperimentRegistration(): void {
  registered = false;
}
