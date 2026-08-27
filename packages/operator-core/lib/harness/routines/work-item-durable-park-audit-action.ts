/** On-demand deterministic report-only action for Phase 7 durable-park audits. */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { notifySyncInvalidate } from '../../sync-sse';
import {
  DEFAULT_AGENT_REVIEW_OVERDUE_HOURS,
  runWorkItemDurableParkAudit,
  WORK_ITEM_DURABLE_PARK_AUDIT,
  type DurableParkAuditReport,
} from '../../work-items-durable-park-audit';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface DurableParkAuditActionDeps {
  run: (ctx: SystemActionCtx) => Promise<DurableParkAuditReport>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function productionRun(ctx: SystemActionCtx): Promise<DurableParkAuditReport> {
  if (process.env.VITEST) throw new Error('production durable-park audit must not run from a unit test');
  const payload = ctx.payloadTemplate ?? {};
  const explicit = typeof payload.runId === 'string' ? payload.runId.trim() : '';
  const runId = explicit || DBOS.workflowID?.trim() || `${WORK_ITEM_DURABLE_PARK_AUDIT}:${randomUUID()}`;
  return runWorkItemDurableParkAudit({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId,
    reviewOverdueHours: positiveInteger(payload.reviewOverdueHours, DEFAULT_AGENT_REVIEW_OVERDUE_HOURS),
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemDurableParkAuditAction(overrides: Partial<DurableParkAuditActionDeps> = {}) {
  const deps: DurableParkAuditActionDeps = {
    run: productionRun,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_DURABLE_PARK_AUDIT}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const report = await deps.run(ctx);
    await deps.invalidate();
    deps.log(
      `${ctx.installSlug}: run=${report.runId} parks=${report.population.axes.durableParks} ` +
        `missing=${report.unparkConditions.missing} unresolved=${report.unparkConditions.unresolved} ` +
        `overdueReviews=${report.overdueReviews.rows.length} reportOnly=true`,
    );
  };
}

registerSystemAction(WORK_ITEM_DURABLE_PARK_AUDIT, makeWorkItemDurableParkAuditAction(), {
  scheduling: 'on-demand',
});
