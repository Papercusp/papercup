import type { RoutineSnap } from './routine-snapshot';

export type MaintenanceTarget = { installSlug: string; name: 'git-sync'; before: RoutineSnap };
export type MaintenancePlan = {
  operationId: string;
  ownerId: string;
  workItemId: string;
  reason: string;
  canonical: MaintenanceTarget;
  others: MaintenanceTarget[];
  deadlineMs: number;
  phaseTimeoutMs: number;
  cleanupTimeoutMs: number;
};
export type MaintenanceResidue = { ref: string; ownerId: string; workItemId: string; error: string };
export type MaintenanceRecoveryAuthority = {
  schemaVersion: 'routine-maintenance-recovery-v1';
  operationId: string;
  ownerId: string;
  workspaceId: string;
  timeoutMs: number;
  deadlineMs: number;
  cgroupSha256: string;
  sourceSha256: Record<string, string>;
};

export function validateMaintenanceRecoveryAuthority(authority: MaintenanceRecoveryAuthority): void {
  if (!authority || authority.schemaVersion !== 'routine-maintenance-recovery-v1' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authority.operationId) ||
      !authority.ownerId?.trim() || !authority.workspaceId?.trim() ||
      !Number.isSafeInteger(authority.timeoutMs) || authority.timeoutMs <= 0 || authority.timeoutMs > 600_000 ||
      !Number.isSafeInteger(authority.deadlineMs) || !/^[0-9a-f]{64}$/i.test(authority.cgroupSha256) ||
      !authority.sourceSha256 || Array.isArray(authority.sourceSha256) ||
      !Object.keys(authority.sourceSha256).length ||
      Object.values(authority.sourceSha256).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)))
    throw new Error('Invalid maintenance recovery authority');
}

export type MaintenanceStore = {
  prepare(plan: MaintenancePlan): Promise<void>;
  /** Immutable authority on the existing intent, before any pause effects. */
  publishRecovery(authority: MaintenanceRecoveryAuthority): Promise<void>;
  readRecovery(operationId: string): Promise<MaintenanceRecoveryAuthority | undefined>;
  pause(plan: MaintenancePlan, target: MaintenanceTarget, index: number): Promise<void>;
  previewTarget?(plan: MaintenancePlan, index: number): Promise<MaintenanceTarget>;
  previewCanonical(plan: MaintenancePlan): Promise<MaintenanceTarget>;
  assertCohort(plan: MaintenancePlan, canonicalActive: boolean): Promise<void>;
  /** Seal serializes behind in-flight pause transactions, fencing late effects. */
  seal(operationId: string): Promise<MaintenancePlan | undefined>;
  applied(operationId: string): Promise<{ auditId: string; index: number }[]>;
  restore(auditId: string): Promise<void>;
};

export function validateMaintenancePlan(plan: MaintenancePlan, now = Date.now()): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.operationId) ||
      !plan.ownerId?.trim() || !plan.workItemId?.trim() || !plan.reason?.trim())
    throw new Error('Maintenance requires unique UUID, owner, work item and reason');
  if (![plan.deadlineMs, plan.phaseTimeoutMs, plan.cleanupTimeoutMs].every(Number.isSafeInteger) ||
      plan.phaseTimeoutMs <= 0 || plan.cleanupTimeoutMs <= 0 ||
      plan.deadlineMs <= now + plan.cleanupTimeoutMs)
    throw new Error('Maintenance requires finite phase/overall bounds and reserved cleanup time');
  const targets = [...plan.others, plan.canonical];
  const keys = targets.map(t => JSON.stringify([t.installSlug, t.name]));
  if (new Set(keys).size !== keys.length || targets.some(t =>
    !t.installSlug || t.name !== 'git-sync' || !t.before?.active || t.before.groupSlug === 'release'))
    throw new Error('Maintenance cohort must be explicit, unique, active Git schedules outside release controls');
}

