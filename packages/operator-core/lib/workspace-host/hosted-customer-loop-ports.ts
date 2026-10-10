/** Private owned-loop ports. Reuse the projected dispatcher and the pinned
 * customer command transport; this source composition does not enable routes.
 * Model admission remains a separate authenticated, host-owned factory. */
import { posix } from 'node:path';
import { dispatchProjectedTool, lookupByMcpName, type DispatchProjectedDeps,
  type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import type { ModelPort, ModelRequest } from '../agent-loop/model-port';
import type { ToolDispatcher, DispatchResult } from '../agent-loop/capability-toolset';
import { awaitHostedCustomerOperation, bindHostedCustomerCommandExecutor, type HostedCustomerCommandDependencies,
  type HostedCustomerSessionBinding } from './hosted-customer-command';

export interface HostedCustomerLoopPortDependencies extends HostedCustomerCommandDependencies {
  /** Real host gating/telemetry deps; the customer override replaces any ambient handler override. */
  readonly dispatchDeps: DispatchProjectedDeps;
  /** Invocation lifetime from the private host, never a JSON tool argument. */
  readonly signal: AbortSignal;
  /** Test registry seam. Production resolves the existing capability:bash definition. */
  readonly lookupTool?: (name: string) => ProjectedTool | undefined;
  /** Required, independently authenticated model/budget host. Never ambient routing. */
  readonly createModelPort: (session: HostedCustomerSessionBinding,
    signal?: AbortSignal) => ModelPort | Promise<ModelPort>;
}

const SHELL_TOOL = 'capability:bash';
const refused = (): DispatchResult => ({ isError: true,
  content: [{ type: 'text', text: 'hosted_customer_tool_unavailable' }] });

export async function bindHostedCustomerLoopPorts(deps: HostedCustomerLoopPortDependencies): Promise<{
  readonly dispatch: ToolDispatcher;
  readonly modelPort: ModelPort;
  readonly toolNames: readonly string[];
}> {
  const command = await bindHostedCustomerCommandExecutor(deps);
  const lookup = deps.lookupTool ?? lookupByMcpName;
  const tool = lookup(SHELL_TOOL);
  // Pin the known command door, not capabilities from an arbitrary installation.
  if (!tool || tool.capabilities.length !== 1 || tool.capabilities[0] !== SHELL_TOOL
    || tool.needsWorkspaceTx) throw new Error('hosted_customer_tool_unavailable');
  const projectDir = deps.projectDir;
  const signal = deps.signal;
  const createModelPort = deps.createModelPort;
  if (typeof createModelPort !== 'function') throw new Error('hosted_customer_model_unavailable');
  const dispatchDeps: DispatchProjectedDeps = { ...deps.dispatchDeps,
    overrideTool: async (name, input, ctx) => {
      // Never PASS_THROUGH to the operator-local handler, even for an unknown door.
      if (name !== SHELL_TOOL || !input || typeof input !== 'object') return refused() as never;
      const args = input as Record<string, unknown>;
      const unsupported = Object.keys(args).some(key =>
        !['command', 'cmd', 'cwd', 'timeout', 'run_in_background'].includes(key));
      if (unsupported || args.run_in_background === true || (args.command && args.cmd && args.command !== args.cmd)) {
        return refused() as never;
      }
      const text = args.command ?? args.cmd;
      if (typeof text !== 'string' || !text.trim()
        || (args.cwd !== undefined && typeof args.cwd !== 'string')) return refused() as never;
      const cwd = typeof args.cwd === 'string' ? posix.resolve(projectDir, args.cwd) : projectDir;
      const result = await command.run({ command: text, cwd, signal: ctx.signal,
        ...(args.timeout === undefined ? {} : { timeoutMs: args.timeout as number }) });
      return { content: [{ type: 'text', text: JSON.stringify({ output: result.stdout,
        stderr: result.stderr, exit_code: result.exitCode, signal: result.signal,
        task_id: result.taskId, task_enrolled: result.taskEnrolled }) }] };
    },
  };
  const dispatch: ToolDispatcher = async (name, input) => {
    if (name !== SHELL_TOOL) return refused();
    // Snapshot untrusted arguments before any asynchronous authorization read.
    let args: Record<string, unknown>;
    try { args = structuredClone(input); } catch { return refused(); }
    const session = await command.authorize(signal);
    const principal = { kind: 'user' as const, slug: session.userId, workspaceId: session.workspaceId,
      authMethod: 'cookie-session' as const, trust: 'verified' as const,
      capabilities: new Set([SHELL_TOOL]), allowedTools: new Set([SHELL_TOOL]) };
    const ctx = { principal, workspaceId: session.workspaceId, role: 'worker',
      projectDir, signal, quotaSubject: `hosted-session:${session.sessionId}`,
      log: () => {}, progress: () => {}, emit: () => {},
      spawn: async () => { throw new Error('hosted_customer_tool_unavailable'); },
      secret: async () => null } as UnifiedToolContext;
    const result = await dispatchProjectedTool(tool, name, args, ctx, dispatchDeps);
    if (!result.ok || !result.result) return { isError: true,
      content: [{ type: 'text', text: result.error?.code ?? 'hosted_customer_tool_unavailable' }] };
    return result.result as DispatchResult;
  };
  return { dispatch, toolNames: Object.freeze([SHELL_TOOL]), modelPort: {
    async *stream(input: ModelRequest) {
      // Account/owner labels from a loop request are not model admission authority.
      const { signal: requestSignal, account: _account, ownerId: _ownerId, ...body } = input;
      const streamSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const request = structuredClone(body);
      const session = await command.authorize(streamSignal);
      let port: ModelPort;
      try { port = await awaitHostedCustomerOperation(
        Promise.resolve().then(() => createModelPort(session, streamSignal)), streamSignal); }
      catch { throw new Error('hosted_customer_model_unavailable'); }
      await command.authorize(streamSignal);
      if (typeof port?.stream !== 'function') throw new Error('hosted_customer_model_unavailable');
      yield* port.stream({ ...request, signal: streamSignal, ownerId: session.userId });
    },
  } };
}
