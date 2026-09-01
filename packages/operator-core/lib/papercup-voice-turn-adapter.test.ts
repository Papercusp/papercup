import { describe, expect, it, vi } from 'vitest';
import {
  VOICE_PROTOCOL_VERSION,
  type VoiceExecutorRequest,
  type VoiceTurnEvent,
} from '@papercusp/chat-protocol';
import {
  PAPERCUP_DEEP_EXECUTOR_ID,
  PapercupDeepVoiceExecutor,
  createPapercupVoiceTurnAdapter,
} from './papercup-voice-turn-adapter';

function deepRequest(): VoiceExecutorRequest<{ vault: 'fresh' }> {
  return {
    turn: {
      version: VOICE_PROTOCOL_VERSION,
      turnId: 'turn-deep-1',
      sequence: 7,
      occurredAt: '2026-08-31T18:00:00.000Z',
      transport: 'papercup-local',
      latencyClass: 'deliberative',
      transcript: 'Use my context to answer this.',
      conversation: {
        kind: 'operator',
        id: 'operator-conversation-1',
        parentOperatorConversationId: null,
      },
      principal: {
        kind: 'owner',
        subjectId: 'owner-1',
        authenticated: true,
        authoritySource: 'owner-session',
      },
      capabilities: {
        read: ['conversation-history', 'personal-memory'],
        write: ['conversation-turn'],
        tools: ['personal:search'],
      },
    },
    context: { vault: 'fresh' },
  };
}

