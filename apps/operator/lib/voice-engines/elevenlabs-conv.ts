/**
 * ElevenLabs Conversational AI engine.
 *
 * Primary `fullAgentEngine` for v5+. Replaces the existing stub at
 * lib/voice-engines/elevenlabs-mse.ts (TTS-only) for the conversational path.
 *
 * Architecture (see /docs/agents/action-registry §0, §8):
 *   browser ── WebRTC ──> ElevenLabs Conv AI agent (Claude Haiku via BYO LLM)
 *      ▲                       │
 *      │ clientTools (in-page)  │ webhook tools (server-side)
 *      ▼                       ▼
 *   Action Registry         /api/elevenlabs/webhook/*
 *
 * Reflexive commands (browser:'required') are emitted as **client-side
 * tools** — when the agent calls them, the SDK invokes our handler in
 * the browser, we run runCommand() locally, return the result. Sub-100ms.
 *
 * Server-side commands + delegate_to_claude are configured at agent-creation
 * time on the EL dashboard as **webhook tools** pointing at our public
 * endpoints. Those don't go through this client; the agent talks to our
 * server directly.
 *
 * This module only handles the in-page audio + clientTools loop.
 */

import { Conversation, type VoiceConversation } from '@elevenlabs/client';
import { runCommand, runQuery, list } from '../commands/registry';
import type { CommandContext, Definition } from '../commands/types';
import { OPERATOR_PERSONA_PROMPT } from '../operator-persona';
import { OPERATOR_CONVERSE_PROMPT } from '../operator-converse-prompt';
import { readOperatorModeFromSession } from '../operator-converse-tags';
import { eligibleBeats } from '../op-backstory-bank';
import { backstoryEligibleNow, recentlyFiredIds } from '../op-backstory-state';
import '../commands/defs';

