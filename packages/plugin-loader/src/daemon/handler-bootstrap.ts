/** Trusted guest entry. Bundle as CJS with the bridge and seccomp implementation;
 * the installer pins the resulting bytes and their native/runtime dependencies.
 * Never import this entry in the host. No handler-controlled import precedes
 * the final all-thread restriction transition.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    const entry = requireEntry('/handler/entry.cjs') as {
      requests?: Record<string, JsonRpcRequestHandler>;
      invokeTool?: (name: string, input: unknown, context: {
        effect(operation: string, input: unknown): Promise<unknown>;
      }) => unknown | Promise<unknown>;
    };
    if ((!entry.requests || typeof entry.requests !== 'object') && typeof entry.invokeTool !== 'function') {
      throw new Error('handler requests missing');
    }
    for (const [method, handler] of Object.entries(entry.requests ?? {})) {
      if (['papercup.handlerInitialize', 'papercup.handlerInvoke', 'papercup.ping'].includes(method)
        || typeof handler !== 'function') throw new Error('invalid handler request');
      bridge.onRequest(method, handler);
    }
    if (typeof entry.invokeTool === 'function') {
      const invoke = entry.invokeTool;
      let invoked = false;
      bridge.onRequest('papercup.handlerInvoke', async params => {
        const call = params as { invocationId?: unknown; toolName?: unknown; input?: unknown } | null;
        if (invoked || typeof call?.invocationId !== 'string' || !/^[a-f0-9-]{36}$/.test(call.invocationId)
          || typeof call.toolName !== 'string' || !call.toolName.length) throw new Error('invalid handler invocation');
        invoked = true;
        const invocationId = call.invocationId;
        return invoke(call.toolName, call.input, Object.freeze({
          effect: (operation: string, input: unknown) => bridge.call('papercup.handlerEffect', { invocationId, operation, input }),
        }));
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