describe('PapercupVoiceTurnAdapter', () => {
  it('delegates a server-routed deep turn to the shared immutable executor session', () => {
    let now = Date.parse('2026-08-31T18:00:00.000Z');
    const events: VoiceTurnEvent[] = [];
    const request = deepRequest();
    const executor = new PapercupDeepVoiceExecutor<{ vault: 'fresh' }>({ now: () => now });
    const adapter = createPapercupVoiceTurnAdapter({
      executor,
      now: () => now,
      emit: (event) => { events.push(event); },
    });

    expect(executor.descriptor).toEqual({
      id: PAPERCUP_DEEP_EXECUTOR_ID,
      latencyClass: 'deliberative',
      delivery: 'deliberative',
    });
    expect(adapter.beginExecutorTurn(request)).toMatchObject({
      type: 'transcript.final',
      turnId: 'turn-deep-1',
      sequence: 0,
    });

    // Mutating the caller-owned object after dispatch cannot widen what the
    // deep executor sees; the shared session owns a frozen canonical snapshot.
    request.turn.capabilities.tools.push('untrusted:late-widening');
    expect(adapter.activeRequest?.turn.capabilities.tools).toEqual(['personal:search']);
    expect(Object.isFrozen(adapter.activeRequest?.turn.capabilities.tools)).toBe(true);

    now += 180;
    adapter.assistantSentence('Here is the context-aware answer.');
    now += 320;
    expect(adapter.complete()).toMatchObject({
      type: 'completed',
      metrics: {
        executor: PAPERCUP_DEEP_EXECUTOR_ID,
        latencyClass: 'deliberative',
        firstSentenceMs: 180,
        totalMs: 500,
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      'transcript.final', 'assistant.sentence', 'completed',
    ]);
    expect(adapter.complete()).toBeNull();
  });

  it('refuses to run an interactive request through the deliberative deep executor', () => {
    const events: VoiceTurnEvent[] = [];
    const request = deepRequest();
    request.turn.latencyClass = 'interactive';
    const adapter = createPapercupVoiceTurnAdapter({
      emit: (event) => { events.push(event); },
    });

    expect(adapter.beginExecutorTurn(request)).toBeNull();
    expect(adapter.activeTurnId).toBeNull();
    expect(events).toEqual([]);
  });

  it('normalizes a transcript/sentence and emits measured canonical completion', () => {
    let now = Date.parse('2026-08-31T16:00:00.000Z');
    const events: VoiceTurnEvent[] = [];
    const adapter = createPapercupVoiceTurnAdapter({
      emit: (event) => events.push(event),
      now: () => now,
      createTurnId: () => 'turn-local-1',
    });

    adapter.finalTranscript({
      text: '  What   is\nnext?  ',
      transport: 'papercup-local',
      latencyClass: 'deliberative',
      executor: 'papercup-deep',
    });
    now += 420;
    adapter.assistantSentence('  Here   is the answer. ');
    now += 830;
    adapter.complete();

    expect(events).toEqual([
      expect.objectContaining({
        type: 'transcript.final', turnId: 'turn-local-1', sequence: 0, text: 'What is next?',
      }),
      expect.objectContaining({
        type: 'assistant.sentence', turnId: 'turn-local-1', sequence: 1,
        text: 'Here is the answer.', sentenceIndex: 0,
      }),
      expect.objectContaining({
        type: 'completed', turnId: 'turn-local-1', sequence: 2,
        metrics: {
          executor: 'papercup-deep', latencyClass: 'deliberative',
          firstSentenceMs: 420, totalMs: 1_250,
        },
      }),
    ]);
    expect(adapter.activeTurnId).toBeNull();
  });

  it('records user barge-in before beginning the replacement turn', () => {
    let ordinal = 0;
    const events: VoiceTurnEvent[] = [];
    const adapter = createPapercupVoiceTurnAdapter({
      emit: (event) => events.push(event),
      now: () => Date.parse('2026-08-31T16:01:00.000Z'),
      createTurnId: () => `turn-${++ordinal}`,
    });

    const start = (text: string) => adapter.finalTranscript({
      text,
      transport: 'papercup-hosted',
      latencyClass: 'interactive',
      executor: 'papercup-hosted',
    });
    start('first question');
    adapter.assistantSentence('First answer starts.');
    start('actually, another question');

    expect(events.map((event) => event.type)).toEqual([
      'transcript.final', 'assistant.sentence', 'interruption', 'transcript.final',
    ]);
    expect(events[2]).toMatchObject({ turnId: 'turn-1', sequence: 2, reason: 'user' });
    expect(events[3]).toMatchObject({ turnId: 'turn-2', sequence: 0 });
  });

  it('emits terminal error/interruption events and ignores invalid or orphaned output', () => {
    const emit = vi.fn<(event: VoiceTurnEvent) => void>();
    const adapter = createPapercupVoiceTurnAdapter({ emit, createTurnId: () => 'turn-error' });

    expect(adapter.assistantSentence('orphan')).toBeNull();
    expect(adapter.finalTranscript({
      text: '   ', transport: 'papercup-local', latencyClass: 'interactive', executor: 'local',
    })).toBeNull();
    adapter.finalTranscript({
      text: 'hello', transport: 'papercup-local', latencyClass: 'interactive', executor: 'local',
    });
    adapter.error({ code: 'tts_unavailable', message: 'No TTS engine.', retryable: true });
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['transcript.final', 'error']);
    expect(adapter.complete()).toBeNull();

    adapter.finalTranscript({
      text: 'again', transport: 'papercup-local', latencyClass: 'interactive', executor: 'local',
    });
    adapter.interrupt('policy');
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'interruption', reason: 'policy' });
  });

  it('does not let a failing telemetry sink break the voice lifecycle', () => {
    const adapter = createPapercupVoiceTurnAdapter({
      emit: () => { throw new Error('telemetry unavailable'); },
      createTurnId: () => 'turn-safe',
    });
    expect(() => {
      adapter.finalTranscript({
        text: 'hello', transport: 'papercup-local', latencyClass: 'interactive', executor: 'local',
      });
      adapter.assistantSentence('hi');
      adapter.complete();
    }).not.toThrow();
    expect(adapter.activeTurnId).toBeNull();
  });
});
