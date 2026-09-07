/** Structured Claude transport for the existing SU host. No PTY or native pane.
 * The maintained Agent SDK owns framing, streaming input and control requests;
 * Papercusp owns SU bootstrap, process enrollment and the session's lifecycle.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyDefaultClaudeAuthSettingsArgs, applyDefaultClaudeOAuthToken, applyGithubTokenEnv, assertLaunchPersona, enforceDefaultClaudeAccount, persistDefaultClaudeAuthSettings, recordSessionOwner, sanitizeInheritedEnv, startSupervisorBeat, suLaunchArgs } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { splitModelSpec } from './agent-config-constants';
import { resolveSpawnHostOperatorBaseUrl } from './mcp-base-url';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { createClaudeSuSessionAdapter, type ClaudeNativeCommandVerdict, type ClaudeSuSessionAdapter, type ClaudeSuSessionDescriptorOptions, type ClaudeSuRuntimeBinding } from './su-session-claude-adapter';
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from './task-manager/enroll-sync';
import { probeScopeSupport } from './task-manager/managed-spawn';
import { killTask } from './task-manager/control';
import type { TaskSpec } from './task-manager/types';

export type ClaudeEngineQuery = AsyncIterable<SDKMessage> & Pick<Query, 'initializationResult' | 'mcpServerStatus' | 'interrupt' | 'close'>;
export interface ClaudeEngineOptions extends ClaudeSuSessionDescriptorOptions {
  startupTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  /** Inject the protocol peer in tests, not the host or its event translation. */
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeEngineQuery;
  register?: boolean;
  /** Join the authoritative session-end write before reporting closed. */
  onExit?: () => Promise<void>;
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
  // Readiness uses the SDK's actual control responses. A transcript-only
  // shouldQuery:false append does not promise any output receipt or result;
  // using one as a probe deadlocks before the first owner turn. Native event
  // identity remains checked on every frame, including the first system/init.
  let ready = false;
  let closed = false;
  let processId: number | null = null;
  let processTaskId: string | null = null;
  let processRegistration: Promise<void> | null = null;
  let processExit: Promise<void> = Promise.resolve();
  let heartbeat: ManagedHandle | undefined;
  let sdk: ClaudeEngineQuery;
  let inputTail = Promise.resolve();
  let finishActiveTurn: (() => void) | undefined;
  const pending = new Map<string, ReturnType<typeof deferred<ClaudeNativeCommandVerdict>>>();
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 30_000;
  const unavailable = (message: string): ClaudeNativeCommandVerdict => ({
    ok: false, code: 'engine_delivery_unknown', message, retryable: false,
  });
  const adapter = createClaudeSuSessionAdapter(binding, runtime, {
    ...options, ready: false, runtimeReady: () => ready && !closed, ownerTurnCorrelation: 'transport',
    controls: {
      async ownerTurn({ content, turnId }) {
        if (!ready || closed) return unavailable('The structured Claude connection is not ready');
        const uuid = randomUUID();
        const receipt = deferred<ClaudeNativeCommandVerdict>();
        pending.set(uuid, receipt);
        let timer: ReturnType<typeof setTimeout> | undefined;
        inputTail = inputTail.then(async () => {
          if (closed) { receipt.resolve(unavailable('Claude closed before this saved turn was sent')); return; }
          const finished = deferred<void>();
          finishActiveTurn = () => finished.resolve();
          adapter.correlateOwnerTurn(turnId);
          timer = setTimeout(() => receipt.resolve(unavailable('Claude did not acknowledge this saved turn; reconcile delivery before retrying')), deliveryTimeoutMs);
          input.write({ type: 'user', uuid, session_id: nativeId, parent_tool_use_id: null,
            origin: { kind: 'human' }, message: { role: 'user', content } } satisfies SDKUserMessage);
          await finished.promise;
          finishActiveTurn = undefined;
        }).catch((error: unknown) => receipt.resolve(unavailable(String(error))));
        try {
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
  const env = { ...sanitizeInheritedEnv(process.env), ...boot.envelopeEnv };
  delete env.PAPERCUSP_TTY;
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.PAPERCUSP_OPERATOR_URL = resolveSpawnHostOperatorBaseUrl();
  enforceDefaultClaudeAccount('claude', env);
  applyDefaultClaudeOAuthToken('claude', env);
  const authSettings = applyDefaultClaudeAuthSettingsArgs('claude', [], env);
  // The on-disk per-session settings are also used on native exact resume.
  if (!options.query) {
    persistDefaultClaudeAuthSettings({ wrapperBin: 'claude', env });
    applyGithubTokenEnv(env);
    recordSessionOwner(nativeId, binding.ownerId, { advSessionId: binding.advSessionId });
  }
  // Reuse the launcher's deny policy as well as its environment sanitizer.
  const disallowedTools = launch.args.filter((a: string) => a.startsWith('--disallowedTools=')).flatMap((a: string) => a.slice('--disallowedTools='.length).split(','));
  const sdkOptions: Options = {
    cwd: boot.cwd,
    env,
    ...(authSettings[0] === '--settings' ? { settings: JSON.parse(authSettings[1]) } : {}),
    sessionId: nativeId,
    settingSources: ['user', 'project', 'local'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools,
    ...(model.model ? { model: model.model } : {}),
    ...(model.effort ? { effort: model.effort as Options['effort'] } : {}),
    abortController,
    extraArgs: { 'system-prompt-file': boot.promptFile, 'exclude-dynamic-system-prompt-sections': null, 'replay-user-messages': null },
    spawnClaudeCodeProcess(spawnOptions) {
      const spec: TaskSpec = {
        class: 'agent-session', title: 'PUI Claude structured engine', launchedBy: 'pui-su-session',
        sessionId: nativeId, harnessSlug: binding.harnessSlug, planSlug: binding.planSlug,
        detail: { coordOwnerId: binding.ownerId, advSessionId: binding.advSessionId, transport: 'structured' },
        argv: [spawnOptions.command, ...spawnOptions.args], cwd: boot.cwd,
      };
      const enrollment = beginSyncEnrolment(spec);
      processTaskId = enrollment.taskId;
      const wrapped = enrollment.wrap(spawnOptions.command, spawnOptions.args, spawnOptions.env, boot.cwd);
      const child = spawn(wrapped.binary, wrapped.argv, {
        cwd: boot.cwd, env: spawnOptions.env, stdio: ['pipe', 'pipe', 'pipe'], signal: spawnOptions.signal,
      });
      processId = child.pid ?? null;
      completeSyncEnrolment(enrollment, spec, processId, { workspaceId: boot.workspaceId });
      processRegistration = enrollment.registrationReady;
      const exited = deferred<void>();
      processExit = exited.promise;
      if (processId) startSupervisorBeat(binding.ownerId, {
        pid: processId, operatorUrl: env.PAPERCUSP_OPERATOR_URL,
        onTerminalSession: () => { void close().catch((error) => console.warn('[su-session] terminal engine cleanup failed', error)); },
        setIntervalImpl: (callback: () => void, ms: number) => {
          heartbeat = managedSetInterval('su-session-engine-heartbeat', ms, callback, { category: 'liveness', instanced: true });
          return {};
        },
      });
      // Consume stderr so a noisy child cannot deadlock its protocol pipes.
      // SDK result/error messages carry the user-facing reason, never raw env.
      child.stderr.on('data', () => undefined);
      child.once('close', (exitCode, signal) => {
        heartbeat?.stop();
        wrapped.release?.();
        finishSyncEnrolment(enrollment, { state: signal ? 'killed' : 'exited', exitCode, exitReason: signal });
        exited.resolve();
      });
      return child;
    },
  };
  let done: Promise<void> = Promise.resolve();
  async function waitForExit(ms: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([processExit.then(() => true), new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), ms); })]);
    } finally { clearTimeout(timeout!); }
  }
  async function stopChild(): Promise<void> {
    if (await waitForExit(5_000)) return;
    await processRegistration;
    if (!processTaskId) throw new Error('Claude child did not close and has no tracked teardown handle');
    const result = await killTask(processTaskId, { signal: 'SIGKILL', includeSubtree: true, reapTerminalResidue: true });
    if (!result.ok && result.error !== 'already_gone') throw new Error(`Claude tracked teardown failed: ${result.error}`);
    if (!(await waitForExit(5_000))) throw new Error('Claude child did not exit after tracked teardown');
  }
  async function close(): Promise<void> {
    if (!closed) {
      closed = true; ready = false;
      heartbeat?.stop();
      for (const receipt of pending.values()) receipt.resolve(unavailable('Claude connection closed before acknowledgement'));
      finishActiveTurn?.();
      input.end(); sdk?.close(); abortController.abort();
    }
    await done;
    await stopChild();
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
          if (event.type === 'system' && event.subtype === 'init'
            && (event.session_id !== nativeId || resolve(event.cwd) !== resolve(boot.cwd))) {
            throw new Error('Claude startup identity or project does not match');
          }
          if (event.type === 'user' && event.uuid) pending.get(event.uuid)?.resolve({ ok: true });
          adapter.ingestNativeLine(JSON.stringify(event));
          if (event.type === 'result') finishActiveTurn?.();
        }
        if (!closed) throw new Error('Claude event stream closed unexpectedly');
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (!closed) {
          adapter.host.emit({ type: 'error', scope: 'transport', code: 'claude_stream_failed', message: cause.message, recoverable: true });
          adapter.reconcileRuntimeExit({ expected: false, reason: cause.message });
          closed = true; ready = false; input.end(); sdk.close(); abortController.abort();
        }
      } finally {
        for (const receipt of pending.values()) receipt.resolve(unavailable('Claude stream ended before acknowledgement'));
        finishActiveTurn?.();
        if (closed && !adapter.host.snapshot().terminal) adapter.reconcileRuntimeExit({ expected: true });
        if (closed) {
          await stopChild();
          await options.onExit?.();
        }
      }
    })();
    await sdk.initializationResult();
    let servers = await sdk.mcpServerStatus();
    let suServer = servers.find((server) => server.name === 'papercusp-su');
    // SDK initialization can finish while an MCP connection is still pending.
    // Keep the host starting within its existing deadline until that handshake
    // settles; failed/missing/unauthenticated connections remain refusals.
    while (suServer && new Set(['pending', 'connecting']).has(suServer.status)) {
      if (closed) throw new Error('Claude connection closed during SU tool initialization');
      await new Promise((resolve) => setTimeout(resolve, 100));
      servers = await sdk.mcpServerStatus();
      suServer = servers.find((server) => server.name === 'papercusp-su');
    }
    if (suServer?.status !== 'connected') {
      throw new Error(`Claude SU tool connection is ${suServer?.status ?? 'missing'}; reconnect the SU tool connection (servers: ${servers.map((server) => `${server.name}:${server.status}`).join(', ') || 'none'})`);
    }
    if (closed) throw new Error('Claude connection closed during startup');
    ready = true;
    adapter.host.transition('ready', 'Claude structured stream, SU tools and command executor attached');
  })();
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
