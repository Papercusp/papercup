/** PUI's attached-engine branch of the shared launch-su door. */
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { getChat } from './agent-chats-data';
import { getAdvSession, markAdvSessionEnded, setAdvSessionPid } from './adv-sessions';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import { nativeSessionHandleForAdvSession } from './native-session-handles';
import { getRegisteredSuSessionHost } from './su-session-host';
import { bindSuSessionToAdvSession, persistSuSessionDescriptor, readDurableSuSession } from './su-session-persistence';
import { startClaudeSuEngine, type ClaudeSuEngine } from './su-session-claude-engine';
import { activeWorkspaceId } from './workspace-registry';

const state = pinModuleState('@papercusp/operator-core.su-attached-launch', () => ({
  starting: new Map<string, Promise<Record<string, unknown>>>(),
  engines: new Map<string, ClaudeSuEngine>(),
}));

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
  if (input.agent !== 'claude') {
    return Response.json({ status: 'error', code: 'attached_engine_unavailable', error: `The ${input.agent} engine does not yet support PUI's structured connection. Choose Claude.` }, { status: 409 });
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
    const previous = await readDurableSuSession({ workspaceId, agentChatId: input.agent_chat_id });
    if (previous) {
      if (previous.backend !== input.agent || previous.harnessSlug !== input.harness_slug) throw new Error('The conversation is already bound to a different engine or project');
      const host = getRegisteredSuSessionHost({ workspaceId, harnessSlug: input.harness_slug, agentChatId: input.agent_chat_id });
      const snapshot = host?.snapshot();
      if (!snapshot?.executorAttached || !snapshot.streamReady || snapshot.terminal || snapshot.descriptor.lifecycle === 'starting') {
        throw new Error('This conversation already has a saved session. Reconnect that session before sending another turn.');
      }
      const row = await getAdvSession(previous.advSessionId);
      return { status: 'ok', attached: true, duplicate: true, transport: 'structured',
        advSessionId: previous.advSessionId, ownerId: previous.ownerId, workspaceId,
        harnessSlug: previous.harnessSlug, agent: previous.backend,
        nativeSession: row ? nativeSessionHandleForAdvSession(row) : null };
    }
    const { bootstrapSu } = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
    // Preserve the request's authenticated principal. Bootstrap remains the one
    // authority for persona, scope, account, mode, membership and native identity.
    const response = await bootstrapSu.handler(new Request(request.url, {
      method: 'POST', headers: request.headers,
      body: JSON.stringify({ ...input, workspace: workspaceId, owner_id: `su-${randomUUID()}`,
        bootstrap_idempotency_key: `pui:${workspaceId}:${input.agent_chat_id}`,
        headless: true, auto: input.mode === 'auto', mode: input.mode === 'auto' ? null : input.mode,
      }),
    }), undefined as never);
    const result = await response.json() as BootstrapSuResult & { error?: string };
    if (!response.ok || result.status !== 'ok') throw new Error(result.error ?? 'SU bootstrap failed');
    if (!result.sessionId || !result.nativeSessionId || !result.envelopeEnv.PAPERCUSP_SID || !result.envelopeEnv.CLAUDE_CONFIG_DIR) {
      if (result.sessionId) await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw new Error('SU bootstrap did not supply a complete Claude identity and configuration');
    }
    let engine: ClaudeSuEngine | undefined;
    try {
      const binding: PuiSuSessionBinding & { backend: 'claude' } = {
        operation: 'created', backend: 'claude', advSessionId: result.sessionId,
        ownerId: result.envelopeEnv.PAPERCUSP_SID, workspaceId: result.workspaceId,
        harnessSlug: result.harnessSlug, planSlug: result.planSlug, nativeSession: null,
      };
      const nativeSession = {
        backend: 'claude' as const, source: 'adv_sessions' as const, ownerId: binding.ownerId,
        sessionId: result.nativeSessionId, configDir: result.envelopeEnv.CLAUDE_CONFIG_DIR,
        configDirSource: 'live-process' as const, configDirUnresolvedReason: null,
        exactResumeSupported: true as const, missingReason: null,
      };
      binding.nativeSession = nativeSession;
      const bound = await bindSuSessionToAdvSession({ workspaceId, advSessionId: result.sessionId, agentChatId: input.agent_chat_id });
      if (bound.status !== 'bound' && bound.status !== 'already_bound') throw new Error('Could not bind the SU session to this conversation');
      engine = startClaudeSuEngine(result, binding, { nativeSession, transcriptPath: null }, {
        agentChatId: input.agent_chat_id, model: input.model, accountRoute: input.account,
        carry: input.carry ?? 'warm', modes: input.mode ? [input.mode] : [],
      });
      state.engines.set(key, engine);
      await engine.ready;
      await setAdvSessionPid(result.sessionId, engine.pid(), 'pui-structured-claude');
      await persistSuSessionDescriptor(result.sessionId, engine.adapter.host.descriptor());
      const active = engine;
      void engine.done.then(async () => {
        if (state.engines.get(key) === active) state.engines.delete(key);
        await markAdvSessionEnded(result.sessionId!, null, 'cleanup');
      }).catch((error: unknown) => console.warn('[su-session] engine exit bookkeeping failed', error));
      return { status: 'ok', transport: 'structured', agent: 'claude', advSessionId: binding.advSessionId,
        ownerId: binding.ownerId, workspaceId: binding.workspaceId, harnessSlug: binding.harnessSlug,
        planSlug: binding.planSlug, nativeSession, ready: true };
    } catch (error) {
      await engine?.close();
      state.engines.delete(key);
      await markAdvSessionEnded(result.sessionId, null, 'cleanup');
      throw error;
    }
  }
}
