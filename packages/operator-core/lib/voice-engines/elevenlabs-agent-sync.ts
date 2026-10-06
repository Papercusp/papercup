/**
 * ElevenLabs Conversational AI agent — definition as code + idempotent sync.
 *
 * Plan voice-two-tier-elevenlabs-agent-2026-10-06, P-002. The ElevenLabs agent
 * is the FAST FRONT of a two-tier voice design: it answers small talk itself
 * and hands anything substantive to Papercup through the `ask_papercup` client
 * tool. Papercup is the brain (operator-converse, ~16 s to first word measured
 * in D-004), so ElevenLabs always speaks a holding line before the tool runs
 * (`pre_tool_speech: "force"`, P-003) and the tool returns Papercup's answer to
 * say — or, past the client deadline, a short spoken failure line
 * (@papercusp/chat-protocol voice-brain-tool).
 *
 * `syncElevenLabsAgent` converges ElevenLabs on the definition below:
 *   1. upsert every client tool by NAME (PATCH when it exists, POST when not);
 *   2. PATCH the stored agent; when no id is stored, or the stored id answers
 *      404 (D-004: the configured agent no longer exists), CREATE one;
 *   3. save the new agent id. Running it again changes nothing new.
 *
 * Network and storage are injected so the sync is unit-tested against a fake
 * ElevenLabs API (elevenlabs-agent-sync.test.ts). The API key only ever goes
 * into the request header; it is never returned or logged.
 *
 * Supersedes the update-only apps/operator/scripts/el-agent-sync.mjs for the
 * two-tier agent; request shapes are taken from that script.
 */

import { ASK_PAPERCUP_TOOL_NAME, VOICE_BRAIN_TIMEOUT_MS } from '@papercusp/chat-protocol';

const EL_API = 'https://api.elevenlabs.io/v1/convai';

export interface ElevenLabsClientTool {
  type: 'client';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  expects_response: boolean;
  response_timeout_secs: number;
  /** Whether the agent speaks a filler line before calling the tool (ElevenLabs default 'auto'). */
  pre_tool_speech?: 'auto' | 'force' | 'off';
}

export interface ElevenLabsAgentDefinition {
  /** Display name in the ElevenLabs dashboard; also identifies the profile. */
  name: string;
  prompt: string;
  firstMessage: string;
  language: string;
  tools: ElevenLabsClientTool[];
  tts: {
    voiceId: string;
    modelId: string;
    stability: number;
    similarityBoost: number;
    speed: number;
  };
  /** Seconds; ElevenLabs ends the call after this. Tutorial profile caps it (P-011). */
  maxDurationSeconds: number;
}

export const ASK_PAPERCUP_TOOL: ElevenLabsClientTool = {
  type: 'client',
  name: ASK_PAPERCUP_TOOL_NAME,
  description:
    'Ask Papercup, the user’s assistant, anything that needs knowledge of their work, their workspace, '
    + 'or an action. Returns Papercup’s answer (or a short line explaining it could not answer): say it as written.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The user’s request in their own words, with any detail they gave.',
      },
    },
    required: ['question'],
  },
  expects_response: true,
  // The client gives up on Papercup at VOICE_BRAIN_TIMEOUT_MS and returns a
  // spoken failure line, so ElevenLabs must wait longer than that — the user
  // then hears our line rather than ElevenLabs' generic tool error.
  response_timeout_secs: Math.ceil(VOICE_BRAIN_TIMEOUT_MS / 1000) + 10,
  // Always say a short holding line ("let me check") before the tool runs:
  // the brain takes ~16 s to its first word (D-004).
  pre_tool_speech: 'force',
};

export const PAPERCUP_FRONT_PROMPT = [
  'You are the voice of Papercup, a personal assistant. You speak with the user in real time.',
  'Keep every reply short and natural: one or two spoken sentences.',
  'Handle greetings, small talk and simple clarifying questions yourself.',
  'For anything that needs facts about the user’s work, files, messages, plans, workspace or Papercup itself, '
    + 'or any action, call ask_papercup with the user’s request. Never make up those answers.',
  'Before calling ask_papercup, say one short holding line such as “Let me check.”',
  'ask_papercup returns Papercup’s answer: say it as written, without adding to it or summarizing it.',
  'If the user speaks while an answer is pending, listen; call ask_papercup again if they changed the request.',
].join('\n');

