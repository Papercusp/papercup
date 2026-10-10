/** Private owned-loop ports. Reuse the projected dispatcher and the pinned
 * customer command transport; this source composition does not enable routes.
 * Model admission remains a separate authenticated, host-owned factory. */
import { posix } from 'node:path';
import { dispatchProjectedTool, lookupByMcpName, type DispatchProjectedDeps,
  type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import type { ModelPort, ModelRequest } from '../agent-loop/model-port';
import { capabilityToolset, type ToolDispatcher, type DispatchResult } from '../agent-loop/capability-toolset';
import { createOperatorOwnedLoopPort, type OperatorOwnedLoopPortOptions } from '../agent-loop/headless-invoke';
import type { HostedWorkspaceHostSessionAdapter, HostedCustomerOperatorHttpHandler } from './hosted-session-host';
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

/** Prepare the existing native chat turn door on the VM's PRIVATE relay path.
 * Production does not install this callback until model/budget and customer OS
 * acceptance exists; the public/default HTTP native guard remains in force.
 * The route adapter owns prompt/persistence semantics and receives a port bound
 * to this exact request. JSON/header/account labels cannot create that port. */
export function createHostedCustomerChannelHttpHandler(
  deps: Omit<HostedCustomerLoopPortDependencies, 'resolvePrincipal' | 'sessionHeaders' | 'signal'> & {
    readonly workspaceId: string;
    readonly flushTelemetry?: OperatorOwnedLoopPortOptions['flushTelemetry'];
    readonly handleNativeRequest: (request: Request,
      port: ReturnType<typeof createOperatorOwnedLoopPort>) => Promise<Response>;
  },
): HostedCustomerOperatorHttpHandler {
  const { handleNativeRequest, ...ports } = { ...deps };
  return async (request, { sessionHost, channelId }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || !/^\/api\/harness\/[^/]+\/agent-chats\/[^/]+\/messages$/.test(path)) return undefined;
    let body: unknown;
    try { body = await request.clone().json(); } catch { return undefined; }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || (body as Record<string, unknown>).engine !== 'loop') return undefined;
    try {
      // Capture request lifetime before constructing a reusable invocation port.
      // Even a caller omitting invoke.signal remains bound to this request.
      const signal = sessionHost.customerInvocationSignal(channelId, request.signal);
      if (signal.aborted) throw new Error('hosted_customer_execution_denied');
      const requestHost: typeof sessionHost = Object.freeze({
        customerInvocationSignal: (id, callerSignal) => {
          if (id !== channelId || signal.aborted) throw new Error('hosted_customer_execution_denied');
          return sessionHost.customerInvocationSignal(id,
            callerSignal ? AbortSignal.any([signal, callerSignal]) : signal);
        },
        resolveCustomerPrincipal: (id, callerSignal) => {
          if (id !== channelId || signal.aborted) return Promise.resolve({ ok: false });
          return sessionHost.resolveCustomerPrincipal(id,
            callerSignal ? AbortSignal.any([signal, callerSignal]) : signal);
        },
      });
      const port = createHostedCustomerChannelOwnedLoopPort({ ...ports, sessionHost: requestHost, channelId });
      const response = await awaitHostedCustomerOperation(() => handleNativeRequest(request, port), signal);
      if (!(response instanceof Response)) throw new Error('hosted_customer_execution_denied');
      return response;
    } catch {
      return Response.json({ error: 'hosted_native_loop_unavailable' }, { status: 403 });
    }
  };
}

/** Compose the existing one-shot native host on the customer VM. The local
 * workspace pin is distinct from the control-plane customer-workspace id.
 * No route installs this factory until independent acceptance is available. */
export function createHostedCustomerChannelOwnedLoopPort(
  deps: Omit<HostedCustomerLoopPortDependencies, 'resolvePrincipal' | 'sessionHeaders' | 'signal'> & {
    readonly workspaceId: string;
    readonly sessionHost: Pick<HostedWorkspaceHostSessionAdapter,
      'resolveCustomerPrincipal' | 'customerInvocationSignal'>;
    readonly channelId: string;
    readonly flushTelemetry?: OperatorOwnedLoopPortOptions['flushTelemetry'];
  },
): ReturnType<typeof createOperatorOwnedLoopPort> {
  const { workspaceId, sessionHost, channelId, flushTelemetry, ...ports } = { ...deps };
  return createOperatorOwnedLoopPort({ ...(flushTelemetry ? { flushTelemetry } : {}),
    customerExecution: { workspaceId, projectDir: ports.projectDir,
      async bind(callerSignal) {
        const signal = sessionHost.customerInvocationSignal(channelId, callerSignal);
        if (signal.aborted) throw new Error('hosted_customer_execution_denied');
        const bound = await bindHostedCustomerChannelLoopPorts({ ...ports, sessionHost, channelId, signal });
        const lookup = ports.lookupTool ?? lookupByMcpName;
        const tools = capabilityToolset({ dispatch: bound.dispatch, names: bound.toolNames, prefixes: [],
          registry: () => bound.toolNames.map(name => lookup(name)).filter((tool): tool is ProjectedTool => !!tool) });
        return { modelPort: bound.modelPort, tools, signal };
      },
    },
  });
}

/** Compose privately on the customer VM. The host channel owns authentication;
 * request headers/account labels supply no authority. Route guard stays in place
 * until real customer process/model/current-build acceptance is available. */
export function bindHostedCustomerChannelLoopPorts(
  deps: Omit<HostedCustomerLoopPortDependencies, 'resolvePrincipal' | 'sessionHeaders'> & {
    readonly sessionHost: Pick<HostedWorkspaceHostSessionAdapter, 'resolveCustomerPrincipal'>;
    readonly channelId: string;
  },
): ReturnType<typeof bindHostedCustomerLoopPorts> {
  const { sessionHost, channelId, ...ports } = deps;
  return bindHostedCustomerLoopPorts({ ...ports, sessionHeaders: new Headers(),
    resolvePrincipal: () => sessionHost.resolveCustomerPrincipal(channelId, ports.signal) });
}
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
  if (!(signal instanceof AbortSignal)) throw new Error('hosted_customer_execution_denied');
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
        () => Promise.resolve(createModelPort(session, streamSignal)), streamSignal); }
      catch { throw new Error('hosted_customer_model_unavailable'); }
      await command.authorize(streamSignal);
      if (typeof port?.stream !== 'function') throw new Error('hosted_customer_model_unavailable');
      yield* port.stream({ ...request, signal: streamSignal, ownerId: session.userId });
    },
  } };
}
