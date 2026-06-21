/**
 * Operator voice session host — ONE shared ElevenLabs/operator session, owned by
 * the voice service, that desktop + tui both attach to as full clients (plan
 * universal-voice-interface-2026-06-05, P-002/P-003/P-004/P-006/P-007).
 *
 * The host (this module, running in the operator sidecar) owns the single EL
 * WebSocket: it mints the signed URL, connects, runs the `ask_operator` brain
 * loop once, decodes the response, and:
 *   • FAN-OUT (P-003): broadcasts input transcript + response audio/transcript/
 *     tags + session state to ALL attached clients over the voice-node bus.
 *   • CONTROL (P-004): any client may mute/PTT/start/stop/set-mode/force-host;
 *     the host applies it ONCE and broadcasts the new state.
 *   • ELECTION (P-006/P-007): the lease elects ONE player — only that client
 *     renders response audio AND captures the mic; others are receive+display
 *     clients. The connection itself is the liveness signal; if the player
 *     drops, the host re-elects another attached client so the session survives.
 *
 * Pure orchestration over injected ports (EL socket, brain, persistence, lease,
 * broadcast) so it unit-tests without a live EL endpoint or audio hardware.
 */
import {
  encodeInputTranscript,
  encodeResponseAudio,
  encodeResponseTranscript,
  encodeResponseTag,
  encodeSessionState,
  type SessionStateMsg,
  type VoiceClientKind,
  type VoiceControlOp,
  type VoiceSessionStatus,
} from './operator-voice-bus';
import {
  parseElServerEvent,
  elInitiationMessage,
  elUserAudioChunkMessage,
  elPongMessage,
  elClientToolResultMessage,
  pcmRateFromFormat,
  decodeAudioB64,
} from './el-convai-protocol';

export interface ElSessionConfig {
  signedUrl: string;
  overrides: unknown | null;
  dynamicVariables: unknown;
  /**
   * Which human-facing brain/persona the host runs behind `ask_operator`
   * (sentinel-herald P-011). Resolved from the `humanFacingRole` voice pref.
   * Optional + defaults to 'operator' so the existing live path is unchanged.
   */
  humanFacingRole?: 'operator' | 'sentinel';
}

export interface ElSocket {
  send(text: string): void;
  close(): void;
}

export interface ElConnectHandlers {
  onText(text: string): void;
  onClose(reason: string): void;
  onError(err: unknown): void;
}

/** Everything the host needs from the outside world — real in prod, faked in tests. */
export interface OperatorVoiceSessionDeps {
  /** Resolve EL config (prefs/agentId/key → signed URL + overrides). */
  resolveConfig(): Promise<{ ok: true; config: ElSessionConfig } | { ok: false; error: string }>;
  /** Open the EL WebSocket and wire inbound text/close/error. */
  connect(signedUrl: string, handlers: ElConnectHandlers): Promise<ElSocket>;
  /** Run the operator brain once for a spoken turn; returns the text EL speaks. */
  askOperator(question: string, opConversationId: string | null, role?: string): Promise<string>;
  /** The shared operator conversation id (D-005) — voice turns persist into it. */
  loadConversationId(): Promise<string | null>;
  /** Persist one turn into the shared thread (host is the SOLE writer → once). */
  persistTurn(role: 'user' | 'assistant', text: string, elConvId: string | null): Promise<void>;
  /** Parse an agent utterance for spoken text + control tags. */
  parseUtterance(raw: string): { say: string | null; setMode: string | null };
  claimLease(playerId: string, kind: VoiceClientKind, force: boolean): Promise<boolean>;
  releaseLease(playerId: string): Promise<void>;
  /** Send a framed bus message to every attached client. */
  broadcast(frame: Uint8Array): void;
  log?(msg: string, extra?: unknown): void;
}

const DEFAULT_MODE = 'always-on';

interface AttachedClient {
  clientId: string;
  kind: VoiceClientKind;
}

export class OperatorVoiceSession {
  private status: VoiceSessionStatus = 'off';
  private muted = false;
  private mode = DEFAULT_MODE;
  private pttActive = false;
  private playerId: string | null = null;
  private opConversationId: string | null = null;
  private elConversationId: string | null = null;
  // Which human-facing brain/persona the voice host runs: 'operator' (default) or
  // 'sentinel' (the Herald). Set from the `humanFacingRole` voice pref via the
  // resolved ElSessionConfig at start (P-011); defaults to 'operator' so the
  // existing live voice path is byte-for-byte unchanged when the pref is unset.
  private brainRole = 'operator';
  private audioFormat: 'pcm_s16le' | 'encoded' = 'pcm_s16le';
  private sampleRate = 16000;
  private socket: ElSocket | null = null;
  private starting = false;
  private readonly clients = new Map<string, AttachedClient>();

  constructor(private readonly deps: OperatorVoiceSessionDeps) {}

  // ── client lifecycle (called by the local-audio-socket) ──────────────────

