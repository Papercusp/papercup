/** Trusted guest entry. Bundle as CJS with the bridge and seccomp implementation;
 * the installer pins the resulting bytes and their native/runtime dependencies.
 * Never import this entry in the host. No handler-controlled import precedes
 * the final all-thread restriction transition.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin, ToolContext } from '@papercusp/plugin-sdk';
import { establishHandlerProcessRestrictions } from './handler-seccomp';
import { JsonRpcBridge, type JsonRpcRequestHandler } from './jsonrpc-bridge';

const receipt = establishHandlerProcessRestrictions();
const { sha256 } = JSON.parse(readFileSync('/runtime/identity.json', 'utf8')) as { sha256: string };
if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid sealed handler identity');
const bridge = new JsonRpcBridge(process.stdin, process.stdout);
const requireEntry = createRequire('/runtime/bootstrap.cjs');
let initialized = false;
bridge.onRequest('papercup.handlerInitialize', async params => {
  const input = params as { sha256?: unknown; nonce?: unknown } | null;
  if (initialized || input?.sha256 !== sha256 || typeof input?.nonce !== 'string'
    || !/^[a-f0-9-]{36}$/.test(input.nonce)) throw new Error('handler initialization identity mismatch');
  initialized = true;
  try {
    // This is the FIRST handler/dependency-controlled executable byte.
    const loaded = requireEntry('/handler/entry.cjs');
    const entry = (loaded.default ?? loaded) as {
      requests?: Record<string, JsonRpcRequestHandler>;
      tools?: Plugin['tools'];
      invokeTool?: (name: string, input: unknown, context: {
        effect(operation: string, input: unknown): Promise<unknown>;
      }) => unknown | Promise<unknown>;
    };
    if ((!entry.requests || typeof entry.requests !== 'object') && typeof entry.invokeTool !== 'function'
      && (!entry.tools || typeof entry.tools !== 'object')) {
      throw new Error('handler requests missing');
    }
    for (const [method, handler] of Object.entries(entry.requests ?? {})) {
      if (['papercup.handlerInitialize', 'papercup.handlerInvoke', 'papercup.ping'].includes(method)
        || typeof handler !== 'function') throw new Error('invalid handler request');
      bridge.onRequest(method, handler);
    }
    if (typeof entry.invokeTool === 'function' || entry.tools) {
      const invoke = entry.invokeTool;
      let invoked = false;
      bridge.onRequest('papercup.handlerInvoke', async params => {
        const call = params as { invocationId?: unknown; toolName?: unknown; input?: unknown } | null;
        if (invoked || typeof call?.invocationId !== 'string' || !/^[a-f0-9-]{36}$/.test(call.invocationId)
          || typeof call.toolName !== 'string' || !call.toolName.length) throw new Error('invalid handler invocation');
        invoked = true;
        const invocationId = call.invocationId;
        const effects = Object.freeze({
          effect: (operation: string, input: unknown) => bridge.call('papercup.handlerEffect', { invocationId, operation, input }),
        });
        if (invoke) return invoke(call.toolName, call.input, effects);
        // Only the host binding translates wire names to manifest-local keys.
        if (!entry.tools || !Object.hasOwn(entry.tools, call.toolName)
          || typeof entry.tools[call.toolName] !== 'function') throw new Error('SDK tool handler missing');
        const metadata = await effects.effect('sdk.context', null) as Record<string, unknown>;
        const strings = ['workspaceId', 'harnessSlug', 'projectDir', 'stateDir', 'role', 'runId', 'spawnId'] as const;
        const nullable = ['featureId', 'chunkId', 'parentSpawnId'] as const;
        if (!metadata || strings.some(key => typeof metadata[key] !== 'string')
          || nullable.some(key => metadata[key] !== null && typeof metadata[key] !== 'string')) {
          throw new Error('invalid SDK invocation context');
        }
        const data = Object.fromEntries([...strings, ...nullable].map(key => [key, metadata[key]])) as
          Pick<ToolContext, typeof strings[number] | typeof nullable[number]>;
        // Void callbacks still receive acknowledgement before tool settlement.
        const pending = new Set<Promise<unknown>>();
        let failure: unknown, failed = false, active = true;
        const notify = (operation: string, input: unknown) => {
          if (!active || pending.size >= 1024) throw new Error('SDK callback unavailable');
          const task = effects.effect(operation, input).catch(error => { failed = true; failure = error; })
            .finally(() => pending.delete(task));
          pending.add(task);
        };
        const ctx: ToolContext = Object.freeze({ ...data, signal: new AbortController().signal,
          progress: (pct: number | undefined, msg?: string) => notify('sdk.progress', { pct, msg }),
          emit: (name: string, data: unknown) => notify('sdk.emit', { name, data }),
          log: (msg: string) => notify('sdk.log', { msg }),
          spawn: ((bin, args, opts) => effects.effect('sdk.spawn', { bin, args, opts })) as ToolContext['spawn'],
          secret: ((name: string) => effects.effect('sdk.secret', { name })) as ToolContext['secret'],
        });
        try {
          const result = await entry.tools[call.toolName]!(call.input, ctx);
          active = false;
          await Promise.all([...pending]);
          if (failed) throw failure;
          return result;
        } finally { active = false; await Promise.all([...pending]); }
      });
    }
    bridge.onRequest('papercup.ping', () => ({ ok: true }));
    return { sha256, nonce: input.nonce, receipt };
  } catch (error) {
    // A partially loaded entry never becomes admissible. Exit the PID namespace.
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
    throw error;
  }
});