interface StartArgs {
  agentId: string;
  conversationToken: string;
  workspace: string;
  tabId: string;
  onTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (err: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export interface ElevenLabsHandle {
  endSession(): Promise<void>;
  getStatus(): 'connecting' | 'connected' | 'disconnected' | 'unknown';
  getConversationId(): string | null;
  sendSystem(text: string): void;
}

export async function startElevenLabsConv(args: StartArgs): Promise<ElevenLabsHandle> {
  if (typeof window === 'undefined') throw new Error('elevenlabs-conv must run in browser');

  // Resume any suspended AudioContexts before opening the session.
  // Chrome suspends contexts created without a user-gesture handler;
  // EL's WebRTC pipeline plays the first_message via an audio element
  // that inherits the suspended state and stays silent. The user
  // *did* gesture (they clicked the voice button to get here), so
  // resume succeeds. Idempotent — running on already-running contexts
  // is a no-op.
  await resumeAllAudioContexts().catch(() => { /* best-effort */ });

  // Pre-warm the microphone so Chrome has the device open + permission
  // re-confirmed BEFORE EL's SDK calls setMicrophoneEnabled(true). When
  // the operator's React tree is heavy, Chrome's first getUserMedia call
  // can take >1s; by then LiveKit's internal LocalTrackSubscribed
  // timeout has fired ("could not find local track publication after
  // timeout") and the negotiation enters a reconnect loop. Pre-warming
  // makes EL's subsequent getUserMedia near-instant since the device is
  // already opened.
  //
  // We hold the stream until EL takes over, then close it so EL's track
  // is the sole publisher. Chrome reuses the underlying device handle
  // when EL re-acquires it within the same gesture window.
  // Throw the prewarm error directly — EL's downstream error tends to be
  // less specific ("Requested device not found" even when the real cause
  // is "permission denied/dismissed"), and continuing past a known-bad
  // mic state guarantees the user waits through ICE timeouts only to
  // see a misleading toast.
  let prewarmStream: MediaStream | null = null;
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
    try {
      prewarmStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      const name = (e as Error)?.name ?? '';
      console.warn('[elevenlabs-conv] mic prewarm failed:', name, m);
      if (/NotAllowed|Permission|denied|dismiss/i.test(name + ' ' + m)) {
        throw new Error(
          `Microphone permission required. Click the voice button again and choose "Allow" in the browser prompt, ` +
          `or if you previously dismissed it: click the lock/site-info icon in the address bar → Microphone → Allow → reload.`,
        );
      }
      if (/NotFound|device/i.test(name + ' ' + m)) {
        throw new Error(
          `Microphone unavailable: ${m}. No working audio input is visible to the browser. ` +
          `Check OS sound settings; on Linux verify pipewire/pulse is running and the device is unmuted.`,
        );
      }
      throw new Error(`Microphone setup failed: ${m}`);
    }
  }

  // Build the clientTools map from registry. Only browser:'required' commands
  // and queries are eligible — server-side commands are wired as webhook tools
  // on the EL dashboard.
  const clientTools = buildClientTools({
    workspace: args.workspace,
    tabId: args.tabId,
  });

  // Build the session-start prompt — but skip the three preflight
  // fetches entirely if we're in bareMode (their output gets discarded
  // below) or if a full-agent engine isn't going to consume them.
  // In dev mode each Next route compiles cold (~5-10s), so saving
  // three sequential fetches drops connect time from ~25s to ~5s.
  // Run the three in parallel — they share no dependencies.
  const url = typeof window !== 'undefined' ? new URL(window.location.href) : null;
  const bareMode = url?.searchParams.get('elBare') === '1';
  // Shell mode: EL is the voice transport, the local omp brain answers via
  // ask_operator. The dashboard prompt is operator.shell.md (set by
  // el-agent-sync.mjs) and we deliberately do NOT inject persona/converse —
  // those live in the local brain's prompt. To run EL with its own LLM,
  // set localStorage.harnessElShellMode = '0'.
  const shellMode =
    typeof window !== 'undefined'
      ? window.localStorage.getItem('harnessElShellMode') !== '0'
      : true;
  let sessionsContext = '';
  if (!bareMode && !shellMode) {
    const [delegatesBlock, personaName, backstoryBlock] = await Promise.all([
      fetchDelegatesBlock(args.workspace),
      fetchUserName().catch(() => null),
      buildBackstoryBlock(),
    ]);
    const namedPersona = personaName
      ? OPERATOR_PERSONA_PROMPT.replace(/\{name\}/g, personaName)
      : OPERATOR_PERSONA_PROMPT;
    // When in active mode, also inject the converse prompt so the
    // voice agent runs the continuous turn-taking loop with the same
    // <say>/<set_mode>/<sleep> tag contract the text path uses.
    // Passive mode keeps the existing persona-only prompt — operator
    // only responds when spoken to, no proactive utterances.
    const operatorMode = readOperatorModeFromSession() ?? 'active';
    const conversePrompt = operatorMode === 'active' ? OPERATOR_CONVERSE_PROMPT : '';
    sessionsContext = [namedPersona, conversePrompt, delegatesBlock, backstoryBlock]
      .filter((s) => s && s.trim().length)
      .join('\n\n---\n\n');
  }

  // Try once with overrides; retry without if signaling fails. Agents
  // that haven't enabled "Override prompt" in their dashboard Security
  // settings reject the override at LiveKit signaling time, surfacing
  // as "could not establish signal connection: <reason>". Retrying
  // without overrides keeps voice working at the cost of skipping the
  // dynamic delegates context until the user enables overrides.
  // LiveKit reports immediate-disconnect-after-connect on negotiation
  // failure WITHOUT calling onError — we have to detect it from the
  // disconnect timing and reason. Track when connect fired so we can
  // tell a real disconnect from a 2ms-later "fake" connect that
  // immediately failed.
  let connectedAt = 0;
  const baseSessionOpts = {
    conversationToken: args.conversationToken,
    connectionType: 'webrtc' as const,
    textOnly: false,
    clientTools,
    onConnect: () => {
      // Only record the FIRST connect — the EL SDK fires onConnect again
      // on reconnection during the lifecycle. Without this, a normal
      // close-after-30s gets reported as "disconnected 7ms after connect"
      // because the most recent reconnect event is the one we measured
      // against. Real negotiation failures fail fast and never reconnect.
      if (connectedAt === 0) connectedAt = Date.now();
      // Force-play any audio elements EL appended to document.body —
      // Chrome's autoplay policy can block them if the resume-on-gesture
      // window already lapsed by the time the remote track arrives.
      // .play() returns a promise that may reject (e.g. when already
      // playing); swallow it. Re-runs every connect, idempotent.
      const tryPlay = () => {
        document.querySelectorAll<HTMLAudioElement>('audio').forEach((a) => {
          if (a.paused) { void a.play().catch(() => { /* fine */ }); }
        });
      };
      tryPlay();
      // EL attaches the agent track AFTER onConnect on some networks —
      // retry once after the next macrotask + once more shortly after.
      setTimeout(tryPlay, 200);
      setTimeout(tryPlay, 1500);
      args.onConnect?.();
    },
    onDisconnect: (details?: any) => {
      const aliveMs = connectedAt > 0 ? Date.now() - connectedAt : 0;
      const reason = details?.reason ?? details?.context?.reason ?? '(no reason)';
      // If we disconnect within 5s of connecting, that's the LiveKit
      // negotiation-failure pattern: brief flicker of "connected" then
      // ICE deadline expires. Surface this through onError so the
      // existing NegotiationError handler in voice-mode fires the
      // network-issue toast + tears down the session.
      if (connectedAt > 0 && aliveMs < 5000) {
        args.onError?.(new Error(
          `negotiation timed out — disconnect ${aliveMs}ms after connect (reason: ${reason})`,
        ));
      }
      args.onDisconnect?.();
    },
    onMessage: ({ message, source }: { message: string; source: 'user' | 'ai' }) => {
      if (source === 'user') args.onTranscript?.(message);
      else if (source === 'ai') args.onAssistantText?.(message);
    },
    onError: (msg: string) => { args.onError?.(new Error(msg)); },
  };

  const overridePayload = sessionsContext.length
    ? { agent: { prompt: { prompt: sessionsContext } } }
    : undefined;

  let conv: VoiceConversation;
  // Diagnostic toggle: ?elBare=1 in the URL strips clientTools + overrides
  // (and the persona-build fetches above) to isolate whether they're
  // causing the agent to hang up at connect.
  if (bareMode) {
    console.log('[el-conv] BARE MODE — skipping clientTools + overrides for diagnostic');
  }

  const tryStart = async (withOverrides: boolean): Promise<VoiceConversation> => {
    const opts: any = { ...baseSessionOpts };
    if (bareMode) {
      // Strip everything optional. Just enough to open a session.
      opts.clientTools = {};
    }
    if (withOverrides && overridePayload && !bareMode) {
      opts.overrides = overridePayload;
    }
    return (await Conversation.startSession(opts)) as VoiceConversation;
  };

  // Release the prewarm stream RIGHT BEFORE EL's startSession runs so
  // Chrome sees the device as immediately available. Holding it during
  // EL's getUserMedia would force Chrome to clone the track and slow
  // things down; releasing it leaves the device "warm" without a
  // competing consumer.
  const releasePrewarm = () => {
    if (prewarmStream) {
      try { prewarmStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      prewarmStream = null;
    }
  };

  try {
    releasePrewarm();
    conv = await tryStart(true);
  } catch (err: unknown) {
    releasePrewarm();
    const msg = (err as Error)?.message ?? String(err);
    const looksLikeSignalingFailure = /signal connection|signaling|server unreachable|override/i.test(msg);
    const looksLikeDeviceError = /requested device not found|notfounderror|notallowederror|permission denied|no audio|microphone|getUserMedia/i.test(msg);
    // \bice\b prevents "device" from matching the "ice" alternation.
    const looksLikeNegotiation = !looksLikeDeviceError && /negotiation|negotiate|\bice\b|peerconnection|pc connection/i.test(msg);

    // Override-rejection: retry without overrides (agent dashboard
    // hasn't enabled "Override prompt"). Lose the dynamic context,
    // keep the session.
    if (overridePayload && looksLikeSignalingFailure) {
      console.warn('[elevenlabs-conv] signaling failed with overrides; retrying without:', msg);
      try {
        conv = await tryStart(false);
        args.onError?.(new Error(
          'Connected without prompt context. Enable "Override prompt" in your ElevenLabs agent Security settings to restore the delegates context.',
        ));
      } catch (err2: unknown) {
        throw new Error(`signaling failed (after retry without overrides): ${(err2 as Error)?.message ?? String(err2)}`);
      }
    }
    // Microphone error: no device, permission denied, or stale deviceId.
    // Don't retry — getUserMedia errors won't fix themselves and the
    // misleading "negotiation timed out twice" message used to fire here
    // because "device" contains the substring "ice".
    if (looksLikeDeviceError) {
      // Enumerate what the browser actually sees so the toast can pin
      // down whether it's "no devices at all" vs "permission" vs
      // "specific deviceId stale". Permission state is the most useful
      // single signal.
      let perm: string | undefined;
      let inputCount = -1;
      let labels = '';
      try {
        const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        perm = p.state;
      } catch { /* Firefox lacks permissions.query for mic */ }
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const inputs = devs.filter(d => d.kind === 'audioinput');
        inputCount = inputs.length;
        // Labels are empty strings until permission is granted — that
        // alone diagnoses "permission never granted" vs "no devices".
        labels = inputs.map(d => d.label || '(unlabelled)').join(', ').slice(0, 200);
      } catch { /* enumerate can fail in obscure contexts */ }
      const ctx = `[perm=${perm ?? 'unknown'} inputs=${inputCount}${inputCount > 0 ? ` (${labels})` : ''}]`;
      console.warn('[elevenlabs-conv] device-error context:', ctx, msg);
      throw new Error(
        `Microphone unavailable: ${msg}. ${ctx} ` +
        (perm === 'denied' ? 'Mic permission is DENIED — click the lock icon → Site settings → Microphone → Allow, then reload.'
          : inputCount === 0 ? 'No audio input devices visible to the browser. Check OS sound settings; on Linux verify pipewire/pulse is running.'
          : !labels.trim() || /^\(unlabelled\)/.test(labels) ? 'Devices exist but labels are blank — permission was never granted in this site. Click the lock icon → Microphone → Allow, then reload.'
          : 'Devices exist and permission looks granted — try reloading the page; if it persists, the EL/LiveKit cache may reference a removed device.'),
      );
    }
    // WebRTC negotiation timeout: usually a network/firewall blocking
    // UDP egress to LiveKit. A fresh session sometimes picks different
    // ICE candidates and succeeds — retry once with a short delay
    // before giving up.
    else if (looksLikeNegotiation) {
      console.warn('[elevenlabs-conv] WebRTC negotiation timed out; one retry after 1.5s:', msg);
      await new Promise((r) => setTimeout(r, 1500));
      try {
        conv = await tryStart(true);
      } catch (err2: unknown) {
        const inner = (err2 as Error)?.message ?? String(err2);
        throw new Error(
          `WebRTC negotiation timed out twice. This is almost always a network/firewall blocking UDP egress to LiveKit (the EL media transport). ` +
          `Check: VPN, corporate firewall, or try a different network. Inner: ${inner}`,
        );
      }
    }
    else {
      throw new Error(`signaling failed: ${msg}`);
    }
  }

  return {
    async endSession() { await conv.endSession(); },
    getStatus() {
      try {
        return (conv as any).getStatus?.() ?? 'unknown';
      } catch { return 'unknown'; }
    },
    getConversationId() {
      try {
        return (conv as any).getId?.() ?? null;
      } catch { return null; }
    },
    /**
     * Send a system-style contextual update into the live conversation.
     * The EL SDK queues this until end-of-turn, so it never interrupts
     * the user mid-sentence. Used by the async delegate path: when a
     * long delegate finishes, we surface the result this way so the
     * agent can speak about it on its next turn instead of having
     * already returned an empty "looking into that" hours ago.
     */
    sendSystem(text: string) {
      try {
        (conv as any).sendContextualUpdate?.(text);
      } catch (e) {
        console.warn('[el-conv] sendContextualUpdate failed:', e);
      }
    },
  };
}

/**
 * Build the registry-derived clientTools map. EL Conv AI clientTools are
 * in-page: { [name]: (params) => result }. Each entry runs the matching
 * registry command/query and returns the result as a string (EL accepts
 * string | number | void).
 *
 * We expose only browser:'required' commands as client-side tools — the
 * rest were configured as webhook tools on the EL dashboard during agent
 * setup, and the agent calls our server directly for those.
 */
function buildClientTools(opts: {
  workspace: string;
  tabId: string;
}): Record<string, (parameters: any) => Promise<string>> {
  const tools: Record<string, (parameters: any) => Promise<string>> = {};
  const ctx = (): CommandContext => ({
    agent: 'operator',
    workspace: opts.workspace,
    sessionId: opts.tabId,
    requestId: `el-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });

  // Reflexive commands: browser:'required' tier-reflexive
  const commands = list({ kind: 'command', agent: 'operator', browser: ['required'] });
  for (const def of commands) {
    tools[normalizeToolName(def.id)] = async (params: any) => {
      const result = await runCommand(def.id, params, ctx());
      return JSON.stringify(result);
    };
  }

  // Queries — voice's fast-query surface. Always client-side for speed.
  const queries = list({ kind: 'query', agent: 'operator' });
  for (const def of queries) {
    tools[normalizeToolName(def.id)] = async (params: any) => {
      const result = await runQuery(def.id, params, ctx());
      return JSON.stringify(result);
    };
  }

  // The brain delegate. EL's own LLM is the transport shell; the actual
  // operator reply is generated by our local omp + Claude Max stack via
  // /api/agent-mcp/operator-converse. EL is told (in its system prompt)
  // to call this for every user turn and speak the returned text verbatim.
  tools.ask_operator = async (params: any) => askOperatorViaSse(params);

  return tools;
}

/**
 * Calls the local /api/agent-mcp/operator-converse SSE route, drains the
 * stream, parses tags, and returns the `<say>` body. EL receives this
 * string and speaks it via TTS.
 *
 * Errors return a fallback line — never throw, because EL would surface
 * the failure as a verbatim error to the user. A graceful "I had trouble
 * just then" is far better.
 */
async function askOperatorViaSse(params: { text?: string }): Promise<string> {
  const userText = (params?.text ?? '').toString().trim();
  if (!userText) return '';
  try {
    const res = await fetch('/api/agent-mcp/operator-converse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userText }],
        trigger: 'user_message',
        mayAskActive: false,
      }),
    });
    if (!res.ok || !res.body) {
      console.warn('[el-conv:ask_operator] SSE init failed', res.status);
      return 'I had trouble just then — say that again?';
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let assembled = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (typeof payload?.text === 'string') assembled += payload.text;
          } catch { /* ignore non-JSON */ }
        }
      }
    }
    const sayMatch = assembled.match(/<say(?:\s[^>]*)?>([\s\S]*?)<\/say>/i);
    const out = (sayMatch ? sayMatch[1] : assembled).trim();
    return out || '...';
  } catch (err) {
    console.warn('[el-conv:ask_operator]', err);
    return 'I had trouble just then — say that again?';
  }
}

/**
 * EL Conv AI tool names must match the agent's configured tools exactly.
 * Our registry IDs use dotted notation (`panel.toggle`); EL is case
 * sensitive but tolerant of dots. We pass through unchanged for now;
 * if EL refuses dots we'll rewrite to underscores here.
 */
/**
 * EL agent tool names are simple identifiers (no dots). Registry ids
 * use dotted namespacing ("panel.toggle"). Normalize to match what the
 * agent dashboard expects — el-agent-sync.mjs uses the same mapping.
 */
function normalizeToolName(id: string): string {
  return id.replace(/[.-]/g, '_');
}

/**
 * Build the JSON catalog of clientTools we want to sync to the EL agent.
 * Used by an admin endpoint that PUTs the tool list to the agent platform
 * during PR 1's setup phase. Each entry is the agent-config shape EL expects.
 */
export function buildClientToolCatalog(): Array<{
  name: string;
  description: string;
  parameters: unknown;
  expects_response: boolean;
}> {
  const out: Array<{ name: string; description: string; parameters: unknown; expects_response: boolean }> = [];
  const eligible: Definition[] = [
    ...list({ kind: 'command', agent: 'operator', browser: ['required'] }),
    ...list({ kind: 'query', agent: 'operator' }),
  ];
  for (const def of eligible) {
    out.push({
      name: normalizeToolName(def.id),
      description: def.promptDescription ?? def.description,
      parameters: zodToJsonSchemaFor(def.schema),
      expects_response: true,
    });
  }
  return out;
}

// Lazy import to avoid pulling zod-to-json-schema on the hot voice path.
function zodToJsonSchemaFor(_schema: unknown): unknown {
  // Plumbed via the elevenlabs-shim sync endpoint, not at session start.
  return {};
}

/**
 * Build the "you have these Claude conversations open" context block
 * for voice. Voice picks which session to pass to delegate_to_claude
 * based on title relevance. Refreshed at every EL session-start.
 */
async function fetchDelegatesBlock(workspace: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/agent-mcp/delegates?status=open&limit=10`, {
      headers: { 'x-workspace': workspace },
    });
    if (!r.ok) return null;
    const data = await r.json() as {
      sessions: Array<{ id: number; title: string | null; lastActiveAt: string; turnCount: number; claudeSessionId: string }>;
    };
    const routingPreamble = [
      'You are the Operator — the low-latency voice front-end.',
      'Your reflexive tools (panel toggle, navigate, scan, approve, across-workspaces) execute UI actions instantly.',
      'For ANYTHING ELSE — research, multi-step work, asking another agent, "what\'s happening with X" — call delegate_to_claude with the user request as `task`. The delegate is your local Claude brain; it has cross-harness MCP tools you don\'t.',
      'After delegating, briefly say "looking into that, details in the panel" — the operator panel auto-opens when the delegate is done.',
      'When in doubt, delegate. Never guess answers about the codebase, agents, or workspace state.',
      '',
    ].join('\n');

    if (!data.sessions?.length) {
      return routingPreamble +
        'You have no open delegate conversations yet. Call delegate_to_claude with newSession:true to start one.';
    }
    const lines = data.sessions.map((s) => {
      const title = s.title ?? '(untitled)';
      const minsAgo = Math.round((Date.now() - new Date(s.lastActiveAt).getTime()) / 60000);
      return `  - id:${s.claudeSessionId.slice(0, 8)} "${title}" (${s.turnCount} turns, ${minsAgo}m ago)`;
    });
    return [
      routingPreamble,
      'Existing delegate conversations in this workspace:',
      ...lines,
      '',
      'When delegating: pass `sessionId` (the id from the list above) if the user\'s task',
      'relates to one of these conversations; pass `newSession:true` for a clean slate;',
      'pass neither and the server picks (most recent if <5min, else new).',
    ].join('\n');
  } catch {
    return null;
  }
}

/**
 * Pull the user's display name from /api/profile so the persona can
 * substitute {name}. Best-effort — null on any error.
 */
async function fetchUserName(): Promise<string | null> {
  try {
    const r = await fetch('/api/profile');
    if (!r.ok) return null;
    const profile = (await r.json()) as { display_name?: string; email?: string };
    const dn = profile.display_name?.trim();
    if (dn) return dn;
    // Fall back to the local-part of the email if no display name.
    const email = profile.email?.trim();
    if (email && email.includes('@')) return email.split('@')[0];
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the eligible-backstory-beats block for the EL session-start
 * prompt. Per /docs/agents/operator-persona §7c:
 *   - Returns null if user disabled backstory in voice prefs
 *   - Returns null if rate-limit (3/session, 30min cooldown) is tripped
 *   - Otherwise returns up to 3 eligible beats with the "you may
 *     reference one if it fits naturally" framing
 *
 * Trigger context here is intentionally weak — at session start we
 * don't know what op is about to happen. We include beats whose
 * triggers are session-state based (firstSession, sessionAgeMin) and
 * a small stable subset; runtime-triggered beats aren't reachable
 * from this seam, but session-bounded ones are exactly the right
 * shape for "may reference at most once or twice this session".
 */
async function buildBackstoryBlock(): Promise<string | null> {
  try {
    const r = await fetch('/api/agent-mcp/operator-voice-prefs');
    if (!r.ok) return null;
    const prefs = (await r.json()) as { operatorBackstoryEnabled?: boolean };
    if (prefs.operatorBackstoryEnabled === false) return null;
  } catch {
    /* default-on */
  }

  if (!backstoryEligibleNow()) return null;

  const recent = recentlyFiredIds();
  const ctx = { firstSession: false, sessionAgeMin: 0 };
  const eligible = eligibleBeats(ctx, ['default', 'sober'], recent).slice(0, 3);
  if (!eligible.length) return null;

  const lines = eligible.map((b) => `  [${b.id}] "${b.story}"`);
  return [
    'Optional past experiences. You may reference at most one of these',
    "this session if it fits naturally — never force it. Most utterances",
    'should skip them. No "this reminds me of" preamble; just say it.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Resume any AudioContext that the browser has suspended for autoplay
 * policy. We can't enumerate them globally — there's no API for that —
 * but we can:
 *   1. Create a fresh probe context. If it's suspended, the browser
 *      requires a gesture to unlock. If we got here via voice-button
 *      click, the gesture is present and resume() succeeds.
 *   2. Play a silent buffer on it to fully unblock subsequent contexts.
 *
 * This unblocks the EL SDK's internal context too — Chrome unlocks
 * audio at the document level once any context resumes after a gesture.
 */
async function resumeAllAudioContexts(): Promise<void> {
  if (typeof window === 'undefined') return;
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return;
  const probe = new Ctx();
  try {
    if (probe.state === 'suspended') await probe.resume();
    // Play an empty buffer to clinch the unlock — some Chrome versions
    // need actual playback to flip from "running" to fully unblocked.
    const buf = probe.createBuffer(1, 1, 22050);
    const src = probe.createBufferSource();
    src.buffer = buf;
    src.connect(probe.destination);
    src.start(0);
  } finally {
    // Close on a microtask; immediate close interrupts the start().
    setTimeout(() => { try { void probe.close(); } catch { /* ignore */ } }, 100);
  }
}