  /** A client attached + identified itself. Re-syncs everyone's session state. */
  handleHello(clientId: string, kind: VoiceClientKind): void {
    this.clients.set(clientId, { clientId, kind });
    this.broadcastState();
  }

  /** A client's socket closed. If it was the player, re-elect or tear down. */
  handleClientGone(clientId: string): void {
    this.clients.delete(clientId);
    if (this.playerId !== clientId) {
      this.broadcastState();
      return;
    }
    // The player left. Re-elect another attached client so the session survives
    // (P-011), else tear the session down — nobody to capture/play.
    const next = this.clients.values().next().value as AttachedClient | undefined;
    if (next && this.status !== 'off') {
      // The old player is gone; force-elect the next client (its force claim
      // overwrites the departed owner's lease, so no orphan lease lingers).
      this.playerId = null;
      void this.electPlayer(next.clientId, next.kind, { force: true });
    } else {
      void this.teardown('all clients left');
    }
  }

  /** Mic chunk from a client — forwarded to EL only if it's the transmitting player. */
  handleMic(clientId: string, pcm16le: Uint8Array): void {
    if (clientId !== this.playerId) return; // single mic capture (P-007)
    if (!this.socket || this.status === 'off' || this.status === 'connecting') return;
    if (!this.canTransmit()) return;
    this.socket.send(elUserAudioChunkMessage(pcm16le));
  }

  /** A control from any client — applied once to the single session (P-004). */
  handleControl(clientId: string, control: VoiceControlOp): void {
    switch (control.op) {
      case 'start':
        void this.electPlayer(clientId, this.kindOf(clientId), { startIfIdle: true });
        return;
      case 'force-host':
        void this.electPlayer(clientId, this.kindOf(clientId), { startIfIdle: true, force: true });
        return;
      case 'stop':
        void this.teardown('voice off');
        return;
      case 'mute':
        this.muted = control.muted;
        this.broadcastState();
        return;
      case 'ptt':
        this.pttActive = control.down;
        this.broadcastState();
        return;
      case 'set-mode':
        if (control.mode) this.mode = control.mode;
        this.pttActive = false;
        this.broadcastState();
        return;
    }
  }

  /** Full teardown — public so the bootstrap can stop it on shutdown. */
  async stop(): Promise<void> {
    await this.teardown('voice off');
  }

  /** Re-claim the lease for the current player — call on a timer while running. */
  async heartbeat(): Promise<void> {
    if (this.status === 'off' || !this.playerId) return;
    await this.deps.claimLease(this.playerId, this.kindOf(this.playerId), false);
  }

  /** Current state snapshot (used by tests + the bus to greet new clients). */
  snapshot(): Omit<SessionStateMsg, 'kind'> {
    return {
      status: this.status,
      muted: this.muted,
      mode: this.mode,
      playerId: this.playerId,
      conversationId: this.opConversationId,
      audioFormat: this.audioFormat,
      sampleRate: this.sampleRate,
    };
  }

  // ── election + session start ─────────────────────────────────────────────

  private kindOf(clientId: string): VoiceClientKind {
    return this.clients.get(clientId)?.kind ?? 'desktop';
  }

  private canTransmit(): boolean {
    if (this.muted) return false;
    return this.mode === 'always-on' || this.pttActive;
  }

  private async electPlayer(
    clientId: string,
    kind: VoiceClientKind,
    opts: { startIfIdle?: boolean; force?: boolean } = {},
  ): Promise<void> {
    // The lease elects the single host+player (D-003). A non-holder is never
    // refused as a *client* — and a plain (non-forcing) `start` while another
    // client is already hosting does NOT steal the player role: the caller just
    // stays an attached receive+control client (Model A). Only `force-host`
    // (force) or re-election after the player drops moves the role.
    const force = opts.force ?? false;
    const sessionLive = this.status !== 'off';
    const hasOtherPlayer = this.playerId !== null && this.playerId !== clientId;
    if (sessionLive && hasOtherPlayer && !force) {
      this.broadcastState();
      return;
    }
    // The session opener must win the role even past a stale/unexpired lease
    // from a crashed surface, so it force-claims; a non-opening claim is gentle.
    const granted = await this.deps.claimLease(clientId, kind, force || this.status === 'off');
    if (granted) this.playerId = clientId;
    if (opts.startIfIdle && this.status === 'off' && !this.starting) {
      await this.start();
    } else {
      this.broadcastState();
    }
  }

