/** Installer binding for the existing dispatcher and restricted supervisor.
 * No registry/store: the packaging owner supplies the exact approved runtime.
 */
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { invokeApprovedHandler, prepareInstalledHandlerRuntime,
  type HandlerRuntimeFile, type PreparedHandlerRuntime } from '@papercusp/plugin-loader/daemon';
import type { PluginHandlerExecutor } from './plugin-invocation-policy';

export function createConfinedPluginInvoker(options: {
  runtime: PreparedHandlerRuntime;
  pluginName: string;
  installation: NonNullable<Parameters<PluginHandlerExecutor>[0]['tool']['pluginInstallation']>;
  /** Wire-name -> manifest-local SDK handler. Arrays retain the raw guest API. */
  tools: readonly string[] | Readonly<Record<string, string>>;
  /** Narrow capability-checked service closures built from the HOST request. */
  effects?: (request: Parameters<PluginHandlerExecutor>[0]) => Readonly<Record<string,
    (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>>>;
}): PluginHandlerExecutor {
  const { runtime, pluginName, effects } = options;
  const installation = Object.freeze({ ...options.installation });
  const tools = new Map(Array.isArray(options.tools) ? options.tools.map(name => [name, name] as const)
    : Object.entries(options.tools));
  if (!tools.size || [...tools].some(([name, local]) => !name || typeof local !== 'string' || !local)) {
    throw new Error('invalid confined tool mapping');
  }
  return async request => {
    const selected = request.tool.pluginInstallation;
    if (request.tool.pluginName !== pluginName || !selected || selected.version !== installation.version
      || selected.path !== installation.path || selected.source !== installation.source || !tools.has(request.toolName)) {
      throw new Error('confined handler installation binding mismatch');
    }
    const ctx = request.ctx;
    // Pin data and callback references before any guest/trust await. Never
    // spread ctx: it holds principals, credentials and host service closures.
    const metadata = Object.freeze({ workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug,
      projectDir: ctx.projectDir, stateDir: ctx.stateDir, role: ctx.role,
      featureId: ctx.featureId ?? null, chunkId: ctx.chunkId ?? null,
      runId: ctx.runId, spawnId: ctx.spawnId, parentSpawnId: ctx.parentSpawnId ?? null });
    const { progress, emit, log } = ctx;
    const services: Readonly<Record<string, (input: unknown, signal: AbortSignal) => unknown>> = Object.freeze({ ...effects?.(request),
      'sdk.context': () => metadata,
      'sdk.progress': (input: unknown) => {
        const value = input as { pct?: unknown; msg?: unknown } | null;
        if (!value || (value.pct !== undefined && (typeof value.pct !== 'number' || !Number.isFinite(value.pct)))
          || (value.msg !== undefined && typeof value.msg !== 'string')) throw new Error('invalid SDK progress');
        progress(value.pct as number | undefined, value.msg as string | undefined); return null;
      },
      'sdk.emit': (input: unknown) => {
        const value = input as { name?: unknown; data?: unknown } | null;
        if (!value || typeof value.name !== 'string' || !value.name.length) throw new Error('invalid SDK event');
        emit(value.name, value.data); return null;
      },
      'sdk.log': (input: unknown) => {
        const value = input as { msg?: unknown } | null;
        if (!value || typeof value.msg !== 'string') throw new Error('invalid SDK log');
        log(value.msg); return null;
      },
    });
    const result = CallToolResultSchema.parse(await invokeApprovedHandler({ runtime, toolName: tools.get(request.toolName)!, input: request.input,
      signal: request.ctx.signal, effect: (operation, input, signal) => {
        if (!Object.hasOwn(services, operation) || typeof services[operation] !== 'function') throw new Error('handler service is not exposed');
        return services[operation]!(input, signal);
      } }));
    // The tooldef wire supports this MCP content subset. Reject other kinds
    // rather than asserting that an arbitrary guest reply is a tool result.
    if (result.content.some(block => !['text', 'image', 'resource'].includes(block.type))) throw new Error('unsupported handler result content');
    return result as Awaited<ReturnType<PluginHandlerExecutor>>;
  };
}

/** Trusted installer/boot binding. Admission rebuilds the authenticated source
 * closure and verifies installed receipts; the supervisor rechecks protected
 * current trust at each spawn. Neither paths nor approvals come from a tool
 * request. The caller still supplies the installation's untrusted guest bundle.
 */
export async function createInstalledConfinedPluginInvoker(options:
  Omit<Parameters<typeof createConfinedPluginInvoker>[0], 'runtime'> & {
    runtimeDirectory: string;
    handlerFiles: readonly HandlerRuntimeFile[];
  }): Promise<PluginHandlerExecutor> {
  // Pin BEFORE the lazy compiler import or signature IO: a caller mutation
  // during admission must not bind an approved runtime to another installation.
  const { runtimeDirectory, pluginName, effects } = options;
  const installation = { ...options.installation };
  const tools = Array.isArray(options.tools) ? [...options.tools] : { ...options.tools };
  // Apply the runtime builder's ceilings BEFORE allocating any guest copies.
  // Its later validation cannot protect this earlier admission snapshot.
  if (!Array.isArray(options.handlerFiles) || !options.handlerFiles.length || options.handlerFiles.length > 1023) {
    throw new Error('invalid handler snapshot population');
  }
  let total = 0;
  for (const file of options.handlerFiles) {
    if (!(file?.contents instanceof Uint8Array) || file.contents.byteLength > 256 * 1024 * 1024
      || (total += file.contents.byteLength) > 512 * 1024 * 1024) throw new Error('handler snapshot size exceeded');
  }
  const handlerFiles = options.handlerFiles.map(file => {
    return { path: file.path, sha256: file.sha256, executable: file.executable, contents: Buffer.from(file.contents) };
  });
  const runtime = await prepareInstalledHandlerRuntime(runtimeDirectory, handlerFiles);
  return createConfinedPluginInvoker({ runtime, pluginName, installation, tools, effects });
}
