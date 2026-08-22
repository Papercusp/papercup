import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { AGENT_ROLES, defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import {
  buildOutputEnvelope,
  DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS,
  type OutputEnvelope,
  type OutputExecutionMetrics,
} from '../../output-envelope';
import { clampForegroundTimeoutMs } from '../capability/foreground-transport-cap';
import codeRunTool, { type CodeRunCaptureMode, withCodeRunCaptureMode } from '../code/run';

const DEFAULT_TIMEOUT_SEC = 30;

const scriptSourceSchema = z
  .object({
    source: z.string().min(1).max(20_000),
    title: z.string().max(120).optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict();

const executionPolicySchema = z
  .object({
    mode: z.enum(['server', 'auto']).optional(),
    lifecycle: z.enum(['foreground', 'background']).optional(),
  })
  .strict();

const capturePolicySchema = z
  .object({
    mode: z.enum(['auto', 'never']).optional(),
    title: z.string().max(120).optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const serverScriptRunArgsSchema = z
  .object({
    script: scriptSourceSchema,
    execution: executionPolicySchema.optional(),
    capture: capturePolicySchema.optional(),
    timeoutSec: z.number().int().min(1).max(120).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export type ServerScriptRunArgs = z.infer<typeof serverScriptRunArgsSchema>;

type TextContent = { type: 'text'; text: string };
type MediaContent =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

type CodeRunToolResult = Omit<ToolResult, 'content'> & {
  content: Array<ToolResult['content'][number] | MediaContent>;
};

type CodeRunPayload = {
  ok?: unknown;
  summary?: unknown;
  error?: unknown;
  partial?: unknown;
  dispatchCount?: unknown;
  intermediateBytes?: unknown;
  plannedMutations?: unknown;
  writeAttempts?: unknown;
  rejectedMutations?: unknown;
  uncertainMutations?: unknown;
  childFailures?: unknown;
  notDispatchedWrites?: unknown;
};

export interface ServerScriptRunDeps {
  runCode: (
    args: {
      script: string;
      title?: string;
      description?: string;
      dryRun?: boolean;
      timeoutSec?: number;
    },
    ctx: UnifiedToolContext,
    captureMode: CodeRunCaptureMode,
  ) => Promise<CodeRunToolResult>;
}

const DEFAULT_DEPS: ServerScriptRunDeps = {
  async runCode(args, ctx, captureMode) {
    return codeRunTool.handler(
      args as never,
      withCodeRunCaptureMode(ctx, captureMode) as never,
    ) as Promise<CodeRunToolResult>;
  },
};

function isTextContent(value: unknown): value is TextContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function isMediaContent(value: unknown): value is MediaContent {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    (item.type === 'image' || item.type === 'audio') &&
    typeof item.data === 'string' &&
    typeof item.mimeType === 'string'
  );
}

function parseCodeRunResult(result: CodeRunToolResult): {
  payload: CodeRunPayload;
  media: MediaContent[];
} {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find(isTextContent);
  if (!text) throw new TypeError('code:run returned no text payload');
  const parsed = JSON.parse(text.text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('code:run returned a non-object payload');
  }
  return {
    payload: parsed as CodeRunPayload,
    media: content.filter(isMediaContent),
  };
}

function authoredSummaryText(value: unknown): string {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value ?? '') : serialized;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function executionMetrics(
  args: ServerScriptRunArgs,
  payload: CodeRunPayload,
  durationMs: number,
  captureMode: CodeRunCaptureMode,
): OutputExecutionMetrics {
  const requestedTimeoutSec = args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const effectiveTimeoutSec = args.timeoutSec
    ? clampForegroundTimeoutMs(args.timeoutSec * 1_000) / 1_000
    : DEFAULT_TIMEOUT_SEC;
  const dispatchCount = finiteNonNegative(payload.dispatchCount) ?? 0;

  return {
    backend: 'server',
    durationMs,
    toolCalls: 1 + dispatchCount,
    intermediateBytes: finiteNonNegative(payload.intermediateBytes) ?? 0,
    requestedTimeoutSec,
    effectiveTimeoutSec,
    requestedExecutionMode: args.execution?.mode ?? 'server',
    executionMode: 'server',
    executionModeDeprecated: args.execution?.mode === 'auto',
    lifecycle: 'foreground',
    captureMode,
    dryRun: args.dryRun ?? false,
    plannedMutationCount: countArray(payload.plannedMutations),
    writeAttemptCount: countArray(payload.writeAttempts),
    rejectedMutationCount: countArray(payload.rejectedMutations),
    uncertainMutationCount: countArray(payload.uncertainMutations),
    childFailureCount: countArray(payload.childFailures),
    notDispatchedWriteCount: countArray(payload.notDispatchedWrites),
  };
}

function executionEnvelope(
  args: ServerScriptRunArgs,
  payload: CodeRunPayload,
  durationMs: number,
  captureMode: CodeRunCaptureMode,
): OutputEnvelope {
  const summary = authoredSummaryText(payload.summary);
  const metrics = executionMetrics(args, payload, durationMs, captureMode);
  if (payload.ok === false) {
    return buildOutputEnvelope({
      summary,
      state: 'error',
      error: {
        code: 'script_execution_failed',
        message: typeof payload.error === 'string' ? payload.error : 'code:run execution failed',
      },
      metrics,
    });
  }
  if (payload.partial === true || countArray(payload.childFailures) > 0) {
    return buildOutputEnvelope({
      summary,
      state: 'incomplete',
      incomplete: { reason: 'partial_execution' },
      metrics,
    });
  }
  return buildOutputEnvelope({ summary, metrics });
}

function preflightError(code: string, message: string, args: ServerScriptRunArgs): ToolResult {
  const envelope = buildOutputEnvelope({
    summary: '',
    state: 'error',
    error: { code, message },
    metrics: {
      backend: 'server',
      phase: 'preflight',
      executed: false,
      requestedExecutionMode: args.execution?.mode ?? 'server',
      lifecycle: args.execution?.lifecycle ?? 'foreground',
    },
  });
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }] } as ToolResult;
}

/** Thin server-script adapter. All execution, repair, timeout, authorization and
 * recipe-capture behavior remains owned by code:run; this layer only maps the
 * public script policy and emits the shared P-006 envelope. */
export async function runServerScriptAdapter(
  args: ServerScriptRunArgs,
  ctx: UnifiedToolContext,
  deps: ServerScriptRunDeps = DEFAULT_DEPS,
): Promise<ToolResult> {
  if (args.execution?.lifecycle === 'background') {
    return preflightError(
      'lifecycle_unavailable',
      'Background orchestration is unavailable; use foreground execution or the task-backed capability surface.',
      args,
    );
  }

  const captureMode = args.capture?.mode ?? 'auto';
  const startedAt = Date.now();
  try {
    const codeResult = await deps.runCode(
      {
        script: args.script.source,
        title: args.capture?.title ?? args.script.title,
        description: args.capture?.description ?? args.script.description,
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
        ...(args.timeoutSec === undefined ? {} : { timeoutSec: args.timeoutSec }),
      },
      ctx,
      captureMode,
    );
    const { payload, media } = parseCodeRunResult(codeResult);
    const durationMs = Math.max(0, Date.now() - startedAt);
    let envelope: OutputEnvelope;
    try {
      envelope = executionEnvelope(args, payload, durationMs, captureMode);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      envelope = buildOutputEnvelope({
        summary: '',
        state: 'error',
        error: {
          code: 'summary_budget_exceeded',
          message:
            `${error.message}; author a bounded summary within ` +
            `${DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS} characters and return bulky evidence through references`,
        },
        metrics: {
          ...executionMetrics(args, payload, durationMs, captureMode),
          phase: 'execution',
          executed: true,
        },
      });
    }

    const serialized = JSON.stringify(envelope);
    ctx.metadata?.({
      backend: 'server',
      returnedContextBytes:
        Buffer.byteLength(serialized, 'utf8') +
        media.reduce((sum, item) => sum + Buffer.byteLength(item.data, 'utf8'), 0),
      failureClass:
        envelope.state === 'complete' ? null : (envelope.error?.code ?? envelope.incomplete?.reason ?? envelope.state),
    });
    return {
      content: [{ type: 'text', text: serialized }, ...media],
    } as unknown as ToolResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildOutputEnvelope({
      summary: '',
      state: 'error',
      error: { code: 'server_adapter_failed', message, retryable: false },
      metrics: {
        backend: 'server',
        phase: 'execution',
        executed: false,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    });
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
    } as ToolResult;
  }
}

const orchestrateRunTool = defineTool({
  name: 'orchestrate:run',
  description:
    'Run a fresh server-side orchestration script through code:run and return one bounded authored-summary envelope. ' +
    'The adapter preserves current-caller authorization, typed signature repair, timeout handling, dry-run previews, media returns, and recipe capture.',
  guidance: {
    when: 'You have a fresh multi-step server orchestration script and need one aggregate-safe output envelope.',
    notWhen: 'You have a saved recipe id; use recipes:run until the saved-recipe adapter is joined into this facade.',
    chaining:
      'orchestrate:run { script:{ source, title?, description? }, execution?:{ mode:"server" }, capture?:{ mode:"auto"|"never" }, timeoutSec? }',
    seeAlso: ['code:run', 'recipes:search', 'recipes:run'],
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: serverScriptRunArgsSchema,
  handler(args, ctx) {
    return runServerScriptAdapter(args, ctx);
  },
});

export default orchestrateRunTool;
