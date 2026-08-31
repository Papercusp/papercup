import { describe, expect, it, vi } from 'vitest';
import type { VoiceTurnEvent } from '@papercusp/chat-protocol';
import { createPapercupVoiceTurnAdapter } from './papercup-voice-turn-adapter';

describe('PapercupVoiceTurnAdapter', () => {
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
