/**
 * Papercup transport adapter for the shared voice-turn event contract.
 *
 * The local browser pipeline and the hosted operator-voice session keep their
 * existing media, lease, persistence, and provider lifecycles. This adapter is
 * the narrow boundary that turns those transport-specific callbacks into the
 * same dependency-free `VoiceTurnEvent` stream.
 */
import {
  VOICE_PROTOCOL_VERSION,
  parseVoiceTurnEvent,
  type VoiceLatencyClass,
  type VoiceTransport,
  type VoiceTurnEvent,
} from '@papercusp/chat-protocol';

export const PAPERCUP_VOICE_TURN_EVENT = 'papercusp:voiceTurnEvent' as const;

export type PapercupVoiceTransport = Extract<
  VoiceTransport,
  'papercup-local' | 'papercup-hosted'
>;

export interface PapercupVoiceTurnStart {
  text: string;
  transport: PapercupVoiceTransport;
  latencyClass: VoiceLatencyClass;
  executor: string;
  /** Preserve a gateway-issued id when one already exists. */
  turnId?: string;
}

export interface PapercupVoiceTurnAdapterDeps {
  emit(event: VoiceTurnEvent): void;
  now?: () => number;
  createTurnId?: (transport: PapercupVoiceTransport, nowMs: number) => string;
}

interface ActiveTurn {
  turnId: string;
  transport: PapercupVoiceTransport;
  latencyClass: VoiceLatencyClass;
  executor: string;
  startedAtMs: number;
  sequence: number;
  sentenceIndex: number;
  firstSentenceMs: number | null;
}

let fallbackTurnOrdinal = 0;

function normalizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function defaultTurnId(transport: PapercupVoiceTransport, nowMs: number): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    /* deterministic fallback below */
  }
  fallbackTurnOrdinal += 1;
  return `${transport}:${Math.max(0, Math.trunc(nowMs))}:${fallbackTurnOrdinal}`;
}

/**
 * Stateful normalizer for one transport stream. All methods are observational:
 * invalid/empty input and a failing event sink never disturb the live voice UX.
 */
export class PapercupVoiceTurnAdapter {
  private readonly now: () => number;
  private readonly createTurnId: (transport: PapercupVoiceTransport, nowMs: number) => string;
  private active: ActiveTurn | null = null;

  constructor(private readonly deps: PapercupVoiceTurnAdapterDeps) {
    this.now = deps.now ?? Date.now;
    this.createTurnId = deps.createTurnId ?? defaultTurnId;
  }

  get activeTurnId(): string | null {
    return this.active?.turnId ?? null;
  }

  /** A settled STT transcript begins one canonical turn. */
  finalTranscript(input: PapercupVoiceTurnStart): VoiceTurnEvent | null {
    const text = normalizeText(input.text, 32_000);
    const executor = normalizeText(input.executor, 300);
    if (!text || !executor) return null;

    const nowMs = this.safeNow();
    // A new final transcript while a response is still active is user barge-in.
    if (this.active) this.interrupt('user', nowMs);

    const suppliedId = normalizeText(input.turnId, 200);
    let generatedId: string | null = null;
    try {
      generatedId = normalizeText(this.createTurnId(input.transport, nowMs), 200);
    } catch {
      generatedId = null;
    }
    const turnId = suppliedId ?? generatedId;
    if (!turnId) return null;

    this.active = {
      turnId,
      transport: input.transport,
      latencyClass: input.latencyClass,
      executor,
      startedAtMs: nowMs,
      sequence: 0,
      sentenceIndex: 0,
      firstSentenceMs: null,
    };
    return this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'transcript.final',
      turnId,
      sequence: 0,
      emittedAt: new Date(nowMs).toISOString(),
      text,
    });
  }

  /** One clean, speakable assistant sentence for the active turn. */
  assistantSentence(value: string): VoiceTurnEvent | null {
    const text = normalizeText(value, 32_000);
    const active = this.active;
    if (!text || !active) return null;
    const nowMs = this.safeNow();
    if (active.firstSentenceMs === null) {
      active.firstSentenceMs = Math.max(0, nowMs - active.startedAtMs);
    }
    active.sequence += 1;
    const event = this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'assistant.sentence',
      turnId: active.turnId,
      sequence: active.sequence,
      emittedAt: new Date(nowMs).toISOString(),
      text,
      sentenceIndex: active.sentenceIndex,
    });
    active.sentenceIndex += 1;
    return event;
  }

  /** Terminal success with first-sentence and end-to-end timing. */
  complete(): VoiceTurnEvent | null {
    const active = this.active;
    if (!active) return null;
    const nowMs = this.safeNow();
    active.sequence += 1;
    const event = this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'completed',
      turnId: active.turnId,
      sequence: active.sequence,
      emittedAt: new Date(nowMs).toISOString(),
      metrics: {
        executor: active.executor,
        latencyClass: active.latencyClass,
        firstSentenceMs: active.firstSentenceMs,
        totalMs: Math.max(0, nowMs - active.startedAtMs),
      },
    });
    this.active = null;
    return event;
  }

  /** Terminal interruption. An explicit timestamp keeps barge-in ordering exact. */
  interrupt(
    reason: 'user' | 'transport' | 'policy',
    atMs: number = this.safeNow(),
  ): VoiceTurnEvent | null {
    const active = this.active;
    if (!active) return null;
    const timestampMs = Number.isFinite(atMs) && atMs >= 0 ? atMs : this.safeNow();
    active.sequence += 1;
    const event = this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'interruption',
      turnId: active.turnId,
      sequence: active.sequence,
      emittedAt: new Date(timestampMs).toISOString(),
      reason,
    });
    this.active = null;
    return event;
  }

  /** Terminal adapter/executor failure for the active turn. */
  error(input: { code: string; message: string; retryable: boolean }): VoiceTurnEvent | null {
    const active = this.active;
    const code = normalizeText(input.code, 200);
    const message = normalizeText(input.message, 4_000);
    if (!active || !code || !message) return null;
    const nowMs = this.safeNow();
    active.sequence += 1;
    const event = this.publish({
      version: VOICE_PROTOCOL_VERSION,
      type: 'error',
      turnId: active.turnId,
      sequence: active.sequence,
      emittedAt: new Date(nowMs).toISOString(),
      code,
      message,
      retryable: input.retryable,
    });
    this.active = null;
    return event;
  }

  private safeNow(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private publish(candidate: VoiceTurnEvent): VoiceTurnEvent | null {
    const event = parseVoiceTurnEvent(candidate);
    if (!event) return null;
    try {
      this.deps.emit(event);
    } catch {
      // Contract telemetry must never break the transport it observes.
    }
    return event;
  }
}

export function createPapercupVoiceTurnAdapter(
  deps: PapercupVoiceTurnAdapterDeps,
): PapercupVoiceTurnAdapter {
  return new PapercupVoiceTurnAdapter(deps);
}
