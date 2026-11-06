/** Installer binding for the existing dispatcher and restricted supervisor.
 * No registry/store: the packaging owner supplies the exact approved runtime.
 */
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { invokeApprovedHandler, type PreparedHandlerRuntime } from '@papercusp/plugin-loader/daemon';
import type { PluginHandlerExecutor } from './plugin-invocation-policy';

export function createConfinedPluginInvoker(options: {
  runtime: PreparedHandlerRuntime;
  pluginName: string;
  installation: NonNullable<Parameters<PluginHandlerExecutor>[0]['tool']['pluginInstallation']>;
  tools: readonly string[];
  /** Narrow capability-checked service closures built from the HOST request. */
  effects?: (request: Parameters<PluginHandlerExecutor>[0]) => Readonly<Record<string,
    (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>>>;
}): PluginHandlerExecutor {
  const { runtime, pluginName, effects } = options;
  const installation = Object.freeze({ ...options.installation });
  const tools = new Set(options.tools);
  return async request => {
    const selected = request.tool.pluginInstallation;
    if (request.tool.pluginName !== pluginName || !selected || selected.version !== installation.version
      || selected.path !== installation.path || selected.source !== installation.source || !tools.has(request.toolName)) {
      throw new Error('confined handler installation binding mismatch');
    }
    const services = Object.freeze({ ...effects?.(request) });
    const result = CallToolResultSchema.parse(await invokeApprovedHandler({ runtime, toolName: request.toolName, input: request.input,
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
