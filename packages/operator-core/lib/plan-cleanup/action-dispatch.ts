/**
 * Canonical write dispatcher for one plan-cleanup finding.
 *
 * Resolver auto-apply and owner review acceptance both call this seam. Plan
 * mutations are re-dispatched through the existing tools a hand edit uses; an
 * orphaned claim goes through the existing stale-claim reaper with an exact key.
 * No cleanup caller writes plan/claim tables directly.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { InnerCall } from '../agent-tools/_compound-dispatch';
import type { BulkRunRow } from '../attention/bulk-run-store';
import { reclaimExpiredPlanItemClaims } from '../plan-items/stale-claims';
import type { CleanupFinding } from './scanner';

function innerFailure(name: string, result: unknown): Error | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as Record<string, unknown>;
  if (value.ok === false || typeof value.error === 'string') {
    return new Error(`${name}: ${String(value.error ?? value.message ?? 'operation refused')}`);
  }
  const failed = Array.isArray(value.results)
    ? value.results.find(
        (entry) => entry && typeof entry === 'object' && (entry as { ok?: unknown }).ok === false,
      ) as Record<string, unknown> | undefined
    : undefined;
  return failed
    ? new Error(`${name}: ${String(failed.error ?? failed.detail ?? failed.message ?? 'operation refused')}`)
    : null;
}

async function callRequired(
  call: InnerCall,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await call(name, args);
  const failure = innerFailure(name, result);
  if (failure) throw failure;
  return result;
}

export async function dispatchCleanupFindingAction(input: {
  run: BulkRunRow;
  finding: CleanupFinding;
  call: InnerCall;
}): Promise<unknown> {
  const { run, finding, call } = input;
  const harness = finding.harnessSlug || run.harnessSlug || undefined;

  switch (finding.kind) {
    case 'flip-to-done': {
      if (!finding.itemId) throw new Error(`${finding.findingId}: item id is required`);
      return callRequired(call, 'plans:set-status', {
        slug: finding.planSlug,
        item: finding.itemId,
        status: 'done',
        ...(harness ? { harness } : {}),
      });
    }
    case 'cleared-blocker': {
      if (!finding.itemId) throw new Error(`${finding.findingId}: item id is required`);
      return callRequired(call, 'plans:set-status', {
        slug: finding.planSlug,
        item: finding.itemId,
        status: 'todo',
        ...(harness ? { harness } : {}),
      });
    }
    case 'finish-plan':
      return callRequired(call, 'plans:set-plan-status', {
        slug: finding.planSlug,
        status: 'shipped',
        ...(harness ? { harness } : {}),
      });
    case 'archive-candidate':
      return callRequired(call, 'plans:set-archived', {
        slug: finding.planSlug,
        archived: true,
        ...(harness ? { harness } : {}),
      });
    case 'orphaned-claim': {
      if (!finding.itemId || !harness) {
        throw new Error(`${finding.findingId}: exact harness and item id are required`);
      }
      const { sql } = getOrgPg();
      const reaped = await reclaimExpiredPlanItemClaims(sql, {
        key: {
          workspaceId: run.workspaceId,
          harnessSlug: harness,
          planSlug: finding.planSlug,
          itemId: finding.itemId,
        },
      });
      if (reaped.released.length !== 1) {
        throw new Error(
          `${finding.findingId}: stale claim was not released (it disappeared, revived, or is no longer beyond grace)`,
        );
      }
      return { released: reaped.released[0] };
    }
    case 'stale-now':
      throw new Error(
        `${finding.findingId}: refreshing ## Now requires an authored state/next proposal; keep this finding recommended`,
      );
  }
}
