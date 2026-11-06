/**
 * @papercusp/plugin-loader/daemon — subprocess daemon runtime
 * (Batch I, rev 3 plan).
 *
 * v1 surface:
 *   - startDaemonPlugin(opts) — spawn the daemon under bwrap (Linux),
 *     attach a JSON-RPC bridge over stdio, return a DaemonPluginHandle.
 *
 * The handle exposes the same `callAction` shape as the WASM runtime so
 * downstream code (operator's plugin-host-runtime, agent-mcp tool
 * registration) can treat WASM and daemon plugins uniformly.
 */

export { startDaemonPlugin, invokeApprovedHandler, providerSandboxWorks, probeProviderSandbox, DaemonSandboxUnavailableError } from './supervisor';
export type { ProviderSandboxProbe } from './supervisor';
export type {
  DaemonPluginHandle,
  StartDaemonOptions,
  DaemonRestartPolicy,
} from './supervisor';
export { buildBwrapArgs, buildProviderBwrapArgs, PROVIDER_SYSTEM_RO_DIRS } from './bwrap-args';
export type { ProviderBwrapOptions } from './bwrap-args';
export { JsonRpcBridge, JsonRpcHandlerError } from './jsonrpc-bridge';
export type { JsonRpcRequestHandler } from './jsonrpc-bridge';
// Trusted host/installer surface, never handler manifest input. Qualification
// and complete inventory authorship remain separate from custody preparation.
export { prepareHandlerRuntime, prepareApprovedHandlerRuntime, handlerRuntimeDigest,
  handlerTrustedRuntimeDigest, handlerRuntimeConfigurationDigest, createHandlerRuntimeCandidate,
  createCurrentHandlerRuntimeApproval } from './handler-runtime';
export type { HandlerRuntimeFile, HandlerRuntimeInventory, PreparedHandlerRuntime, HandlerRuntimeApproval,
  HandlerRuntimeBuildIdentity } from './handler-runtime';
export type { HandlerBuildInput, HandlerBuildIdentity } from './handler-runtime-build';
/** Build-host entry only; keep the compiler out of ordinary runtime imports. */
export async function buildAuthenticatedHandlerRuntime(
  ...args: Parameters<typeof import('./handler-runtime-build').buildAuthenticatedHandlerRuntime>
) {
  return (await import('./handler-runtime-build')).buildAuthenticatedHandlerRuntime(...args);
}
export async function prepareInstalledHandlerRuntime(
  ...args: Parameters<typeof import('./handler-runtime-build').prepareInstalledHandlerRuntime>
) {
  return (await import('./handler-runtime-build')).prepareInstalledHandlerRuntime(...args);
}