  private async start(): Promise<void> {
    if (this.starting || this.socket) return;
    this.starting = true;
    this.setStatus('connecting');
    try {
      this.opConversationId = await this.deps.loadConversationId();
      const resolved = await this.deps.resolveConfig();
      if (!resolved.ok) {
        this.starting = false;
        await this.teardown(`voice init: ${resolved.error}`, 'error');
        return;
      }
      // Repoint the live brain to the configured persona (P-011). Default
      // 'operator' keeps the existing voice path byte-for-byte unchanged.
      this.brainRole = resolved.config.humanFacingRole === 'sentinel' ? 'sentinel' : 'operator';
      const socket = await this.deps.connect(resolved.config.signedUrl, {
        onText: (t) => this.onElText(t),
        onClose: (reason) => void this.teardown(reason),
        onError: (e) => void this.teardown(`voice link error: ${(e as Error)?.message ?? String(e)}`, 'error'),
      });
      this.socket = socket;
      socket.send(elInitiationMessage(resolved.config.overrides, resolved.config.dynamicVariables));
      this.setStatus('idle');
    } catch (err) {
      this.starting = false;
      await this.teardown(`voice connect: ${(err as Error)?.message ?? String(err)}`, 'error');
      return;
    }
    this.starting = false;
  }

  private async teardown(reason: string, finalStatus: VoiceSessionStatus = 'ended'): Promise<void> {
    const wasPlayer = this.playerId;
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
    this.elConversationId = null;
    this.pttActive = false;
    // No player on a torn-down session — null it BEFORE the terminal broadcast
    // so the 'ended' state every client sees reports playerId=null, not a ghost.
    this.playerId = null;
    this.setStatus(finalStatus, reason);
    if (wasPlayer) await this.deps.releaseLease(wasPlayer).catch(() => {});
    // Settle back to 'off' so a later start is clean; the terminal reason was
    // broadcast above so clients can surface it.
    this.status = 'off';
  }

  // ── EL event handling → bus fan-out (P-003) ──────────────────────────────

  private onElText(text: string): void {
    const ev = parseElServerEvent(text);
    switch (ev.type) {
      case 'init': {
        this.elConversationId = ev.conversationId || null;
        const rate = pcmRateFromFormat(ev.agentOutputAudioFormat);
        this.audioFormat = rate == null ? 'encoded' : 'pcm_s16le';
        this.sampleRate = rate ?? 0;
        this.setStatus('idle');
        return;
      }
      case 'audio': {
        const audio = decodeAudioB64(ev.audioB64);
        this.deps.broadcast(
          encodeResponseAudio({ format: this.audioFormat, sampleRate: this.sampleRate, audio }),
        );
        if (this.status !== 'speaking') this.setStatus('speaking');
        return;
      }
      case 'ping':
        this.socket?.send(elPongMessage(ev.eventId));
        return;
      case 'user_transcript': {
        const t = ev.text.trim();
        if (!t) return;
        this.deps.broadcast(encodeInputTranscript({ text: t, final: true }));
        void this.deps.persistTurn('user', t, this.elConversationId);
        this.setStatus('listening');
        return;
      }
      case 'agent_response': {
        const raw = ev.text.trim();
        if (!raw) return;
        // Raw utterance (tags intact) for display; clients strip for the bubble.
        this.deps.broadcast(encodeResponseTranscript({ text: raw }));
        const parsed = this.deps.parseUtterance(raw);
        if (parsed.setMode) this.deps.broadcast(encodeResponseTag({ tag: 'set_mode', value: parsed.setMode }));
        const spoken = (parsed.say ?? raw).trim();
        if (spoken) void this.deps.persistTurn('assistant', spoken, this.elConversationId);
        return;
      }
      case 'interruption':
        // Barge-in: EL's VAD heard the user — clients cut playout on this state.
        this.setStatus('listening');
        return;
      case 'client_tool_call': {
        void this.onToolCall(ev.toolName, ev.toolCallId, ev.parameters);
        return;
      }
      case 'unknown':
        return;
    }
  }

  private async onToolCall(
    toolName: string,
    toolCallId: string,
    parameters: Record<string, unknown>,
  ): Promise<void> {
    if (toolName !== 'ask_operator') {
      this.socket?.send(
        elClientToolResultMessage(toolCallId, `tool '${toolName}' is not available on the voice host`, true),
      );
      return;
    }
    const question = String(parameters.question ?? parameters.message ?? parameters.text ?? '').trim();
    try {
      const reply = await this.deps.askOperator(question, this.opConversationId, this.brainRole);
      this.socket?.send(elClientToolResultMessage(toolCallId, reply, false));
    } catch (err) {
      this.socket?.send(
        elClientToolResultMessage(toolCallId, (err as Error)?.message ?? String(err), true),
      );
    }
  }

  // ── state broadcast ──────────────────────────────────────────────────────

  private setStatus(status: VoiceSessionStatus, reason?: string): void {
    this.status = status;
    this.broadcastState(reason);
  }

  private broadcastState(reason?: string): void {
    this.deps.broadcast(
      encodeSessionState({
        status: this.status,
        muted: this.muted,
        mode: this.mode,
        playerId: this.playerId,
        conversationId: this.opConversationId,
        audioFormat: this.audioFormat,
        sampleRate: this.sampleRate,
        reason,
      }),
    );
  }
}
