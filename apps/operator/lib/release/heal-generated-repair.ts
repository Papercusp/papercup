/** Explicit selective door into the existing frozen-lineage generator, never a gate verdict. */
import { basename, dirname, join } from 'node:path';
import type { FrozenCandidateRepairQueue } from '@papercusp/operator-core/lib/release/frozen-candidate-repair-queue';
import type { AdmitPathsInput, AdmissionOutcome } from '@papercusp/operator-core/lib/release/repair-head-admission';
import {
  acquireCheckpointRunLock, buildGreenCheckpointEnv, checkpointRunLockDir,
  realCheckpointDeps, runCmd,
} from './green-checkpoint';
import { releaseConfig } from './release-config';
import { healGenCheckLegs, makeRealGenCheckHealIo, type GenCheckHealIo } from './green-checkpoint-gen-check-self-heal';

// Expand only with a paired generator/check contract and regression proof.
export const SELECTIVE_DECLARATION_INPUT = 'apps/operator/scripts/tool-delivery.generated.mjs';
export const SELECTIVE_DECLARATION_OUTPUT = 'apps/operator/scripts/tool-delivery.generated.d.mts';

export interface ExplicitGeneratedRepairInput {
  integrationRoot: string;
  queue: FrozenCandidateRepairQueue;
  readQueue(): Promise<FrozenCandidateRepairQueue | null>;
  admit(input: AdmitPathsInput): Promise<AdmissionOutcome>;
  progress?(phase: 'materializing' | 'generating'): Promise<void>;
  /** Persist while holding the same run lock as materialization and regeneration. */
  record(outcome: Extract<Awaited<ReturnType<typeof healGenCheckLegs>>, { kind: 'healed' }>): Promise<boolean>;
}

export function sameGeneratedRepairQueue(a: FrozenCandidateRepairQueue | null, b: FrozenCandidateRepairQueue): boolean {
  return a !== null && a.candidate === b.candidate && a.repairHead === b.repairHead && a.updatedAtMs === b.updatedAtMs;
}

/** Runtime seam keeps tests on the real protocol without materializing a production checkout. */
export interface GeneratedRepairRuntime {
  acquire(): { acquired: false } | { acquired: true; release(): void };
  setup(head: string): Promise<void>;
  io(): GenCheckHealIo;
}

export async function healGeneratedRepair(input: ExplicitGeneratedRepairInput,
  runtime: GeneratedRepairRuntime = generatedRepairRuntime(input.integrationRoot)) {
  const lock = runtime.acquire();
  if (!lock.acquired) return { kind: 'refused' as const, reason: 'checkpoint-run-lock-held' };
  try {
    if (!sameGeneratedRepairQueue(await input.readQueue(), input.queue)) {
      return { kind: 'refused' as const, reason: 'exact_queue_identity_mismatch' };
    }
    await input.progress?.('materializing');
    await runtime.setup(input.queue.repairHead);
    await input.progress?.('generating');
    const io = runtime.io();
    const outcome = await healGenCheckLegs({ ...io, admit: async (admission) => {
      // Never regenerate on a different head or publish after a peer moved the row.
      if (!sameGeneratedRepairQueue(await input.readQueue(), input.queue)) {
        return { ok: false, code: 'lineage-ref-moved', detail: 'queue identity moved during selected generation' } as AdmissionOutcome;
      }
      return input.admit(admission);
    } }, {
      root: input.integrationRoot, queue: input.queue,
      signature: [{ id: 'gen:declarations:check' }],
      selection: { args: [`--files=${SELECTIVE_DECLARATION_INPUT}`], allowedPaths: [SELECTIVE_DECLARATION_OUTPUT] },
    });
    if (outcome.kind !== 'healed') return outcome;
    const persisted = await input.record(outcome);
    return { ...outcome, persisted };
  } finally {
    lock.release();
  }
}

function generatedRepairRuntime(integrationRoot: string) {
  // Explicit override prevents a host's operator-home checkpoint env leaking into a pot.
  const cfg = releaseConfig({ integrationRoot,
    checkpointRoot: join(dirname(integrationRoot), `${basename(integrationRoot)}-checkpoint`) });
  const deps = realCheckpointDeps(cfg);
  return {
    acquire: () => acquireCheckpointRunLock(checkpointRunLockDir(cfg.checkpointLogDir, cfg.integrationRoot)),
    async setup(head: string) {
      await deps.setupTree(head);
      const checked = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: cfg.checkpointRoot });
      if (checked.stdout.trim() !== head) throw new Error('generated repair materialized the wrong head');
    },
    io: (): GenCheckHealIo => makeRealGenCheckHealIo({
      checkpointRoot: cfg.checkpointRoot, integrationRoot,
      runScript: async (script, args) => {
        const result = await runCmd('npm', ['run', script, '--', ...(args ?? [])], {
          cwd: cfg.checkpointRoot, env: buildGreenCheckpointEnv(null, process.env), allowNonZero: true,
        });
        return { code: result.code, tail: `${result.stdout}\n${result.stderr}`.slice(-2000) };
      },
      log: (line) => console.log(line),
    }),
  };
}
