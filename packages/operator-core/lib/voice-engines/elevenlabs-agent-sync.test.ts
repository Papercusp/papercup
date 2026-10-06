/**
 * P-002 (voice-two-tier-elevenlabs-agent-2026-10-06): the ElevenLabs agent
 * sync converges on the definition, creates the agent when the stored id is
 * missing or gone, never duplicates tools, and never leaks the key.
 */
import { describe, expect, it } from 'vitest';
import { ASK_PAPERCUP_TOOL_NAME, VOICE_BRAIN_TIMEOUT_MS } from '@papercusp/chat-protocol';
import {
  ASK_PAPERCUP_TOOL,
  ElevenLabsAgentSyncError,
  PAPERCUP_FRONT_AGENT,
  buildAgentConfig,
  syncElevenLabsAgent,
  type ElevenLabsAgentSyncDeps,
} from './elevenlabs-agent-sync';

const KEY = 'sk_test_secret_key_value_1234';

interface FakeOpts { failToolCreate?: boolean; failAgentPatch?: number }

/** In-memory ElevenLabs ConvAI API covering the endpoints the sync uses. */
function fakeElevenLabs(opts: FakeOpts = {}) {
  const tools = new Map<string, { id: string; tool_config: { name: string } & Record<string, unknown> }>();
  const agents = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; path: string; key: string | null }> = [];
  let seq = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace('/v1/convai', '');
    calls.push({ method, path, key: headers.get('xi-api-key') });
    if (headers.get('xi-api-key') !== KEY) return json(401, { detail: 'invalid key' });
    const body = init?.body ? JSON.parse(String(init.body)) : null;

    if (path === '/tools' && method === 'GET') return json(200, { tools: [...tools.values()] });
    if (path === '/tools' && method === 'POST') {
      if (opts.failToolCreate) return json(500, { detail: 'tool create exploded' });
      const id = `tool_${++seq}`;
      tools.set(id, { id, tool_config: body.tool_config });
      return json(200, { id });
    }
    const toolMatch = path.match(/^\/tools\/(.+)$/);
    if (toolMatch && method === 'PATCH') {
      const t = tools.get(toolMatch[1]!);
      if (!t) return json(404, { detail: 'tool not found' });
      t.tool_config = body.tool_config;
      return json(200, t);
    }
    if (path === '/agents/create' && method === 'POST') {
      const id = `agent_${++seq}`;
      agents.set(id, body);
      return json(200, { agent_id: id });
    }
    const agentMatch = path.match(/^\/agents\/(.+)$/);
    if (agentMatch && method === 'PATCH') {
      if (opts.failAgentPatch) return json(opts.failAgentPatch, { detail: 'agent patch refused' });
      if (!agents.has(agentMatch[1]!)) return json(404, { detail: { status: 'document_not_found' } });
      agents.set(agentMatch[1]!, body);
      return json(200, { agent_id: agentMatch[1] });
    }
    return json(400, { detail: `unhandled ${method} ${path}` });
  }) as typeof fetch;

  return { fetchImpl, tools, agents, calls };
}

function deps(fake: ReturnType<typeof fakeElevenLabs>, initialId: string | null) {
  const store = { id: initialId, writes: 0 };
  const d: ElevenLabsAgentSyncDeps = {
    apiKey: KEY,
    fetch: fake.fetchImpl,
    readAgentId: async () => store.id,
    writeAgentId: async (id) => { store.id = id; store.writes += 1; },
  };
  return { d, store };
}

