/** Exact frozen-head generated repair, owned by a confined task rather than an HTTP caller. */
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { papercuspPath } from '@papercusp/host-platform/home';
import { withWorkspace } from '@papercusp/db-org';
import { resolveSidecarSpawnPlan, type SidecarSpawnPlan } from '../process-supervision/sidecar-spawn-shared';
import { managedSpawn } from '../task-manager/managed-spawn';
import { getTask } from '../task-manager/store';
import { killTask } from '../task-manager/control';
import { isValidTaskId, newTaskId } from '../task-manager/types';
import { applyFrozenCandidateRepairQueueTransition, readFrozenCandidateRepairQueueState } from '../harness/routines/release-actions';
import type { FrozenCandidateRepairQueue, FrozenGeneratedRepairOperation } from './frozen-candidate-repair-queue';
import type { GateVerdictTarget } from './gate-verdict-target';
import { executeWithGateActionReceipt } from './gate-action-receipt';
import { runAdmissionJob } from './admission-offthread';
import type { AdmissionJobOf } from './admission-jobs';
import { scheduleRepairAutoVerify } from './repair-auto-verify';
import type { ExplicitGeneratedRepairInput } from '../../../../apps/operator/lib/release/heal-generated-repair';

export const GENERATED_REPAIR_WORKER_MODE_ENV = 'PAPERCUSP_GENERATED_REPAIR_WORKER_MODE';
export const GENERATED_REPAIR_WORKER_INPUT_ENV = 'PAPERCUSP_GENERATED_REPAIR_WORKER_INPUT';
const OPERATION_TTL_MS = 45 * 60_000;
export interface GeneratedRepairWorkerInput {
  operationId: string;
  taskId: string;
  queueTarget: GateVerdictTarget;
  integrationRoot: string;
}
export const generatedRepairActive = (op: FrozenGeneratedRepairOperation) =>
  op.status === 'running' || op.status === 'publishing' || op.status === 'cancelling';

export function generatedRepairMatchesRequest(op: FrozenGeneratedRepairOperation, request: {
  expectedCandidate: string; expectedRepairHead: string; expectedUpdatedAtMs: number;
}): boolean {
  return op.candidate === request.expectedCandidate && op.repairHead === request.expectedRepairHead &&
    op.expectedUpdatedAtMs === request.expectedUpdatedAtMs;
}

/** Own progress advances the queue CAS; a peer write never silently becomes our revision. */
export function generatedRepairOwnsQueue(q: FrozenCandidateRepairQueue, op: FrozenGeneratedRepairOperation): boolean {
  return q.healGeneratedOperation?.operationId === op.operationId && q.candidate === op.candidate &&
    q.repairHead === op.repairHead && q.updatedAtMs === op.queueUpdatedAtMs;
}

export function updateGeneratedRepair(q: FrozenCandidateRepairQueue, op: FrozenGeneratedRepairOperation,
  change: Partial<FrozenGeneratedRepairOperation>, now = Date.now()): FrozenCandidateRepairQueue {
  const updatedAtMs = Math.max(q.updatedAtMs + 1, op.updatedAtMs, now);
  return { ...q, updatedAtMs, healGeneratedOperation: { ...op, ...change, updatedAtMs, queueUpdatedAtMs: updatedAtMs } };
}

export function buildGeneratedRepairSpawnPlan(options: {
  selfPath?: string; execPath?: string; spawnerPid?: number;
} = {}): SidecarSpawnPlan {
  const plan = resolveSidecarSpawnPlan({
    selfPath: options.selfPath ?? fileURLToPath(import.meta.url),
    devScriptPath: join(dirname(fileURLToPath(import.meta.url)), 'generated-repair-worker-bin.ts'),
    bundledModeEnvVar: GENERATED_REPAIR_WORKER_MODE_ENV,
    execPath: options.execPath ?? process.execPath, spawnerPid: options.spawnerPid ?? process.pid,
  });
  delete plan.env.PAPERCUSP_DESKTOP_PARENT_PID;
  return plan;
}

