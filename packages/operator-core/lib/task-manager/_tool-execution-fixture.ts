/**
 * The shared DBOS execution-contract fixture for tool-execution.integration.test.ts and
 * tool-execution-timers.test.ts. There is ONE copy on purpose. Both suites read a single
 * operation's result, so the operation-v0 negotiation below must not drift between two
 * copies (EI-29237190348736021 was exactly that drift: a fixture that omitted it read the
 * batch-v1 envelope as a single-operation result). Each importer must still declare
 * `vi.mock('../dbos/bootstrap')` itself, because a vi.mock call is scoped to its test file.
 */
import { vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool, dispatchProjectedTool, lookupByMcpName,
  type ToolExecutionRequest, type UnifiedToolContext,
} from '@papercusp/tooldef';
import {
  startDurableOrchestration, bindDurableOrchestrationExecution, DURABLE_ORCHESTRATION_EXECUTION_ADAPTER,
  type DurableOrchestrationClient, type DurableOrchestrationInput, type DurableOrchestrationOutcome,
} from '../dbos/durable-orchestration-workflow';

/** The existing request-side DBOS client boundary. Records survive dispatcher/module recreation. */
export function durableFixture(options: {
  terminal?: boolean; persist?: boolean; requestBound?: boolean; settleAfterMs?: number;
  yieldReplacement?: boolean; yieldAfterMs?: number; liveInteraction?: boolean;
} = {}) {
  const records = new Map<string, { status: string; input?: [DurableOrchestrationInput]; output?: DurableOrchestrationOutcome; error?: unknown }>();
  const outcome: DurableOrchestrationOutcome = { status: 'succeeded', summary: 'original business result', steps: [] };
  const enqueue = vi.fn<DurableOrchestrationClient['enqueue']>(async (admission, input) => {
    if (options.persist !== false) records.set(admission.workflowID, {
      status: options.terminal ? 'SUCCESS' : 'PENDING', input: [structuredClone(input)],
      ...(options.terminal ? { output: structuredClone(outcome) } : {}),
    });
    if (options.settleAfterMs !== undefined) setTimeout(() => {
      const row = records.get(admission.workflowID)!;
      row.status = 'SUCCESS'; row.output = structuredClone(outcome);
    }, options.settleAfterMs);
    return { workflowID: admission.workflowID };
  });
  const client: DurableOrchestrationClient = { enqueue,
    getWorkflow: async handle => records.get(handle), listWorkflowSteps: async () => [],
    cancelWorkflow: async () => {}, send: async () => {},
  };
  const deps = { client: async () => client };
  const handler = vi.fn(async (_args: { value: number }, ctx: UnifiedToolContext) => {
    const admitted = await startDurableOrchestration({ runKey: 'original-operation', script: 'return 7',
      caller: { ownerId: ctx.uiClientId!, workspaceId: ctx.workspaceId!, role: ctx.role!,
        ...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),
        ...(ctx.principal ? { principal: { kind: ctx.principal.kind, slug: ctx.principal.slug,
          workspaceId: ctx.principal.workspaceId } } : {}),
      },
      pin: { sourceSha256: 'original-source', bindingsSha256: 'original-bindings' }, timeoutSec: 60,
    }, deps);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ durableRun: admitted }) }],
      structuredContent: admitted };
  });
  const definition = defineTool({ name: 'execution_contract:dbos_probe', description: 'Existing DBOS contract fixture',
    capability: 'tasks:read', requirePrincipal: false, agentRoles: ['operator'],
    args: z.object({ value: z.number() }), handler,
    ...(options.requestBound ? { execution: { liveInteraction: options.liveInteraction === true } } : { execution: { lifecycle: 'independent' as const,
      adapter: DURABLE_ORCHESTRATION_EXECUTION_ADAPTER } }),
  });
  const tool = lookupByMcpName(definition.name)!;
  const dispatch = (request: ToolExecutionRequest = {}, extra: Partial<UnifiedToolContext> = {},
    dispatcher = dispatchProjectedTool) => dispatcher(tool, definition.name, { value: 7 }, {
      log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
      workspaceId: 'p003-runtime', role: 'operator', uiClientId: 'original-owner',
      toolExecution: request, executionDeadlineAtMs: Date.now() + 60000,
      transportResponseDeadlineAtMs: Date.now() + 55000, ...extra,
    // These assertions read ONE operation's result. Canonical dispatch defaults to the
    // batch-v1 envelope, so negotiate operation-v0 exactly as PROJECTED_DEPS does.
    }, { batchResponseVersion: 'operation-v0', executionAdapter: request => {
      const bound = bindDurableOrchestrationExecution(request, deps);
      if (options.yieldAfterMs !== undefined) return { ...bound,
        dispatch: selection => bound.dispatch({ ...selection, autoYieldAfterMs: options.yieldAfterMs! }),
      };
      if (!options.yieldReplacement) return bound;
      // Single injected defect: yielding creates a replacement DBOS job.
      return { ...bound, dispatch: async selection => {
        const admitted = await bound.dispatch(selection);
        const original = records.get(admitted.admission.handle)!.input![0];
        await startDurableOrchestration({ ...original, runKey: 'replacement-operation' }, deps);
        return admitted;
      } };
    } });
  return { records, outcome, enqueue, handler, tool, dispatch, deps };
}
