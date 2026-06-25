/**
 * Production dependencies for the OperatorVoiceSession host
 * (universal-voice-interface-2026-06-05, P-002). Thin glue that binds the host's
 * injected ports to the real operator infrastructure:
 *
 *   resolveConfig   → voice prefs + EL key + mintSignedUrlFromEL (the same logic
 *                     the pui's /operator-elevenlabs-ws-init route runs)
 *   connect         → an outbound `ws` WebSocket to EL's signed URL
 *   askOperator     → operator:converse IN-PROCESS via dispatchProjectedToolStream
 *                     (the verified server-side brain path device/operator-converse uses)
 *   loadConversationId / persistTurn → the shared operator_conversations thread (D-005)
 *   parseUtterance  → parseOperatorTurn (the <say>/<set_mode> tag protocol)
 *   claim/releaseLease → the cross-surface voice-lease, re-meaned to elect the
 *                        single host+player (D-003)
 *
 * The host itself is pure and unit-tested with fakes; this module is the I/O
 * boundary, so it stays declarative and is exercised by the live e2e (P-011).
 */
import { WebSocket } from 'ws';
import { dispatchProjectedToolStream, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import '../agent-tools/index'; // register operator:converse (+ the rest) so lookupByMcpName resolves
import { loadVoicePrefs } from '../voice-prefs';
import { readElevenLabsKey } from '../voice-credentials';
import { mintSignedUrlFromEL } from '../endpoint-route/routes/agent-mcp/operator-elevenlabs-ws-init';
import { claimVoiceLease, releaseVoiceLease } from '../voice-lease';
import { activeWorkspaceId } from '../workspace-registry';
import {
  getOrCreateActiveConversation,
  appendTurn,
  listTurnsRecent,
  type TurnRole,
} from '../operator-conversations';
import { parseOperatorTurn } from '../operator-converse-tags';
import type { OperatorVoiceSessionDeps, ElConnectHandlers, ElSocket } from './operator-voice-session';

/** How many recent turns of the shared thread to feed the brain as context. */
const HISTORY_CONTEXT_TURNS = 24;

interface BrainMessage {
  role: TurnRole;
  content: string;
}

/**
 * Build the brain's message context from the shared thread's recent turns plus
 * the current spoken `question`. The host persists the user turn from the EL
 * `user_transcript` event BEFORE the agent calls `ask_operator`, so the question
 * is usually already the tail — append it only when it isn't, to avoid a
 * duplicate user line (mirrors the pui's ask_operator tail-dedup). Pure +
 * unit-tested.
 */
export function buildBrainMessages(recentTurns: Array<{ role: string; text: string }>, question: string): BrainMessage[] {
  const messages: BrainMessage[] = [];
  for (const t of recentTurns) {
    if ((t.role === 'user' || t.role === 'assistant') && t.text.trim().length > 0) {
      messages.push({ role: t.role as TurnRole, content: t.text });
    }
  }
  const q = question.trim();
  const tail = messages[messages.length - 1];
  if (q && (!tail || tail.role !== 'user' || tail.content.trim() !== q)) {
    messages.push({ role: 'user', content: q });
  }
  return messages;
}

async function resolveConfig(): ReturnType<OperatorVoiceSessionDeps['resolveConfig']> {
  try {
    const prefs = await loadVoicePrefs();
    if (prefs.fullAgentEngine !== 'elevenlabs-conv' && prefs.fullAgentEngine !== 'elevenlabs-conversational') {
      return { ok: false, error: 'not-enabled: set fullAgentEngine to elevenlabs-conv in /settings/voice.' };
    }
    const agentId = prefs.elevenLabsAgentId?.trim();
    if (!agentId) return { ok: false, error: 'no-agent-id: set the ElevenLabs agent ID in /settings/voice.' };
    const apiKey = await readElevenLabsKey();
    if (!apiKey) return { ok: false, error: 'no-api-key: add your ElevenLabs API key in /settings/api-keys.' };

    const result = await mintSignedUrlFromEL(agentId, apiKey);
    if ('error' in result) return { ok: false, error: `${result.error}: ${result.detail}` };

    const agentLanguage = prefs.agentLanguage?.trim() ?? '';
    const overrides = agentLanguage ? { agent: { language: agentLanguage } } : null;
    // Persona repoint: the EL agent / signed-URL is
    // UNCHANGED — only the brain behind `ask_operator` switches. Default
    // 'operator' leaves the live path byte-for-byte unchanged.
    const humanFacingRole = prefs.humanFacingRole === 'sentinel' ? 'sentinel' : 'operator';
    return {
      ok: true,
      config: {
        signedUrl: result.signedUrl,
        overrides,
        // One shared session across surfaces — the brain is surface-agnostic.
        dynamicVariables: { workspace_id: activeWorkspaceId(), surface: 'desktop' },
        humanFacingRole,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

function connect(signedUrl: string, handlers: ElConnectHandlers): Promise<ElSocket> {
  return new Promise<ElSocket>((resolve, reject) => {
    let opened = false;
    const ws = new WebSocket(signedUrl);
    ws.on('open', () => {
      opened = true;
      resolve({
        send: (text: string) => {
          try {
            ws.send(text);
          } catch {
            /* socket racing closed */
          }
        },
        close: () => {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        },
      });
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      handlers.onText(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
    });
    ws.on('close', (code: number, reason: Buffer) => handlers.onClose(`el closed (${code})${reason?.length ? `: ${reason.toString()}` : ''}`));
    ws.on('error', (err: Error) => {
      if (opened) handlers.onError(err);
      else reject(err);
    });
  });
}

async function askOperator(
  question: string,
  opConversationId: string | null,
  role: string = 'operator',
): Promise<string> {
  // role selects the human-facing persona/brain: 'operator' (default, backward-compatible)
  // or 'sentinel'. The `${role}:converse` tool alias loads the matching persona.
  const tool = lookupByMcpName(`${role}:converse`);
  if (!tool) throw new Error(`${role}:converse tool not registered`);

  const conversationId = opConversationId ?? (await getOrCreateActiveConversation()).id;
  const recent = await listTurnsRecent({ conversationId, limit: HISTORY_CONTEXT_TURNS });
  const messages = buildBrainMessages(recent.turns, question);

  const ctxBase: UnifiedToolContext = {
    log: (msg) => console.log(`[voice-host][brain] ${msg}`),
    signal: AbortSignal.timeout(120_000),
    progress: () => {},
    emit: () => {},
    workspaceId: activeWorkspaceId(),
    role: role as UnifiedToolContext['role'],
    runId: globalThis.crypto.randomUUID(),
    spawnId: globalThis.crypto.randomUUID(),
    transport: 'in_process',
    uiClientId: null,
  };

  let assembled = '';
  for await (const ev of dispatchProjectedToolStream(
    tool,
    `${role}:converse`,
    { messages, trigger: 'user_message', modality: 'voice', conversationId, role },
    ctxBase,
    {},
  )) {
    if (ev.kind === 'done') {
      try {
        const t = (ev.result.content[0] as { text?: string })?.text ?? '{}';
        assembled = (JSON.parse(t) as { assembled?: string }).assembled ?? '';
      } catch {
        /* leave assembled empty → fallback below */
      }
    } else if (ev.kind === 'error') {
      throw ev.error;
    }
  }

  // EL speaks what we return, so hand back the clean <say> body (the agent's
  // own `agent_response` event then carries it for persistence + display).
  const parsed = parseOperatorTurn(assembled);
  const say = (parsed.say ?? assembled).trim();
  return say || 'I had trouble just then — say that again?';
}

async function loadConversationId(): Promise<string | null> {
  try {
    return (await getOrCreateActiveConversation()).id;
  } catch {
    return null;
  }
}

async function persistTurn(role: 'user' | 'assistant', text: string, elConvId: string | null): Promise<void> {
  try {
    const conv = await getOrCreateActiveConversation();
    await appendTurn({
      conversationId: conv.id,
      role,
      text,
      source: role === 'user' ? 'voice_stt' : 'voice_tts',
      elConvId,
    });
  } catch (err) {
    console.warn('[voice-host] persist turn failed:', (err as Error)?.message ?? err);
  }
}

function parseUtterance(raw: string): { say: string | null; setMode: string | null } {
  const parsed = parseOperatorTurn(raw);
  return { say: parsed.say, setMode: parsed.setMode };
}

async function claimLease(playerId: string, kind: 'desktop' | 'tui' | 'mobile', force: boolean): Promise<boolean> {
  const out = await claimVoiceLease({ workspaceId: activeWorkspaceId(), ownerId: playerId, ownerKind: kind, force });
  return out.granted;
}

async function releaseLease(playerId: string): Promise<void> {
  await releaseVoiceLease({ workspaceId: activeWorkspaceId(), ownerId: playerId });
}

/**
 * Build the production dep set. `broadcast` is supplied by the caller (the
 * local-audio-socket fans the frame to every attached operator-voice client).
 */
export function createOperatorVoiceSessionDeps(broadcast: (frame: Uint8Array) => void): OperatorVoiceSessionDeps {
  return {
    resolveConfig,
    connect,
    askOperator,
    loadConversationId,
    persistTurn,
    parseUtterance,
    claimLease,
    releaseLease,
    broadcast,
    log: (msg, extra) => console.log(`[voice-host] ${msg}`, extra ?? ''),
  };
}