/** A timeout requests cancellation; it does not pretend an asynchronous write
 * stopped. The durable seal/reconciliation is mandatory before claiming cleanup. */
async function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error('Maintenance interrupted');
        return work(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        const fail = (message: string) => { controller.abort(); reject(new Error(message)); };
        timer = setTimeout(() => fail('Maintenance phase deadline exceeded'), Math.max(1, ms));
        interrupt = () => fail('Maintenance interrupted');
        signal?.addEventListener('abort', interrupt, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (interrupt) signal?.removeEventListener('abort', interrupt);
  }
}

/** Safe to rerun after process death or an unknown commit outcome. Does not use
 * operator HTTP, activate pre-existing pauses, or overwrite conflicting peers. */
export async function recoverRoutineMaintenance(store: MaintenanceStore, operationId: string, timeoutMs: number) {
  const residue: MaintenanceResidue[] = [];
  let plan: MaintenancePlan | undefined;
  const end = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, end - Date.now());
  try {
    plan = await bounded(remaining(), () => store.seal(operationId));
    const rows = await bounded(remaining(), () => store.applied(operationId));
    for (const row of rows.sort((a, b) => b.index - a.index)) {
      try {
        if (Date.now() >= end) throw new Error('Cleanup deadline reached; restore not attempted');
        await bounded(remaining(), () => store.restore(row.auditId));
      }
      catch (error) {
        residue.push({ ref: row.auditId, ownerId: plan?.ownerId ?? 'unknown', workItemId: plan?.workItemId ?? 'unknown', error: String(error) });
      }
    }
  } catch (error) {
    // DB unavailable means ownership/state is unknown, never a verified restore.
    residue.push({ ref: operationId, ownerId: plan?.ownerId ?? 'unknown', workItemId: plan?.workItemId ?? 'unknown', error: String(error) });
  }
  return { ok: residue.length === 0, operationId, residue };
}

export async function runRoutineMaintenance(
  plan: MaintenancePlan,
  store: MaintenanceStore,
  phases: {
    /** Publish durable recovery and await the separately qualified guardian. */
    recovery?(signal: AbortSignal): Promise<void>;
    /** Consume an existing qualifying canonical pass; this must not fire Git. */
    publication(signal: AbortSignal): Promise<void>;
    /** Exactly one ordinary guarded adoption; no overrides or force route. */
    adoption(signal: AbortSignal): Promise<void>;
  },
  signal?: AbortSignal,
) {
  validateMaintenancePlan(plan);
  const end = plan.deadlineMs - plan.cleanupTimeoutMs;
  const step = <T>(work: (signal: AbortSignal) => Promise<T>) => {
    if (Date.now() >= end || signal?.aborted) throw new Error('Maintenance work deadline/interruption');
    return bounded(Math.min(plan.phaseTimeoutMs, end - Date.now()), work, signal);
  };
  let failure: string | undefined;
  try {
    await step(() => store.prepare(plan));
    if (phases.recovery) await step(phases.recovery);
    for (const [index, target] of plan.others.entries()) {
      const current = store.previewTarget ? await step(() => store.previewTarget!(plan, index)) : target;
      await step(() => store.pause(plan, current, index));
    }
    await step(() => store.assertCohort(plan, true));
    await step(phases.publication);
    const canonical = await step(() => store.previewCanonical(plan));
    await step(() => store.pause(plan, canonical, plan.others.length));
    await step(() => store.assertCohort(plan, false));
    await step(phases.adoption);
  } catch (error) { failure = String(error); }
  const cleanup = await recoverRoutineMaintenance(store, plan.operationId, plan.cleanupTimeoutMs);
  // The known plan retains accountability even when DB loss hides its record.
  for (const row of cleanup.residue) {
    if (row.ownerId === 'unknown') row.ownerId = plan.ownerId;
    if (row.workItemId === 'unknown') row.workItemId = plan.workItemId;
  }
  return { ok: !failure && cleanup.ok, failure, cleanup };
}
