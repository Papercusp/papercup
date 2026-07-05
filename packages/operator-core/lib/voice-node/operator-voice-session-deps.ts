/**
 * Production dependencies for the OperatorVoiceSession host
 * (universal-voice-interface-2026-06-05, P-002; one-brain rewiring:
 * voice-unified-sentinel-pipeline-2026-07-01, D-001/D-002). Thin glue that binds
 * the host's injected ports to the real operator infrastructure:
 *
 *   resolveConfig   → voice prefs + EL key + mintSignedUrlFromEL, plus the
 *                     RELAY persona override (the EL agent is a voice front-end,
 *                     never a brain)
 *   connect         → an outbound `ws` WebSocket to EL's signed URL
 *   relayToBrain    → writeToSentinelPane (the ONE Sentinel pipeline — the same
 *                     mechanics typed text takes via POST /operator/sentinel-input)
 *   loadConversationId / persistTurn → the shared operator_conversations thread (D-005)
 *   parseUtterance  → parseOperatorTurn (the <say>/<set_mode> tag protocol)
 *   claim/releaseLease → the cross-surface voice-lease, re-meaned to elect the
 *                        single host+player (D-003)
 *
 * The retired path: `askOperator` used to run `${role}:converse` in-process — a
 * SECOND brain that answered voice while typed text went to the pane (the
 * modality split-brain). D-001 removed it; the pane is the one brain of record.
 *
 * The host itself is pure and unit-tested with fakes; this module is the I/O
 * boundary, so it stays declarative and is exercised by the live e2e (P-011).
 */
import { WebSocket } from 'ws';
import { loadVoicePrefs } from '../voice-prefs';
import { readElevenLabsKey } from '../voice-credentials';
import { mintSignedUrlFromEL } from '../endpoint-route/routes/agent-mcp/operator-elevenlabs-ws-init';
import { claimVoiceLease, releaseVoiceLease } from '../voice-lease';
import { activeWorkspaceId } from '../workspace-registry';
import { getOrCreateActiveConversation, appendTurn, type TurnRole } from '../operator-conversations';
import { parseOperatorTurn } from '../operator-converse-tags';
import { writeToSentinelPane } from '../sentinel/sentinel-pane-input';
import type {
  OperatorVoiceSessionDeps,
  ElConnectHandlers,
  ElSocket,
  BrainRelayResult,
} from './operator-voice-session';

/**
 * The relay persona pushed as a conversation_config_override so the EL agent
 * behaves as a FRONT-END regardless of its dashboard prompt (D-001/D-002): it
 * must never answer from its own knowledge — the Sentinel pane is the brain,
 * and its answer arrives as injected audio on this same session.
 *
 * NOTE: the EL agent's dashboard security settings must allow prompt overrides
 * for this to bite; when the platform rejects the override the session still
 * runs with the dashboard persona, so keep that persona relay-shaped too
 * (verified live in P-012/P-013).
 */
export const EL_RELAY_PERSONA = [
  'You are the Herald — the voice front-end for the Papercusp Sentinel. You are NOT the brain.',
  'For EVERY user message: call the ask_operator tool with the message, then speak the tool result VERBATIM and nothing else.',
  'Never answer questions yourself. Never invent status. The Sentinel’s full answer is delivered separately on this session — do not wait for it or mention the mechanics.',
  'Keep any speech under 20 words. No preamble, no filler.',
].join(' ');

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
    // The relay persona override makes the front-end contract code-owned instead
    // of dashboard-owned (D-001). Language rides along when configured.
    const overrides = {
      agent: {
        prompt: { prompt: EL_RELAY_PERSONA },
        ...(agentLanguage ? { language: agentLanguage } : {}),
      },
    };
    // 'sentinel' is the pre-rename pref value (WI-2932 pot-rename) — accept it
    // from stored prefs but resolve to the canonical 'papercup' role id.
    const humanFacingRole = prefs.humanFacingRole === 'sentinel' || prefs.humanFacingRole === 'papercup' ? 'papercup' : 'operator';
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

/** Hand a spoken utterance to the Sentinel pane — the ONE brain (D-001). */
async function relayToBrain(text: string): Promise<BrainRelayResult> {
  const res = await writeToSentinelPane(text);
  if (res.ok) return { ok: true };
  return { ok: false, reason: res.reason, error: res.error };
}

async function loadConversationId(): Promise<string | null> {
  try {
    return (await getOrCreateActiveConversation()).id;
  } catch {
    return null;
  }
}

async function persistTurn(role: TurnRole & ('user' | 'assistant'), text: string, elConvId: string | null): Promise<void> {
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
    relayToBrain,
    loadConversationId,
    persistTurn,
    parseUtterance,
    claimLease,
    releaseLease,
    broadcast,
    log: (msg, extra) => console.log(`[voice-host] ${msg}`, extra ?? ''),
  };
}
