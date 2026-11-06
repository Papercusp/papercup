/** Host adapter for identity templates: canonical cell visibility + normal tool authority. */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { readCell } from '../cell-read';
import { resolveConcreteHarnessSlug } from '../agent-tools/_harness-scope';
import type { IdentityTemplateCellReader } from './state-template';
import { narrowWearerToolContext } from './wearer-authority';

export interface IdentityTemplateWearer {
  ownerId: string;
  context: UnifiedToolContext;
  /** Live pot/role ceiling resolved by the host, never authored in the template. */
  capabilityCeiling: ReadonlySet<string>;
  workItems?: string[];
}

/** Resolve authority immediately before every read; a closure must not pin old grants
 * across invocations, detach, or recovery. The template contains no authority fields. */
export function createIdentityTemplateCellReader(input: {
  resolveWearer: () => Promise<IdentityTemplateWearer>;
  declaredNeeds: readonly string[];
}): IdentityTemplateCellReader {
  return async (reference, signal) => {
    const unavailable = () => ({ status: 'unknown' as const, cell: reference.cell,
      unknown: { code: 'not-measured' as const, detail: 'identity template wearer authority is unavailable' } });
    if (signal.aborted) return unavailable();
    const wearer = await input.resolveWearer();
    const ctx = wearer.context;
    const callerContext = narrowWearerToolContext({ ownerId: wearer.ownerId, context: ctx,
      declaredNeeds: input.declaredNeeds, capabilityCeiling: wearer.capabilityCeiling, signal });
    if (!callerContext) return unavailable();
    // A superuser context carries the '*' sentinel, which is truthy but names no
    // harness; resolve it to a concrete slug (or null) before it becomes identity.
    const harnessSlug = resolveConcreteHarnessSlug(undefined, callerContext);
    return readCell(reference.cell, {
      ownerId: wearer.ownerId,
      roles: [callerContext.role],
      ...(harnessSlug ? { harnessSlug } : {}),
      ...(wearer.workItems ? { workItems: wearer.workItems } : {}),
    }, {
      workspaceId: callerContext.workspaceId, harnessSlug,
      role: callerContext.role, callerContext, signal: callerContext.signal,
    }, reference.subject);
  };
}
