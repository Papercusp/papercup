/** PUI's attached-engine branch of the shared launch-su door. */
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { getChat } from './agent-chats-data';
import { getAdvSession, markAdvSessionEnded, setAdvSessionPid } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { nativeSessionHandleForAdvSession } from './native-session-handles';
import { getRegisteredSuSessionHost, rehydrateRegisteredSuSessionHost, type SuSessionHost } from './su-session-host';
import { bindSuSessionToAdvSession, persistSuSessionDescriptor, readDurableSuSession } from './su-session-persistence';
import { startClaudeSuEngine, type ClaudeSuEngine } from './su-session-claude-engine';
import type { ClaudeSuRuntimeBinding } from './su-session-claude-adapter';
import { startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';
import type { NativeSessionHandle } from './native-session-handles';
import { activeWorkspaceId } from './workspace-registry';
import { prepareStructuredSuResume } from './su-session-resume';
import { resolveCodexModelSelection } from './model-context-budget.mjs';
import { normalizeModelSpecForAgent } from '../../../apps/operator/scripts/psu-launcher.mjs';

const state = pinModuleState('@papercusp/operator-core.su-attached-launch', () => ({
  starting: new Map<string, Promise<Record<string, unknown>>>(),
  engines: new Map<string, ClaudeSuEngine | SuRpcEngine>(),
  // Each engine's exit bookkeeping (close + ended mark); its engine entry is
  // cleared only when this settles.
  exits: new Map<string, Promise<void>>(),
}));

function trackExit(key: string, exit: Promise<void>): void {
  state.exits.set(key, exit);
  void exit.finally(() => { if (state.exits.get(key) === exit) state.exits.delete(key); });
}

/** True once `key`'s previous engine has finished exiting, waiting at most `ms`. */
async function previousEngineExited(key: string, ms: number): Promise<boolean> {
  const exit = state.exits.get(key);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (exit) await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
  return !state.engines.has(key);
}

// PUI sessions use native approval prompts on both creation and recovery.
// Manual/auto mode is a separate agent policy, never a permission bypass.

export interface AttachedSuLaunchInput {
  agent: string;
  agent_chat_id: string;
  harness_slug: string;
  plan_slug?: string | null;
  account: string;
  carry?: 'warm' | 'cold';
  model?: string | null;
  mode?: string | null;
  context_size?: string;
  compaction_limit?: number | null;
  fleet?: string | null;
  seat?: string | null;
  launch_context?: string | null;
}

export async function launchAttachedSuSession(request: Request, input: AttachedSuLaunchInput): Promise<Response> {
  if (!['claude', 'codex', 'omp'].includes(input.agent)) {
    return Response.json({ status: 'error', code: 'attached_engine_unavailable', error: `The ${input.agent} engine does not support PUI's structured connection.` }, { status: 409 });
  }
  const workspaceId = activeWorkspaceId();
  const key = `${workspaceId}:${input.harness_slug}:${input.agent_chat_id}`;
  let start = state.starting.get(key);
  if (!start) {
    start = create();
    state.starting.set(key, start);
    void start.finally(() => { if (state.starting.get(key) === start) state.starting.delete(key); }).catch(() => undefined);
  }
  try { return Response.json(await start); }
  catch (error) {
    return Response.json({ status: 'error', code: 'attached_engine_start_failed', error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }

  async function create(): Promise<Record<string, unknown>> {
    const chat = await getChat({ slug: input.harness_slug, chatId: input.agent_chat_id });
    if (!chat.ok) throw new Error(chat.error);
    if (chat.data.archived_at) throw new Error('This conversation is archived; restore it before connecting');
    if (chat.data.su_runtime_class !== 'su-session') throw new Error('This conversation is not classified as an SU session; its existing history was preserved');
    const previous = await readDurableSuSession({ workspaceId, agentChatId: input.agent_chat_id });
    if (previous) {
      if (previous.backend !== input.agent || previous.harnessSlug !== input.harness_slug) throw new Error('The conversation is already bound to a different engine or project');
      const host = getRegisteredSuSessionHost({ workspaceId, harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
      const snapshot = host?.snapshot();
      const initializing = state.engines.has(key) && snapshot?.descriptor.lifecycle === 'starting';
      if (!snapshot || snapshot.terminal || (!initializing && (!snapshot.executorAttached || !snapshot.streamReady))) {
        // A dead engine's exit bookkeeping can still be running when the
        // owner's recovery send arrives; wait for it rather than refuse.
        if (state.engines.has(key) && !await previousEngineExited(key, 10_000)) {
          throw new Error('The previous native process is still closing; reconnect after it exits');
        }
        const restored = host ?? await rehydrateRegisteredSuSessionHost({ workspaceId,
          harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
        if (!restored) throw new Error('Reconnect requires the saved session descriptor');
        const resume = await prepareStructuredSuResume(previous);
        let active: ClaudeSuEngine | SuRpcEngine | undefined;
        try {
          const options = { ...resume.options, host: restored, beforeReady: resume.beforeReady,
            onExit: resume.onExit, toolApproval: 'prompt' as const };
          active = previous.backend === 'claude'
            ? startClaudeSuEngine(resume.boot, resume.binding as PuiSuSessionBinding & { backend: 'claude' },
              { nativeSession: resume.nativeSession as ClaudeSuRuntimeBinding['nativeSession'], transcriptPath: null },
              { ...options, host: restored as SuSessionHost<'claude'>, resume: resume.exact })
            : startSuRpcEngine(resume.boot, resume.binding as PuiSuSessionBinding & { backend: 'codex' | 'omp' },
              { ...options, nativeSession: resume.nativeSession as Extract<NativeSessionHandle, { backend: 'codex' | 'omp' }> });
          state.engines.set(key, active);
          await persistSuSessionDescriptor(previous.advSessionId, active.adapter.host.descriptor());
        } catch (error) { await active?.close(); await resume.release(); throw error; }
        const resumed = active;
        trackExit(key, (async () => {
          try { await resumed.ready; await resumed.done; }
          catch (error) {
            if (!resumed.adapter.host.snapshot().terminal) resumed.adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
            await resumed.close();
            await resume.release();
          } finally { if (state.engines.get(key) === resumed) state.engines.delete(key); }
        })().catch((error: unknown) => console.warn('[su-session] resume bookkeeping failed', error)));
        return { status: 'ok', attached: true, resumed: true, transport: 'structured', ready: false,
          advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
          harnessSlug: previous.harnessSlug, planSlug: resume.binding.planSlug, agent: previous.backend,
          nativeSession: resume.nativeSession };
      }
      const row = await getAdvSession(previous.advSessionId);
      const existingEngine = state.engines.get(key);
      return { status: 'ok', attached: true, duplicate: true, transport: 'structured',
        ready: !initializing,
        advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
        harnessSlug: previous.harnessSlug, agent: previous.backend,
        nativeSession: existingEngine && 'nativeSession' in existingEngine ? existingEngine.nativeSession()
          : row ? nativeSessionHandleForAdvSession(row) : null };
    }
    const { bootstrapSu } = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
    // PUI owns the visible model picker. Its "server default" choice has the
    // same authority as the PSU picker, even though the native engine has no
    // terminal. Preserve that choice through the headless bootstrap boundary.
    const codexSelection = input.agent === 'codex'
      ? resolveCodexModelSelection(input.model, { source: input.model?.trim() ? 'explicit' : 'configured-default' })
      : null;
    // A fresh PUI launch bypasses psu's CLI argument normalization. Apply the
    // same Claude window marker before both bootstrap's saved launch spec and
    // the structured SDK receive this model; exact resume already normalizes
    // its saved model in prepareStructuredSuResume. Without this, bare sonnet
    // opens a 200k local Claude window and can reject a native-question
    // continuation before its next gateway request (WI-10003087).
    const selectedModel = input.agent === 'claude'
      ? normalizeModelSpecForAgent('claude', input.model)
      : codexSelection?.model ?? input.model;
    // Preserve the request's authenticated principal. Bootstrap remains the one
    // authority for persona, scope, account, mode, membership and native identity.
    const response = await bootstrapSu.handler(new Request(request.url, {
      method: 'POST', headers: request.headers,
      body: JSON.stringify({ ...input, workspace: workspaceId, owner_id: `su-${randomUUID()}`,
        model: selectedModel, ...(codexSelection ? { model_source: codexSelection.source } : {}),
        bootstrap_idempotency_key: `pui:${workspaceId}:${input.agent_chat_id}`,
        headless: true, auto: input.mode === 'auto', mode: input.mode === 'auto' ? null : input.mode,
      }),
    }), undefined as never);
    const result = await response.json() as BootstrapSuResult & { error?: string };
    if (!response.ok || result.status !== 'ok') throw new Error(result.error ?? 'SU bootstrap failed');
    if (!result.sessionId || !result.envelopeEnv.PAPERCUSP_SID
      || result.agent !== input.agent
      || (result.agent === 'claude' && (!result.nativeSessionId || !result.envelopeEnv.CLAUDE_CONFIG_DIR))) {
      if (result.sessionId) await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw new Error('SU bootstrap did not supply a matching identity and configuration');
    }
    let engine: ClaudeSuEngine | SuRpcEngine | undefined;
    try {
      const binding: PuiSuSessionBinding = {
        operation: 'created', backend: result.agent, advSessionId: result.sessionId,
        ownerId: result.envelopeEnv.PAPERCUSP_SID, workspaceId: result.workspaceId,
        harnessSlug: result.harnessSlug, planSlug: result.planSlug, nativeSession: null,
      };
      const nativeSession: NativeSessionHandle | null = result.agent === 'claude' ? {
        backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: binding.ownerId,
        sessionId: result.nativeSessionId, configDir: result.envelopeEnv.CLAUDE_CONFIG_DIR,
        configDirSource: 'live-process' as const, configDirUnresolvedReason: null,
        exactResumeSupported: true as const, missingReason: null,
      } : null;
      binding.nativeSession = nativeSession;
      const bound = await bindSuSessionToAdvSession({ workspaceId, advSessionId: result.sessionId, agentChatId: input.agent_chat_id });
      if (bound.status !== 'bound' && bound.status !== 'already_bound') throw new Error('Could not bind the SU session to this conversation');
      const options = {
        agentChatId: input.agent_chat_id, model: selectedModel, accountRoute: input.account,
        carry: input.carry ?? 'warm', modes: input.mode ? [input.mode] : [],
        onExit: async () => { await markAdvSessionEnded(result.sessionId!, null, 'cleanup', { throwOnError: true }); },
        toolApproval: 'prompt' as const,
      };
      engine = result.agent === 'claude'
        ? startClaudeSuEngine(result, binding as PuiSuSessionBinding & { backend: 'claude' },
          { nativeSession: nativeSession as ClaudeSuRuntimeBinding['nativeSession'], transcriptPath: null }, options)
        : startSuRpcEngine(result, binding as PuiSuSessionBinding & { backend: 'codex' | 'omp' }, options);
      state.engines.set(key, engine);
      await persistSuSessionDescriptor(result.sessionId, engine.adapter.host.descriptor());
      const active = engine;
      // Launch publishes the durable identity; the existing host stream owns
      // bounded readiness and failure. Waiting here couples native startup to
      // the HTTP route's shorter watchdog and discards a valid launch as 408.
      trackExit(key, (async () => {
        try {
          await active.ready;
          await setAdvSessionPid(result.sessionId!, active.pid(), `pui-structured-${result.agent}`);
          await persistSuSessionDescriptor(result.sessionId!, active.adapter.host.descriptor());
          // done is initialized when the SDK actually starts. Reading it
          // before ready can observe the engine's pre-start placeholder.
          await active.done;
        } catch (error) {
          if (!active.adapter.host.snapshot().terminal) {
            active.adapter.reconcileRuntimeExit({ expected: false, reason: String(error) });
          }
          await active.close();
          await markAdvSessionEnded(result.sessionId!, null, 'cleanup', { throwOnError: true });
        } finally {
          if (state.engines.get(key) === active) state.engines.delete(key);
        }
      })().catch((error: unknown) => console.warn('[su-session] engine exit bookkeeping failed', error)));
      return { status: 'ok', transport: 'structured', agent: result.agent, advSessionId: binding.advSessionId,
        ownerId: binding.ownerId, workspaceId: binding.workspaceId, harnessSlug: binding.harnessSlug,
        planSlug: binding.planSlug, nativeSession, ready: false };
    } catch (error) {
      await engine?.close();
      state.engines.delete(key);
      await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw error;
    }
  }
}