export async function startGeneratedRepairWorker(input: GeneratedRepairWorkerInput,
  options: { spawn?: typeof managedSpawn; spawnPlan?: SidecarSpawnPlan; logDir?: string } = {}) {
  if (!isValidTaskId(input.taskId)) throw new Error('invalid generated repair task id');
  const plan = options.spawnPlan ?? buildGeneratedRepairSpawnPlan();
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env, [GENERATED_REPAIR_WORKER_INPUT_ENV]: JSON.stringify(input) };
  delete env.PAPERCUSP_DESKTOP_PARENT_PID;
  const logDir = options.logDir ?? papercuspPath('checkpoint-logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `generated-repair-${input.taskId}.log`);
  const fd = openSync(logPath, 'a', 0o600);
  try {
    return await (options.spawn ?? managedSpawn)(plan.cmd, plan.args, {
      class: 'bash-job', title: `Generated repair ${input.operationId}`, argv: [plan.cmd, ...plan.args],
      cwd: input.integrationRoot, launchedBy: 'release:repair-queue:heal-generated', logPath,
      detail: { operationId: input.operationId, subsystem: 'frozen-generated-repair' }, runtimeMaxSec: OPERATION_TTL_MS / 1000,
    }, { taskId: input.taskId, workspaceId: input.queueTarget.workspaceId,
      spawnOptions: { cwd: input.integrationRoot, env, stdio: ['ignore', fd, fd] } });
  } finally { closeSync(fd); }
}

const defaultDeps = {
  transition: applyFrozenCandidateRepairQueueTransition, readQueue: readFrozenCandidateRepairQueueState,
  getTask, killTask, startWorker: startGeneratedRepairWorker,
  heal: async (input: ExplicitGeneratedRepairInput) =>
    (await import('../../../../apps/operator/lib/release/heal-generated-repair')).healGeneratedRepair(input),
  action: executeWithGateActionReceipt, admit: (job: AdmissionJobOf<'admit'>) => runAdmissionJob(job), autoVerify: scheduleRepairAutoVerify,
  async notify(target: GateVerdictTarget, op: FrozenGeneratedRepairOperation) {
    const result = op.result!;
    if (result.admitted !== true || result.persisted !== true) return;
    const head = (result.repairQueue as { repairHead: string }).repairHead;
    const { emitAwaitedEvent } = await import('../events/await/engine');
    const { fireBuiltinReactionAction, GATE_REJUDGE_ADMITTED_REPAIR_ACTION } = await import('../events/builtin-actions');
    await emitAwaitedEvent({ key: `gate:repair-admitted:${op.candidate}`,
      summary: `Frozen repair admitted ${head}`, payload: { candidate: op.candidate, repairHead: head, installSlug: target.installSlug },
      source: 'release:repair-queue:heal-generated', workspaceId: target.workspaceId });
    const rejudged = await fireBuiltinReactionAction(GATE_REJUDGE_ADMITTED_REPAIR_ACTION,
      { candidate: op.candidate, repairHead: head, installSlug: target.installSlug }, target.workspaceId);
    if (!rejudged?.ok) throw new Error('generated repair rejudge enqueue failed');
  },
};
export type GeneratedRepairDeps = typeof defaultDeps;

