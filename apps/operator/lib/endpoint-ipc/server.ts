/**
 * Operator host binding for `@papercusp/ipc-endpoint-server`.
 *
 * The IPC server itself — wire protocol, dispatch loop, sys:http bridge —
 * is the generic, host-agnostic `@papercusp/ipc-endpoint-server` package
 * (extracted per papercusp-systems-abstraction-2026-05-29, P-030). This
 * file is the thin Papercusp-operator adapter: it supplies the `host`
 * seam (projected-tool lookup + dispatch from the operator's registry,
 * plus the active workspace id) and re-exports a host-bound
 * `startEndpointIpcServer` so existing call sites (the boot site in
 * instrumentation-node.ts and dev_ipc_echo_e2e.test.ts) pass exactly the
 * options they always did — no `host` at the call site.
 *
 * Resolving lookup/dispatch from `@papercusp/agent-mcp` (which re-exports
 * the @papercusp/tooldef engine) is what guarantees the IPC server reads
 * the SAME projected-tool registry singleton that `@/lib/agent-tools`
 * populates at boot. See `apps/operator/lib/endpoint-ipc/PROTOCOL.md` for
 * the wire spec and trust model.
 */

import {
  startEndpointIpcServer as startEndpointIpcServerCore,
  defaultSocketPath,
  type EndpointIpcServer,
  type IpcEndpointHost,
  type StartEndpointIpcServerOptions as CoreStartEndpointIpcServerOptions,
} from '@papercusp/ipc-endpoint-server';
import {
  lookupByMcpName,
  dispatchProjectedToolStream,
} from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '@/lib/workspace-registry';

/** The Papercusp-operator host binding for the generic IPC server. */
const operatorHost: IpcEndpointHost = {
  lookupByMcpName,
  dispatchProjectedToolStream,
  getWorkspaceId: () => activeWorkspaceId(),
};

/**
 * Operator-facing options — the generic options minus `host`, which the
 * adapter injects. Lets callers pass `{ socketPath, deps, allowedTools,
 * logger }` exactly as before the extraction.
 */
export type StartEndpointIpcServerOptions = Omit<
  CoreStartEndpointIpcServerOptions,
  'host'
>;

export { defaultSocketPath };
export type { EndpointIpcServer };

/**
 * Start the endpoint IPC server bound to the operator host. Thin wrapper
 * over `@papercusp/ipc-endpoint-server` that injects the operator's
 * registry lookup/dispatch + active-workspace resolution.
 */
export function startEndpointIpcServer(
  options: StartEndpointIpcServerOptions = {},
): Promise<EndpointIpcServer> {
  return startEndpointIpcServerCore({ ...options, host: operatorHost });
}
