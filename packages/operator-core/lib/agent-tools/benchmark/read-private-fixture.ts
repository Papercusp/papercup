/** The existing native bench host's assignment-bound read bridge. */
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { InvalidInputError, type ToolResponse } from '@papercusp/tooldef';
import { withWorkspace } from '@papercusp/db-org';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import { resolveAgentIdentity } from '../coordination/identity';
import { readSessionConfinement } from '../../capability-envelope/session-confinement-store';
import { validWorkItemBoundary } from '../../capability-envelope/session-confinement';
import { getWorkItem, isSelfOwnerRecord } from '../../work-items';
import { isSettledWorkItem } from '../../work-items-events';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { BENCH_PRIVATE_FIXTURE_TOOL, benchFixtureReadArgs, benchFixtureProductCall,
  benchFixtureReadContinuations, validBenchFixtureReadBoundary,
  requireBenchFixtureReadLease, requireBenchFixtureSourcePins, benchFixtureResultSnapshot,
  benchFixtureResultFits, benchFixtureResultPage } from '../../external-bench/private-fixture-reads';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'benchmark:read-private-fixture',
  description: 'Read the source fixture assigned by the native benchmark host. Choose input A/B and a declared read operation; follow card continuations using the same operation and case. A privateFixtureResult page contains exact JSON text: follow next, concatenate text by offset until complete, verify sha256, then parse. Source identities and workspace are fixed by the host. Saved recipes are read as data only.',
  capability: 'work_items:read', requirePrincipal: false, skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'worker', 'cup'],
  args: benchFixtureReadArgs,
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const { ownerId, workspaceId } = resolveAgentIdentity(ctx);
    if (!workspaceId || workspaceId === '*' || workspaceId !== ctx.workspaceId)
      throw new InvalidInputError('Private fixture read requires the authenticated assignment workspace.');
    const ceiling = await readSessionConfinement(ownerId, workspaceId);
    const boundary = ceiling?.denyBenchmarkReadsOutside, item = ceiling?.denyWorkItemsOutside;
    if (!validBenchFixtureReadBoundary(boundary) || boundary.workspaceId !== workspaceId || !validWorkItemBoundary(item) ||
        ceiling?.denyAmbientContext !== true ||
        !ceiling?.denyOutside?.includes(BENCH_PRIVATE_FIXTURE_TOOL) ||
        ceiling.imposedBy !== `benchmark-host ${boundary.assignmentId}`)
      throw new InvalidInputError('Private fixture read requires its live host-bound benchmark assignment.');
    const call = benchFixtureProductCall(boundary, args);
    const budgetBytes = Math.min(6000, computeTurnDoors(0, getDoorConstantsSync(ownerId)).resultEach * CHARS_PER_TOKEN_ESTIMATE);
    return runWithWorkspaceIfConcrete(workspaceId, async () => {
      await requireBenchFixtureReadLease(boundary, { workspaceId });
      await requireBenchFixtureSourcePins(boundary, { workspaceId });
      const held = await getWorkItem(item.id, item.harness);
      if (!held || held.harness !== item.harness || isSettledWorkItem(held) || !isSelfOwnerRecord(held.assignee, ownerId))
        throw new InvalidInputError('Private fixture read requires the caller to hold the exact nonterminal assignment.');
      if (args.resultCursor) {
        const snapshot = await benchFixtureResultSnapshot(boundary, call, { workspaceId });
        await requireBenchFixtureSourcePins(boundary, { workspaceId });
        await requireBenchFixtureReadLease(boundary, { workspaceId });
        return { data: benchFixtureResultPage(snapshot, args, budgetBytes) };
      }
      // Invoke maintained read handlers, with their own argument validation.
      // No dynamic tool name, execution/replay option, source scope or SQL is accepted.
      const tool = call.tool === 'scorecards:get' ? (await import('../scorecards/get')).default :
        call.tool === 'scorecards:list' ? (await import('../scorecards/list')).default :
          call.tool === 'plans:get' ? (await import('../plans/get')).default :
            call.tool === 'plans:get-specs' ? (await import('../plans/get-specs')).default : (await import('../sessions/timeline')).default;
      const parsed = tool.args.parse(call.args);
      const read = (context: PapercuspUnifiedToolContext) =>
        (tool.handler as (args: unknown, ctx: PapercuspUnifiedToolContext) => Promise<ToolResponse>)(parsed, context);
      const result = call.tool === 'sessions:timeline'
        ? await withWorkspace(workspaceId, tx => read({ ...ctx, tx })) : await read(ctx);
      await requireBenchFixtureSourcePins(boundary, { workspaceId });
      await requireBenchFixtureReadLease(boundary, { workspaceId });
      const data = benchFixtureReadContinuations(result.data, call, args);
      if (benchFixtureResultFits(data, budgetBytes)) return { ...result, data };
      const snapshot = await benchFixtureResultSnapshot(boundary, call, { workspaceId }, JSON.stringify(data));
      await requireBenchFixtureSourcePins(boundary, { workspaceId });
      await requireBenchFixtureReadLease(boundary, { workspaceId });
      return { data: benchFixtureResultPage(snapshot, args, budgetBytes) };
    });
  },
});