export async function beginGeneratedRepair(input: { queueTarget: GateVerdictTarget; integrationRoot: string;
  queue: FrozenCandidateRepairQueue; actor: string; conditionKey: string;
  delegate: FrozenGeneratedRepairOperation['delegate'] }, deps: GeneratedRepairDeps = defaultDeps) {
  const q = input.queue;
  const operation: FrozenGeneratedRepairOperation = { schemaVersion: 1, operationId: `generated-repair-${randomUUID()}`,
    taskId: newTaskId(), candidate: q.candidate, repairHead: q.repairHead, expectedUpdatedAtMs: q.updatedAtMs,
    queueUpdatedAtMs: q.updatedAtMs, actor: input.actor, conditionKey: input.conditionKey, delegate: input.delegate,
    status: 'running', phase: 'launching', startedAtMs: Date.now(), updatedAtMs: Date.now(), expiresAtMs: Date.now() + OPERATION_TTL_MS };
  const saved = await deps.transition(input.queueTarget, fresh => {
    if (fresh.healGeneratedOperation && (generatedRepairActive(fresh.healGeneratedOperation) ||
        generatedRepairMatchesRequest(fresh.healGeneratedOperation, { expectedCandidate: q.candidate,
          expectedRepairHead: q.repairHead, expectedUpdatedAtMs: q.updatedAtMs }))) return fresh;
    if (fresh.candidate !== q.candidate || fresh.repairHead !== q.repairHead || fresh.updatedAtMs !== q.updatedAtMs) return fresh;
    return updateGeneratedRepair(fresh, operation, {});
  });
  const stored = saved.queue?.healGeneratedOperation;
  if (!stored || stored.operationId !== operation.operationId) return { started: false, operation: stored ?? null };
  try {
    const launched = await deps.startWorker({ operationId: stored.operationId, taskId: stored.taskId,
      queueTarget: input.queueTarget, integrationRoot: input.integrationRoot });
    if (!launched.confined) throw new Error('generated repair worker is not confined');
  } catch (error) {
    // A lost launch response can leave a real task. Reconcile, never repeat the launch.
    const task = await deps.getTask(stored.taskId).catch(() => undefined);
    if (task === null || (task && !['pending', 'running'].includes(task.state))) {
      await settleGeneratedRepair(input.queueTarget, stored.operationId, 'failed',
        { ok: false, admitted: false, reason: `worker-launch-failed: ${String(error)}` }, deps);
    }
  }
  const read = await deps.readQueue(input.queueTarget);
  return { started: true, operation: read.status === 'value' ? read.queue.healGeneratedOperation ?? stored : stored };
}

async function settleGeneratedRepair(target: GateVerdictTarget, id: string,
  status: 'failed' | 'interrupted' | 'cancelled' | 'succeeded', result: Record<string, unknown>, deps: GeneratedRepairDeps) {
  return deps.transition(target, fresh => {
    const op = fresh.healGeneratedOperation;
    if (!op || op.operationId !== id || !generatedRepairActive(op)) return fresh;
    return updateGeneratedRepair(fresh, op, { status, phase: 'settled', result: {
      // Only this fresh CAS row can establish whether publication was reserved.
      // A caller may have computed an explicit false before that reservation.
      ...result, ...(op.status === 'publishing' ? { effectMayHaveRun: true } : {}),
    } });
  });
}

/** Recover notifications from the stored terminal result, including after caller/host loss. */
export async function observeGeneratedRepair(target: GateVerdictTarget, deps: GeneratedRepairDeps = defaultDeps) {
  const read = await deps.readQueue(target);
  if (read.status !== 'value' || !read.queue.healGeneratedOperation) return null;
  let op = read.queue.healGeneratedOperation;
  if (generatedRepairActive(op)) {
    const task = await deps.getTask(op.taskId); // A failed read is unknown, never a dead-task verdict.
    if ((task && !['pending', 'running'].includes(task.state)) || (!task && Date.now() - op.startedAtMs > 30_000)) {
      const saved = await settleGeneratedRepair(target, op.operationId, 'interrupted', {
        ok: false, admitted: false, reason: 'managed-worker-ended-without-terminal-result',
        effectMayHaveRun: op.status === 'publishing', taskState: task?.state ?? 'absent',
      }, deps);
      op = saved.queue?.healGeneratedOperation ?? op;
    }
  }
  if (op.status === 'succeeded' && !op.notificationsComplete) {
    try {
      await deps.notify(target, op);
      const head = (op.result?.repairQueue as { repairHead?: string } | undefined)?.repairHead;
      if (op.result?.admitted === true && head) {
        const scheduled = await deps.autoVerify({ target, candidate: op.candidate, repairHead: head, admittedAtMs: op.updatedAtMs });
        if (!scheduled.scheduled) return op;
      }
      const saved = await deps.transition(target, fresh => {
        const current = fresh.healGeneratedOperation;
        return current?.operationId === op.operationId && current.status === 'succeeded' && !current.notificationsComplete
          ? updateGeneratedRepair(fresh, current, { notificationsComplete: true }) : fresh;
      });
      op = saved.queue?.healGeneratedOperation ?? op;
    } catch (error) { console.error('[generated-repair] terminal notifications remain recoverable', error); }
  }
  return op;
}

