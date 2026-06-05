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

import os from 'node:os';
import path from 'node:path';
import {
  startEndpointIpcServer as startEndpointIpcServerCore,
  type EndpointIpcServer,
  type IpcEndpointHost,
  type StartEndpointIpcServerOptions as CoreStartEndpointIpcServerOptions,
} from '@papercusp/ipc-endpoint-server';
import {
  lookupByMcpName,
  dispatchProjectedToolStream,
} from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../workspace-registry';
import { readSuperuserToken } from '../superuser-token';

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

export type { EndpointIpcServer };

/**
 * Operator socket path: `~/.papercusp/sockets/<pid>.sock` (Linux/macOS)
 * or `\\.\pipe\papercusp-<pid>` (Windows). The generic package defaults
 * to a neutral tmpdir path; the operator brand lives here so the Rust
 * sidecar bootstrap finds the socket where it expects.
 */
export function defaultSocketPath(pid: number = process.pid): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\papercusp-${pid}`;
  return path.join(os.homedir(), '.papercusp', 'sockets', `${pid}.sock`);
}

/**
 * Start the endpoint IPC server bound to the operator host. Thin wrapper
 * over `@papercusp/ipc-endpoint-server` that injects the operator's
 * registry lookup/dispatch + active-workspace resolution, plus the
 * operator-branded handshake token, socket path, and upstream base — the
 * package itself stays project-agnostic.
 */
export function startEndpointIpcServer(
  options: StartEndpointIpcServerOptions = {},
): Promise<EndpointIpcServer> {
  return startEndpointIpcServerCore({
    ...options,
    host: operatorHost,
    // The Rust client (papercusp-desktop) strips this exact prefix.
    readyToken: options.readyToken ?? 'PAPERCUSP_IPC_READY',
    socketPath: options.socketPath ?? defaultSocketPath(),
    upstreamBaseUrl:
      options.upstreamBaseUrl ??
      process.env.PAPERCUSP_OPERATOR_BASE ??
      `http://127.0.0.1:${process.env.PORT ?? 3055}`,
    // In-boundary credential for the sys:http bridge. The webview rides IPC
    // for same-origin /api/* fetches, but its HttpOnly `papercusp_session`
    // cookie can't ride the bridge (JS can't forward it nor honor Set-Cookie),
    // so cookie-gated admin routes (`auth: { trust: ['verified','trusted'] }`,
    // per the D3 posture) would see only `unverified-loopback` and 403. The
    // webview is the trusted in-boundary shell — the same boundary that lets
    // endpoint_invoke synthesize an `operator` principal (see server.ts) — so
    // we present the operator's own loopback superuser bearer on the bridge's
    // upstream hop. `principalFromSuperuserToken` resolves it to
    // `trust: 'trusted'` (loopback-gated; NOT the `?superuser=1` gate-bypass),
    // which clears the gate while role/quota/capability checks still run.
    // Read per request so a rotated token is picked up without a restart.
    sysHttpInjectHeaders:
      options.sysHttpInjectHeaders ??
      (() => {
        const token = readSuperuserToken();
        return token ? { authorization: `Bearer ${token}` } : undefined;
      }),
  });
}