export const PAPERCUP_FRONT_AGENT: ElevenLabsAgentDefinition = {
  name: 'Papercup voice',
  prompt: PAPERCUP_FRONT_PROMPT,
  firstMessage: 'Hi, I’m listening.',
  language: 'en',
  tools: [ASK_PAPERCUP_TOOL],
  // Fallback voice = voice-prefs' default (an ElevenLabs premade voice every
  // account has). Production wiring uses the voice chosen for Papercup in
  // voice settings. The old script's hardcoded voice does not exist on the
  // current account (measured 2026-10-06: create-agent 400 voice_not_found).
  tts: { voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_turbo_v2', stability: 0.5, similarityBoost: 0.8, speed: 1.0 },
  maxDurationSeconds: 1800,
};

/** The agent body ElevenLabs stores. Tools are attached by id, never inline. */
export function buildAgentConfig(def: ElevenLabsAgentDefinition, toolIds: string[]): Record<string, unknown> {
  return {
    name: def.name,
    conversation_config: {
      agent: {
        first_message: def.firstMessage,
        language: def.language,
        prompt: { prompt: def.prompt, tool_ids: toolIds },
      },
      tts: {
        voice_id: def.tts.voiceId,
        model_id: def.tts.modelId,
        stability: def.tts.stability,
        similarity_boost: def.tts.similarityBoost,
        speed: def.tts.speed,
      },
      conversation: { max_duration_seconds: def.maxDurationSeconds },
    },
    platform_settings: {
      // P-004 injects the persona and recent conversation per session, so the
      // prompt and first message must accept session overrides. Tools and the
      // voice stay fixed by this definition.
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true, language: true },
          tts: { voice_id: false },
        },
      },
    },
  };
}

