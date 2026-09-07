/** Structured Claude transport for the existing SU host. No PTY or native pane.
 * The maintained Agent SDK owns framing, streaming input and control requests;
 * Papercusp owns SU bootstrap, process enrollment and the session's lifecycle.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { assertLaunchPersona, sanitizeInheritedEnv, suLaunchArgs } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { splitModelSpec } from './agent-config-constants';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { createClaudeSuSessionAdapter, type ClaudeNativeCommandVerdict, type ClaudeSuSessionAdapter, type ClaudeSuSessionDescriptorOptions, type ClaudeSuRuntimeBinding } from './su-session-claude-adapter';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from './task-manager/enroll-sync';
import { probeScopeSupport } from './task-manager/managed-spawn';
import type { TaskSpec } from './task-manager/types';

export type ClaudeEngineQuery = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'mcpServerStatus' | 'interrupt' | 'close'>;
export interface ClaudeEngineOptions extends ClaudeSuSessionDescriptorOptions {
  startupTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  /** Inject the protocol peer in tests, not the host or its event translation. */
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeEngineQuery;
  register?: boolean;
}
export interface ClaudeSuEngine {
  adapter: ClaudeSuSessionAdapter;
  ready: Promise<void>;
  done: Promise<void>;
  close(): Promise<void>;
  pid(): number | null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function startClaudeSuEngine(
  boot: BootstrapSuResult,
  binding: PuiSuSessionBinding & { backend: 'claude' },
  runtime: ClaudeSuRuntimeBinding,
  options: ClaudeEngineOptions,
): ClaudeSuEngine {
  const nativeId = runtime.nativeSession.sessionId;
  if (boot.agent !== 'claude' || boot.sessionId !== binding.advSessionId || boot.nativeSessionId !== nativeId
    || boot.workspaceId !== binding.workspaceId || boot.harnessSlug !== binding.harnessSlug
    || boot.envelopeEnv.PAPERCUSP_SID !== binding.ownerId) {
    throw new Error('Structured Claude bootstrap does not match the durable SU identity');
  }
  assertLaunchPersona(boot.promptFile);
  const input = new PassThrough({ objectMode: true });
  const abortController = new AbortController();
  const initialized = deferred<void>();
  // The readiness probe is synthetic, transcript-only and never asks the model
  // to run. It makes the CLI emit its actual system/init identity before PUI
  // accepts the first owner turn. A PID/control response alone cannot prove it.
  let probing = true;
  let sawIdentity = false;
  let ready = false;
  let closed = false;
  let processId: number | null = null;
  let sdk: ClaudeEngineQuery;
  const pending = new Map<string, ReturnType<typeof deferred<ClaudeNativeCommandVerdict>>>();
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 30_000;
  const unavailable = (message: string): ClaudeNativeCommandVerdict => ({
    ok: false, code: 'engine_delivery_unknown', message, retryable: false,
  });
  const adapter = createClaudeSuSessionAdapter(binding, runtime, {
    ...options, ready: false,
    controls: {
      async ownerTurn({ content }) {
        if (!ready || closed) return unavailable('The structured Claude connection is not ready');
        const uuid = randomUUID();
        const receipt = deferred<ClaudeNativeCommandVerdict>();
        pending.set(uuid, receipt);
        const timer = setTimeout(() => receipt.resolve(unavailable('Claude did not acknowledge this saved turn; reconcile delivery before retrying')), deliveryTimeoutMs);
        try {
          input.write({ type: 'user', uuid, session_id: nativeId, parent_tool_use_id: null, message: { role: 'user', content } } satisfies SDKUserMessage);
          return await receipt.promise;
        } finally { clearTimeout(timer); pending.delete(uuid); }
      },
      async interrupt() { await sdk.interrupt(); return { ok: true }; },
      async resume() { return ready && !closed ? { ok: true } : unavailable('Reconnect the structured Claude runtime before resuming'); },
      async focus() { return { ok: true }; },
      async end() { await close(); return { ok: true }; },
    },
  });
  const model = splitModelSpec(options.model);
  const launch = suLaunchArgs('claude', { promptFile: boot.promptFile, nativeSessionId: nativeId });
  // Reuse the launcher's deny policy as well as its environment sanitizer.
  const disallowedTools = launch.args.filter((a: string) => a.startsWith('--disallowedTools=')).flatMap((a: string) => a.slice('--disallowedTools='.length).split(','));
  const sdkOptions: Options = {
    cwd: boot.cwd,
    env: { ...sanitizeInheritedEnv(process.env), ...boot.envelopeEnv },
    sessionId: nativeId,
    systemPrompt: readFileSync(boot.promptFile, 'utf8'),
    settingSources: ['user', 'project', 'local'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools,
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort as Options['effort'] } : {}),
    abortController,
    extraArgs: { 'exclude-dynamic-system-prompt-sections': null, 'replay-user-messages': null },
    spawnClaudeCodeProcess(spawnOptions) {
      const spec: TaskSpec = {
        class: 'agent-session', title: 'PUI Claude structured engine', launchedBy: 'pui-su-session',
        sessionId: binding.ownerId, harnessSlug: binding.harnessSlug, planSlug: binding.planSlug,
        argv: [spawnOptions.command, ...spawnOptions.args], cwd: boot.cwd,
      };
      const enrollment = beginSyncEnrolment(spec);
      const wrapped = enrollment.wrap(spawnOptions.command, spawnOptions.args, spawnOptions.env, boot.cwd);
      const child = spawn(wrapped.binary, wrapped.argv, {
        cwd: boot.cwd, env: spawnOptions.env, stdio: ['pipe', 'pipe', 'pipe'], signal: spawnOptions.signal,
      });
      processId = child.pid ?? null;
      completeSyncEnrolment(enrollment, spec, processId, { workspaceId: boot.workspaceId });
      // Consume stderr so a noisy child cannot deadlock its protocol pipes.
      // SDK result/error messages carry the user-facing reason, never raw env.
      child.stderr.on('data', () => undefined);
      child.once('close', (exitCode, signal) => {
        wrapped.release?.();
        finishSyncEnrolment(enrollment, { state: signal ? 'killed' : 'exited', exitCode, exitReason: signal });
      });
      return child;
    },
  };
  let done: Promise<void> = Promise.resolve();
  async function close(): Promise<void> {
    if (!closed) {
      closed = true; ready = false;
      for (const receipt of pending.values()) receipt.resolve(unavailable('Claude connection closed before acknowledgement'));
      input.end(); sdk?.close(); abortController.abort();
    }
    await done;
  }
  const startup = (async () => {
    if (!options.query) await probeScopeSupport();
    if (closed) throw new Error('Claude startup was cancelled');
    sdk = (options.query ?? query)({ prompt: input, options: sdkOptions });
    done = (async () => {
      try {
        for await (const event of sdk) {
          if ('session_id' in event && event.session_id && event.session_id !== nativeId) {
            throw new Error('Claude stream identity differs from the bootstrapped session');
          }
          if (probing) {
            if (event.type === 'system' && event.subtype === 'init') {
              if (event.session_id !== nativeId || resolve(event.cwd) !== resolve(boot.cwd)) throw new Error('Claude startup identity or project does not match');
              sawIdentity = true;
            }
            if (event.type === 'result') {
              if (!sawIdentity || event.is_error) throw new Error('Claude startup did not produce a valid identity handshake');
              probing = false;
              initialized.resolve();
            }
            continue;
          }
          if (event.type === 'user' && event.uuid) pending.get(event.uuid)?.resolve({ ok: true });
          adapter.ingestNativeLine(JSON.stringify(event));
        }
        if (!closed) throw new Error('Claude event stream closed unexpectedly');
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        initialized.reject(cause);
        if (!closed) {
          adapter.host.emit({ type: 'error', scope: 'transport', code: 'claude_stream_failed', message: cause.message, recoverable: true });
          adapter.reconcileRuntimeExit({ expected: false, reason: cause.message });
          closed = true; ready = false; input.end(); sdk.close(); abortController.abort();
        }
      } finally {
        for (const receipt of pending.values()) receipt.resolve(unavailable('Claude stream ended before acknowledgement'));
        if (closed && !adapter.host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: true });
      }
    })();
    await sdk.initializationResult();
    input.write({ type: 'user', uuid: randomUUID(), session_id: nativeId, parent_tool_use_id: null,
      isSynthetic: true, shouldQuery: false,
      message: { role: 'user', content: 'PUI transport connected. This is a synthetic readiness record, not an owner request.' },
    } satisfies SDKUserMessage);
    await initialized.promise;
    const servers = await sdk.mcpServerStatus();
    if (!servers.some((server) => server.name === 'papercusp-su' && server.status === 'connected')) {
      throw new Error('Claude connected without the Papercusp SU tool server; reconnect the SU tool connection');
    }
    if (closed) throw new Error('Claude connection closed during startup');
    ready = true;
    adapter.host.transition('ready', 'Claude structured stream, SU tools and command executor attached');
  })();
  // Attach immediately: an early process error can reject before initialize.
  void initialized.promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout>;
  const readyPromise = Promise.race([
    startup,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Claude startup timed out; reconnect or choose another engine')), options.startupTimeoutMs ?? 45_000); }),
  ]).catch(async (error: unknown) => {
    if (!adapter.host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
    await close();
    throw error;
  }).finally(() => clearTimeout(timer));
  return { adapter, ready: readyPromise, get done() { return done; }, close, pid: () => processId };
}
