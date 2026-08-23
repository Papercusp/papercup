/**
 * P-012 / D-012 acceptance fixture.
 *
 * There is no client partition or hybrid DAG here: one server-side recipe script
 * composes the operator-owned background-job and interactive-PTY capability
 * families, carries their durable task handles between calls, and returns one
 * P-006 envelope. The capability handlers are fixtures, but every call still
 * crosses tooldef's real projected dispatcher and the production current-caller
 * rebinding wrapper.
 */
import { describe, expect, it, vi } from 'vitest';
import { runToolOrchestration, type UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool, ToolResult, WrapDispatch } from '@papercusp/tooldef';
import { bindCurrentCallerDispatch } from './current-caller-dispatch';
import { currentCallerRecipeCatalog, inspectScriptContract } from './contract-preflight';
import { runServerScriptAdapter } from './run';

const json = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

function fixtureTool(
  name: string,
  effect: 'read' | 'write',
  handler: (args: Record<string, unknown>, ctx: UnifiedToolContext) => Promise<ToolResult> | ToolResult,
): ProjectedTool {
  return {
    pluginName: 'p012-fixture',
    description: name,
    inputSchema: { type: 'object' },
    capabilities: [],
    effect,
    expose: { mcp: { name } },
    fn: handler,
  } as unknown as ProjectedTool;
}

function testContext(signal = new AbortController().signal): UnifiedToolContext {
  return {
    log: vi.fn(),
    signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'ws-p012',
    harnessSlug: 'papercusp',
    role: 'su',
    isSuperuser: true,
    runId: 'run-p012',
    uiClientId: 'su-p012',
    // Keep the production wrapper on its ordinary same-workspace fast path;
    // nested handlers must receive this exact live caller transaction.
    tx: { fixture: 'current-caller-tx' } as never,
  } as unknown as UnifiedToolContext;
}

function textEnvelope(result: ToolResult): Record<string, unknown> {
  const item = result.content.find((content) => content.type === 'text');
  if (!item || item.type !== 'text') throw new Error('missing text envelope');
  return JSON.parse(item.text) as Record<string, unknown>;
}