describe('syncElevenLabsAgent', () => {
  it('creates the tool and the agent when no agent id is stored, and saves the new id', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, null);
    const r = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);

    expect(r.action).toBe('created');
    expect(r.createdBecause).toBe('no-stored-id');
    expect(store.id).toBe(r.agentId);
    expect(store.writes).toBe(1);
    expect(fake.agents.size).toBe(1);
    expect(fake.tools.size).toBe(1);
    const agent = fake.agents.get(r.agentId)! as { conversation_config: { agent: { prompt: { tool_ids: string[]; prompt: string } } } };
    expect(agent.conversation_config.agent.prompt.tool_ids).toEqual([r.toolIds.ask_papercup]);
    expect(agent.conversation_config.agent.prompt.prompt).toContain('ask_papercup');
  });

  it('is idempotent: a second run updates the same agent and tool instead of creating new ones', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, null);
    const first = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);
    const second = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);

    expect(second.action).toBe('updated');
    expect(second.agentId).toBe(first.agentId);
    expect(second.toolIds).toEqual(first.toolIds);
    expect(fake.agents.size).toBe(1);
    expect(fake.tools.size).toBe(1);
    expect(store.writes).toBe(1);
    expect(fake.calls.filter((c) => c.path === '/agents/create')).toHaveLength(1);
  });

  it('creates a replacement agent when the stored id no longer exists (404), and saves the new id', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, 'agent_deleted_long_ago');
    const r = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);

    expect(r.action).toBe('created');
    expect(r.createdBecause).toBe('stored-id-not-found');
    expect(r.agentId).not.toBe('agent_deleted_long_ago');
    expect(store.id).toBe(r.agentId);
  });

  it('does not create a new agent or overwrite the stored id when the update fails for another reason', async () => {
    const fake = fakeElevenLabs({ failAgentPatch: 422 });
    const { d, store } = deps(fake, 'agent_existing');
    await expect(syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d)).rejects.toMatchObject({ step: 'update-agent', status: 422 });
    expect(fake.calls.some((c) => c.path === '/agents/create')).toBe(false);
    expect(store.id).toBe('agent_existing');
    expect(store.writes).toBe(0);
  });

  it('never touches the agent when a tool fails to register', async () => {
    const fake = fakeElevenLabs({ failToolCreate: true });
    const { d, store } = deps(fake, null);
    const err = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d).catch((e) => e);
    expect(err).toBeInstanceOf(ElevenLabsAgentSyncError);
    expect(err.step).toBe('create-tool:ask_papercup');
    expect(fake.calls.some((c) => c.path.startsWith('/agents'))).toBe(false);
    expect(store.writes).toBe(0);
  });

  it('checks the agent voice before any agent write and stops when the voice is unavailable', async () => {
    const fake = fakeElevenLabs();
    const { d, store } = deps(fake, null);
    const asked: string[] = [];
    d.ensureVoice = async (voiceId) => { asked.push(voiceId); return { ok: false, status: 404, error: 'voice not in library' }; };
    await expect(syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d)).rejects.toMatchObject({ step: 'ensure-voice', status: 404 });
    expect(asked).toEqual([PAPERCUP_FRONT_AGENT.tts.voiceId]);
    expect(fake.calls.some((c) => c.path.startsWith('/agents'))).toBe(false);
    expect(store.writes).toBe(0);

    d.ensureVoice = async () => ({ ok: true });
    const r = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);
    expect(r.action).toBe('created');
  });

  it('sends the key only in the request header and never returns or reports it', async () => {
    const fake = fakeElevenLabs({ failAgentPatch: 500 });
    const { d } = deps(fake, null);
    const ok = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d);
    expect(JSON.stringify(ok)).not.toContain(KEY);
    expect(fake.calls.every((c) => c.key === KEY)).toBe(true);

    const { d: d2 } = deps(fake, ok.agentId);
    const err = await syncElevenLabsAgent(PAPERCUP_FRONT_AGENT, d2).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
  });
});

describe('buildAgentConfig', () => {
  it('attaches tools by id only and lets sessions override the prompt and first message but not tools or voice', () => {
    const cfg = buildAgentConfig(PAPERCUP_FRONT_AGENT, ['tool_x']) as {
      conversation_config: { agent: { prompt: Record<string, unknown> }; conversation: { max_duration_seconds: number } };
      platform_settings: { overrides: { conversation_config_override: { agent: { prompt: Record<string, unknown>; first_message: boolean }; tts: { voice_id: boolean } } } };
    };
    expect(cfg.conversation_config.agent.prompt.tool_ids).toEqual(['tool_x']);
    expect(cfg.conversation_config.agent.prompt).not.toHaveProperty('tools');
    expect(cfg.conversation_config.conversation.max_duration_seconds).toBe(PAPERCUP_FRONT_AGENT.maxDurationSeconds);
    const ovr = cfg.platform_settings.overrides.conversation_config_override;
    expect(ovr.agent.prompt.prompt).toBe(true);
    expect(ovr.agent.prompt).not.toHaveProperty('tool_ids', true);
    expect(ovr.agent.first_message).toBe(true);
    expect(ovr.tts.voice_id).toBe(false);
  });

  it('defines ask_papercup as a client tool that takes the question, forces a holding line, and outwaits the client deadline', () => {
    expect(ASK_PAPERCUP_TOOL.type).toBe('client');
    expect(ASK_PAPERCUP_TOOL.name).toBe(ASK_PAPERCUP_TOOL_NAME);
    expect(ASK_PAPERCUP_TOOL.expects_response).toBe(true);
    expect(ASK_PAPERCUP_TOOL.parameters.required).toEqual(['question']);
    expect(ASK_PAPERCUP_TOOL.pre_tool_speech).toBe('force');
    // ElevenLabs must not time out before the client returns its own spoken failure line.
    expect(ASK_PAPERCUP_TOOL.response_timeout_secs * 1000).toBeGreaterThan(VOICE_BRAIN_TIMEOUT_MS);
    // ElevenLabs accepts client-tool timeouts up to at least 60 s (measured live 2026-10-06).
    expect(ASK_PAPERCUP_TOOL.response_timeout_secs).toBeLessThanOrEqual(60);
  });
});