export async function cancelGeneratedRepair(target: GateVerdictTarget, id: string, deps: GeneratedRepairDeps = defaultDeps) {
  const saved = await deps.transition(target, fresh => {
    const op = fresh.healGeneratedOperation;
    // Cancellation and the publication reservation race on the SAME queue CAS.
    return op?.operationId === id && op.status === 'running'
      ? updateGeneratedRepair(fresh, op, { status: 'cancelling', phase: 'cancelling' }) : fresh;
  });
  const op = saved.queue?.healGeneratedOperation;
  if (!op || op.operationId !== id || op.status !== 'cancelling') return { cancelled: false, reason: 'operation-not-cancellable', operation: op };
  const killed = await deps.killTask(op.taskId);
  const terminal = await settleGeneratedRepair(target, id, killed.ok ? 'cancelled' : 'interrupted', {
    ok: false, admitted: false, reason: killed.ok ? 'cancelled' : 'cancellation-unconfirmed', kill: killed,
  }, deps);
  return { cancelled: killed.ok, operation: terminal.queue?.healGeneratedOperation };
}

export async function runGeneratedRepairWorker(input: GeneratedRepairWorkerInput, deps: GeneratedRepairDeps = defaultDeps) {
  const read = await deps.readQueue(input.queueTarget);
  if (read.status !== 'value') return;
  const initial = read.queue.healGeneratedOperation;
  if (!initial || initial.operationId !== input.operationId || initial.taskId !== input.taskId || initial.status !== 'running') return;
  // registerTask precedes the fork, but markSpawned confirms confinement AFTER
  // the child is already running. Await that acknowledgement rather than
  // mistaking the normal pending row for an unconfined launch. Parent loss or
  // a failed acknowledgement must terminate honestly without doing repair work.
  const enrollmentDeadline = Math.min(Date.now() + 30_000, initial.expiresAtMs);
  for (;;) {
    let task: Awaited<ReturnType<GeneratedRepairDeps['getTask']>> | undefined;
    let taskReadError: string | undefined;
    try { task = await deps.getTask(input.taskId); }
    catch (error) { taskReadError = String(error); }
    if (task?.state === 'running' && task.confined) break;
    if ((task && task.state !== 'pending') || Date.now() >= enrollmentDeadline) {
      await settleGeneratedRepair(input.queueTarget, input.operationId, 'interrupted', {
        ok: false, admitted: false, reason: 'managed-worker-enrollment-unconfirmed', effectMayHaveRun: false,
        taskState: task?.state ?? 'unknown', ...(taskReadError ? { taskReadError } : {}),
      }, deps);
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, enrollmentDeadline - Date.now())));
    const current = await deps.readQueue(input.queueTarget);
    if (current.status !== 'value' || current.queue.healGeneratedOperation?.operationId !== input.operationId ||
        current.queue.healGeneratedOperation.status !== 'running' ||
        !generatedRepairOwnsQueue(current.queue, current.queue.healGeneratedOperation)) return;
  }
  const base = { ...read.queue, updatedAtMs: initial.expectedUpdatedAtMs };
  let receiptId: string | undefined;
  try {
    const outcome = await deps.heal({ integrationRoot: input.integrationRoot, queue: base,
      readQueue: async () => {
        const r = await deps.readQueue(input.queueTarget);
        if (r.status === 'unreadable') throw new Error('generated repair queue became unreadable');
        const q = r.status === 'value' ? r.queue : null;
        const op = q?.healGeneratedOperation;
        return q && op && op.operationId === input.operationId && op.taskId === input.taskId &&
          (op.status === 'running' || op.status === 'publishing') && Date.now() < op.expiresAtMs && generatedRepairOwnsQueue(q, op)
          ? { ...q, updatedAtMs: initial.expectedUpdatedAtMs } : null;
      },
      progress: async phase => {
        await deps.transition(input.queueTarget, q => {
          const op = q.healGeneratedOperation;
          if (!op || op.operationId !== input.operationId || op.status !== 'running' || !generatedRepairOwnsQueue(q, op))
            throw new Error('generated repair lost its running queue revision');
          return updateGeneratedRepair(q, op, { phase });
        });
      },
      admit: async admission => {
        const reserved = await deps.transition(input.queueTarget, q => {
          const op = q.healGeneratedOperation;
          return op?.operationId === input.operationId && op.status === 'running' && generatedRepairOwnsQueue(q, op) && Date.now() < op.expiresAtMs
            ? updateGeneratedRepair(q, op, { status: 'publishing', phase: 'publishing' }) : q;
        });
        const op = reserved.queue?.healGeneratedOperation;
        if (!op || op.operationId !== input.operationId || op.status !== 'publishing' || reserved.status !== 'written')
          throw new Error('generated repair publication reservation lost');
        const receipt = await deps.action({ action: 'release:repair-queue', actor: op.actor, ownerId: op.actor,
          conditionKey: op.conditionKey, allowUnowned: true, delegate: op.delegate,
          target: { op: 'heal-generated', candidate: op.candidate, repairHead: op.repairHead, operationId: op.operationId },
          run: () => deps.admit({ kind: 'admit', input: admission, preflight: null }),
          summarize: effect => ({ status: effect.ok ? 'lineage-ref-published' : 'not-published' }),
        });
        receiptId = receipt.receiptId ?? undefined;
        if (!receipt.ok) throw new Error(`generated repair publication refused: ${receipt.reason}`);
        return receipt.effect;
      },
      record: async healed => {
        const { genCheckHealTransition } = await import('../../../../apps/operator/lib/release/green-checkpoint-gen-check-self-heal');
        const saved = await deps.transition(input.queueTarget, q => {
          const op = q.healGeneratedOperation;
          if (!op || op.operationId !== input.operationId || op.status !== 'publishing' || !generatedRepairOwnsQueue(q, op)) return q;
          const next = genCheckHealTransition(q, base, healed);
          if (next.repairHead !== healed.toRepairHead || !next.admissions?.some(a => a.toRepairHead === healed.toRepairHead)) return q;
          return updateGeneratedRepair(next, op, { status: 'succeeded', phase: 'settled', result: {
            ok: true, admitted: true, persisted: true, outcome: { ...healed, persisted: true },
            repairQueue: { candidate: op.candidate, repairHead: healed.toRepairHead },
            movedRepairHead: { from: op.repairHead, to: healed.toRepairHead },
            completionReceipt: { status: 'recorded', effectRef: `release:repair-queue:heal-generated:${receiptId}` },
          } });
        });
        return saved.queue?.healGeneratedOperation?.operationId === input.operationId && saved.queue.healGeneratedOperation.status === 'succeeded';
      },
    });
    if (outcome.kind !== 'healed' || !outcome.persisted) {
      await settleGeneratedRepair(input.queueTarget, input.operationId, outcome.kind === 'already-fresh' ? 'succeeded' : 'failed',
        { ok: outcome.kind === 'already-fresh', admitted: false, persisted: false, outcome }, deps);
    }
  } catch (error) {
    await settleGeneratedRepair(input.queueTarget, input.operationId, 'failed', {
      ok: false, admitted: false, reason: String(error), ...(receiptId ? { receiptId, effectMayHaveRun: true } : {}),
    }, deps);
  }
  await observeGeneratedRepair(input.queueTarget, deps);
}

