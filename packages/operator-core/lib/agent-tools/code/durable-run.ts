import type { UnifiedToolContext, ToolResult } from '@papercusp/tooldef';
import type { OrchestrationSourceArgs } from '../orchestration/public-contract';

interface DurableCodeArgs {
  script?: string;
  title?: string;
  description?: string;
  inputs?: Record<string, unknown>;
  work_item_id?: string;
  execution?: { lifecycle: 'background'; durability: 'durable'; timeoutSec?: number };
  durableRun?: OrchestrationSourceArgs['durableRun'];
  durableControl?: OrchestrationSourceArgs['durableControl'];
  kernel?: unknown;
  timeoutSec?: number;
  dryRun?: boolean;
}

interface DurableCodeDeps {
  inspect: typeof import('../orchestration/inspect').inspectOrchestration;
  run: typeof import('../orchestration/run').runOrchestration;
}

const reply = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

/** A convenience door over the existing pinned DBOS workflow, never another executor/store. */
export async function runDurableCode(
  args: DurableCodeArgs,
  ctx: UnifiedToolContext,
  injected?: DurableCodeDeps,
): Promise<ToolResult> {
  const selectors = Number(Boolean(args.script)) + Number(Boolean(args.durableRun)) + Number(Boolean(args.durableControl));
  if (selectors !== 1 || args.kernel || args.timeoutSec !== undefined || args.dryRun ||
      (args.execution && !args.script) || (args.script && !args.execution)) {
    return reply({ ok: false, executed: false, error: 'durable_execution_args_invalid',
      message: 'Pass script with execution, or exactly one durableRun/durableControl. Omit kernel, dryRun and foreground timeoutSec; set execution.timeoutSec for the durable deadline.' });
  }
  // Lazy imports avoid the foreground adapter's code:run dependency cycle.
  const deps = injected ?? {
    inspect: (await import('../orchestration/inspect')).inspectOrchestration,
    run: (await import('../orchestration/run')).runOrchestration,
  };
  if (args.durableRun) {
    const result = await deps.inspect({ durableRun: args.durableRun }, ctx);
    return reply((result as ToolResult & { data?: unknown }).data);
  }
  if (args.durableControl) return deps.run({ durableControl: args.durableControl }, ctx);

  const request: OrchestrationSourceArgs = {
    script: { source: args.script!, title: args.title, description: args.description,
      ...(args.inputs && Object.keys(args.inputs).length ? { bindingSchema: {
        version: 1,
        properties: Object.fromEntries(Object.keys(args.inputs).map(key => [key,
          { type: 'json', required: true, lifetime: { kind: 'stable' } } ])),
        additionalProperties: false,
      } } : {}),
    },
    execution: { lifecycle: 'background', durability: 'durable' },
    timeoutSec: args.execution!.timeoutSec,
    ...(args.inputs ? { bindings: { values: args.inputs } } : {}),
    ...(args.work_item_id ? { workItemId: args.work_item_id } : {}),
  };
  const inspected = await deps.inspect(request, ctx);
  const data = (inspected as ToolResult & { data?: {
    ok?: boolean;
    normalized?: { durability?: { pin?: OrchestrationSourceArgs['inspectionPin'] } };
  } }).data;
  if (!data?.ok || !data.normalized?.durability?.pin) {
    return reply(data ?? { ok: false, executed: false, error: 'durable_inspection_failed' });
  }
  // The exact immutable source/bindings inspected above are admitted under the same caller.
  // The existing adapter rechecks the pin and replay hazards before enqueuing one workflow.
  return deps.run({ ...request, inspectionPin: data.normalized.durability.pin }, ctx);
}