export interface ElevenLabsAgentSyncDeps {
  apiKey: string;
  fetch: typeof fetch;
  readAgentId: () => Promise<string | null>;
  writeAgentId: (agentId: string) => Promise<void>;
  /**
   * Make sure the agent's voice exists in the account's voice library (adding
   * a shared voice when needed). ElevenLabs refuses an agent whose voice is
   * missing, so this runs before any agent write.
   */
  ensureVoice?: (voiceId: string) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

export interface ElevenLabsAgentSyncResult {
  agentId: string;
  action: 'created' | 'updated';
  /** Why a new agent was created, when it was. */
  createdBecause: 'no-stored-id' | 'stored-id-not-found' | null;
  toolIds: Record<string, string>;
}

export class ElevenLabsAgentSyncError extends Error {
  constructor(readonly step: string, readonly status: number, detail: string) {
    super(`ElevenLabs agent sync failed at ${step} (HTTP ${status}): ${detail.slice(0, 300)}`);
    this.name = 'ElevenLabsAgentSyncError';
  }
}

async function call(deps: ElevenLabsAgentSyncDeps, step: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await deps.fetch(url, {
    ...init,
    headers: { 'xi-api-key': deps.apiKey, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return res;
}

async function fail(step: string, res: Response): Promise<never> {
  const detail = await res.text().catch(() => '');
  throw new ElevenLabsAgentSyncError(step, res.status, detail);
}

interface ListedTool { id?: string; tool_id?: string; name?: string; tool_config?: { name?: string } }

async function upsertTools(deps: ElevenLabsAgentSyncDeps, tools: ElevenLabsClientTool[]): Promise<Record<string, string>> {
  const listRes = await call(deps, 'list-tools', `${EL_API}/tools`);
  if (!listRes.ok) await fail('list-tools', listRes);
  const listed = ((await listRes.json()) as { tools?: ListedTool[] }).tools ?? [];
  const byName = new Map<string, string>();
  for (const t of listed) {
    const name = t.tool_config?.name ?? t.name;
    const id = t.id ?? t.tool_id;
    if (name && id && !byName.has(name)) byName.set(name, id);
  }
  const ids: Record<string, string> = {};
  for (const tool of tools) {
    const existing = byName.get(tool.name);
    const body = JSON.stringify({ tool_config: tool });
    if (existing) {
      const res = await call(deps, `update-tool:${tool.name}`, `${EL_API}/tools/${encodeURIComponent(existing)}`, { method: 'PATCH', body });
      if (!res.ok) await fail(`update-tool:${tool.name}`, res);
      ids[tool.name] = existing;
    } else {
      const res = await call(deps, `create-tool:${tool.name}`, `${EL_API}/tools`, { method: 'POST', body });
      if (!res.ok) await fail(`create-tool:${tool.name}`, res);
      const created = (await res.json()) as { id?: string; tool_id?: string };
      const id = created.id ?? created.tool_id;
      if (!id) throw new ElevenLabsAgentSyncError(`create-tool:${tool.name}`, res.status, 'response carried no tool id');
      ids[tool.name] = id;
    }
  }
  return ids;
}

export async function syncElevenLabsAgent(
  def: ElevenLabsAgentDefinition,
  deps: ElevenLabsAgentSyncDeps,
): Promise<ElevenLabsAgentSyncResult> {
  // Tools first: an agent must never be created or updated pointing at tools
  // that failed to register.
  const toolIds = await upsertTools(deps, def.tools);
  if (deps.ensureVoice) {
    const voice = await deps.ensureVoice(def.tts.voiceId);
    if (!voice.ok) throw new ElevenLabsAgentSyncError('ensure-voice', voice.status, voice.error);
  }
  const config = buildAgentConfig(def, def.tools.map((t) => toolIds[t.name]!));
  const body = JSON.stringify(config);

  const stored = (await deps.readAgentId())?.trim() || null;
  if (stored) {
    const res = await call(deps, 'update-agent', `${EL_API}/agents/${encodeURIComponent(stored)}`, { method: 'PATCH', body });
    if (res.ok) return { agentId: stored, action: 'updated', createdBecause: null, toolIds };
    if (res.status !== 404) await fail('update-agent', res);
  }

  const res = await call(deps, 'create-agent', `${EL_API}/agents/create`, { method: 'POST', body });
  if (!res.ok) await fail('create-agent', res);
  const agentId = ((await res.json()) as { agent_id?: string }).agent_id;
  if (!agentId) throw new ElevenLabsAgentSyncError('create-agent', res.status, 'response carried no agent_id');
  await deps.writeAgentId(agentId);
  return { agentId, action: 'created', createdBecause: stored ? 'stored-id-not-found' : 'no-stored-id', toolIds };
}

/**
 * Production wiring: Papercusp's server-side ElevenLabs key and the workspace
 * voice preference `elevenLabsAgentId`.
 */
export async function syncPapercupVoiceAgent(
  def: ElevenLabsAgentDefinition = PAPERCUP_FRONT_AGENT,
): Promise<ElevenLabsAgentSyncResult> {
  const { readElevenLabsKey } = await import('../voice-credentials');
  const { loadVoicePrefs, saveVoicePrefs } = await import('../voice-prefs');
  const { ensureVoiceInLibrary } = await import('../conv-voice');
  const apiKey = await readElevenLabsKey();
  if (!apiKey) throw new ElevenLabsAgentSyncError('read-key', 400, 'no valid ElevenLabs API key is configured');
  // Speak in the voice chosen for Papercup, so voice chat sounds the same
  // whichever engine answers.
  const chosenVoice = (await loadVoicePrefs()).elevenlabsVoiceId?.trim();
  const withVoice = chosenVoice ? { ...def, tts: { ...def.tts, voiceId: chosenVoice } } : def;
  return syncElevenLabsAgent(withVoice, {
    apiKey,
    fetch: globalThis.fetch.bind(globalThis),
    ensureVoice: async (voiceId) => {
      const r = await ensureVoiceInLibrary(apiKey, voiceId);
      return r.ok ? { ok: true } : r;
    },
    readAgentId: async () => (await loadVoicePrefs()).elevenLabsAgentId || null,
    writeAgentId: async (agentId) => { await saveVoicePrefs({ elevenLabsAgentId: agentId }); },
  });
}