export function parseGeneratedRepairWorkerInput(raw: string | undefined): GeneratedRepairWorkerInput | null {
  try {
    const r = JSON.parse(raw ?? '') as GeneratedRepairWorkerInput;
    return r && typeof r.operationId === 'string' && r.operationId.startsWith('generated-repair-') && isValidTaskId(r.taskId) &&
      typeof r.integrationRoot === 'string' && r.integrationRoot.startsWith('/') &&
      typeof r.queueTarget?.workspaceId === 'string' && !!r.queueTarget.workspaceId &&
      typeof r.queueTarget.installSlug === 'string' && !!r.queueTarget.installSlug ? r : null;
  } catch { return null; }
}

export async function runGeneratedRepairWorkerMain(): Promise<never> {
  let code = 0;
  try {
    const input = parseGeneratedRepairWorkerInput(process.env[GENERATED_REPAIR_WORKER_INPUT_ENV]);
    if (!input) { console.error('generated repair worker input is missing or invalid'); code = 2; }
    else await withWorkspace(input.queueTarget.workspaceId, () => runGeneratedRepairWorker(input));
  } catch (error) { console.error('[generated-repair] worker failed', error); code = 1; }
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise<void>(resolve => stream.write('', () => resolve()))));
  process.exit(code);
}