describe('P-012 server-side mixed capability scripts', () => {
  it('passes background and PTY task handles through one script and returns one P-006 envelope', async () => {
    const backgroundTaskId = 'task-bash-p012';
    const ptyTaskId = 'task-pty-p012';
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const handlerContexts: UnifiedToolContext[] = [];

    const record = (
      name: string,
      result: (args: Record<string, unknown>) => ToolResult,
    ): ((args: Record<string, unknown>, ctx: UnifiedToolContext) => ToolResult) =>
      (args, ctx) => {
        dispatched.push({ name, args });
        handlerContexts.push(ctx);
        return result(args);
      };

    const tools: ProjectedTool[] = [
      fixtureTool(
        'capability:bash',
        'write',
        record('capability:bash', () =>
          json({ ok: true, task_id: backgroundTaskId, status: 'running' }),
        ),
      ),
      fixtureTool(
        'capability:bash_output',
        'read',
        record('capability:bash_output', () =>
          json({ ok: true, task_id: backgroundTaskId, status: 'running', output: 'BG_READY' }),
        ),
      ),
      fixtureTool(
        'capability:bash_kill',
        'write',
        record('capability:bash_kill', () =>
          json({ ok: true, task_id: backgroundTaskId, status: 'killed' }),
        ),
      ),
      fixtureTool(
        'capability:pty_open',
        'write',
        record('capability:pty_open', () => json({ ok: true, task_id: ptyTaskId, status: 'running' })),
      ),
      fixtureTool(
        'capability:pty_write_stdin',
        'write',
        record('capability:pty_write_stdin', () => json({ ok: true, task_id: ptyTaskId, written: 9 })),
      ),
      fixtureTool(
        'capability:pty_read_screen',
        'read',
        record('capability:pty_read_screen', () => ({
          content: [
            {
              type: 'pty',
              task_id: ptyTaskId,
              mimeType: 'application/x-papercusp-pty-screen+ansi',
              encoding: 'utf-8',
              cols: 80,
              rows: 24,
              data: 'PTY_READY',
            } as never,
          ],
        })),
      ),
      fixtureTool(
        'capability:pty_kill',
        'write',
        record('capability:pty_kill', () => json({ ok: true, task_id: ptyTaskId, killed: true })),
      ),
    ];

    const wrapperCalls: string[] = [];
    const wrapDispatch: WrapDispatch = async (tool, name, args, ctx, next) => {
      wrapperCalls.push(name);
      return bindCurrentCallerDispatch(tool, name, args, ctx, next);
    };
    const ctx = testContext();
    const allowed = new Set(
      tools.map((tool) => tool.expose.mcp?.name).filter((name): name is string => !!name),
    );

    const result = await runServerScriptAdapter(
      {
        script: {
          source: `
            const background = await tools.capability.bash({
              command: 'printf BG_READY; sleep 30',
              run_in_background: true
            });
            const backgroundRead = await tools.capability.bashOutput({ task_id: background.task_id });
            const pty = await tools.capability.ptyOpen({ command: 'bash' });
            await tools.capability.ptyWriteStdin({ task_id: pty.task_id, data: 'PTY_READY' });
            const screen = await tools.capability.ptyReadScreen({ task_id: pty.task_id });
            await tools.capability.ptyKill({ task_id: pty.task_id });
            await tools.capability.bashKill({ task_id: background.task_id });
            return {
              background_task: background.task_id,
              background_status: backgroundRead.status,
              pty_task: pty.task_id,
              screen_seen: screen.content[0].data.includes('PTY_READY'),
              cleaned_up: true
            };
          `,
        },
        capture: { mode: 'never' },
        execution: { mode: 'server' },
      },
      ctx,
      {
        runCode: async (args, runCtx) => {
          const core = await runToolOrchestration(args.script, {
            ctx: runCtx,
            deps: {},
            tools,
            allowed,
            wrapDispatch,
          });
          return json(core);
        },
        inspectScript: (input) => inspectScriptContract({
          ...input,
          surface: {
            tools,
            allowed,
            catalog: currentCallerRecipeCatalog(tools, allowed),
          },
        }),
      },
    );

    const envelope = textEnvelope(result);
    expect(envelope).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'complete',
      content: [],
      metrics: {
        backend: 'server',
        executionMode: 'server',
        toolCalls: 8,
        childFailureCount: 0,
      },
    });
    expect(JSON.parse(String(envelope.summary))).toEqual({
      background_task: backgroundTaskId,
      background_status: 'running',
      pty_task: ptyTaskId,
      screen_seen: true,
      cleaned_up: true,
    });
    expect(wrapperCalls).toEqual([
      'capability:bash',
      'capability:bash_output',
      'capability:pty_open',
      'capability:pty_write_stdin',
      'capability:pty_read_screen',
      'capability:pty_kill',
      'capability:bash_kill',
    ]);
    expect(dispatched.map(({ name }) => name)).toEqual(wrapperCalls);
    expect(dispatched.find(({ name }) => name === 'capability:bash_output')?.args).toEqual({
      task_id: backgroundTaskId,
    });
    expect(dispatched.find(({ name }) => name === 'capability:pty_write_stdin')?.args).toMatchObject({
      task_id: ptyTaskId,
    });
    expect(dispatched.find(({ name }) => name === 'capability:pty_kill')?.args).toEqual({
      task_id: ptyTaskId,
    });
    expect(handlerContexts).toHaveLength(7);
    for (const handlerCtx of handlerContexts) {
      expect(handlerCtx.tx).toBe(ctx.tx);
      // runToolOrchestration and dispatch-stack each own cancellation layers;
      // handlers receive a derived per-dispatch signal, never the caller's
      // parent object. The cancellation case below proves propagation.
      expect(handlerCtx.signal).not.toBe(ctx.signal);
      expect(handlerCtx.signal.aborted).toBe(false);
      expect(handlerCtx.codeMode).toBe(true);
      expect(handlerCtx.transportCapExempt).toBe(true);
      expect(handlerCtx.contextTier).toBeUndefined();
    }
  });

  it('propagates parent cancellation into an in-flight capability call', async () => {
    const parent = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let childSignal: AbortSignal | undefined;
    const wrapperCalls: string[] = [];
    const wrapDispatch: WrapDispatch = async (tool, name, args, ctx, next) => {
      wrapperCalls.push(name);
      return bindCurrentCallerDispatch(tool, name, args, ctx, next);
    };
    const blockingBash = fixtureTool('capability:bash', 'write', async (_args, ctx) => {
      childSignal = ctx.signal;
      markStarted();
      return await new Promise<ToolResult>((_resolve, reject) => {
        if (ctx.signal.aborted) {
          reject(new Error('parent_cancelled'));
          return;
        }
        ctx.signal.addEventListener('abort', () => reject(new Error('parent_cancelled')), { once: true });
      });
    });

    const run = runToolOrchestration(
      `await tools.capability.bash({ command: 'long foreground command' }); return 'unreachable';`,
      {
        ctx: testContext(parent.signal),
        deps: {},
        tools: [blockingBash],
        allowed: new Set(['capability:bash']),
        wrapDispatch,
        timeoutMs: 2_000,
      },
    );

    await started;
    parent.abort();
    const result = await run;

    expect(childSignal?.aborted).toBe(true);
    expect(wrapperCalls).toEqual(['capability:bash']);
    expect(result).toMatchObject({
      ok: false,
      dispatchCount: 1,
      // The handler observes the aborted signal immediately; dispatch-stack
      // deliberately normalizes that cancellation into its public timeout
      // error instead of leaking a handler-specific rejection string.
      error: expect.stringContaining('tool capability:bash failed [timeout]'),
      uncertainMutations: [
        expect.objectContaining({
          tool: 'capability:bash',
          error: expect.stringContaining('tool capability:bash failed [timeout]'),
        }),
      ],
    });
  });
});
