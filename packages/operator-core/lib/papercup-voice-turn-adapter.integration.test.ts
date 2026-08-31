/**
 * P-003 adapter fixture: both existing Papercup transport classes must produce
 * the same canonical event semantics without sharing their media lifecycle.
 */
import { describe, expect, it } from 'vitest';
import {
  parseVoiceTurnEventJson,
  serializeVoiceTurnEvent,
  type VoiceTurnEvent,
} from '@papercusp/chat-protocol';
import {
  createPapercupVoiceTurnAdapter,
  type PapercupVoiceTransport,
} from './papercup-voice-turn-adapter';

function runFixture(transport: PapercupVoiceTransport): VoiceTurnEvent[] {
  let now = Date.parse('2026-08-31T17:00:00.000Z');
  const events: VoiceTurnEvent[] = [];
  const adapter = createPapercupVoiceTurnAdapter({
    now: () => now,
    createTurnId: () => 'fixture-turn',
    emit: (event) => {
      const roundTripped = parseVoiceTurnEventJson(serializeVoiceTurnEvent(event));
      if (!roundTripped) throw new Error('adapter emitted a non-canonical event');
      events.push(roundTripped);
    },
  });
  adapter.finalTranscript({
    text: 'Where are we?',
    transport,
    latencyClass: 'interactive',
    executor: transport,
  });
  now += 75;
  adapter.assistantSentence('We are ready.');
  now += 25;
  adapter.complete();
  return events;
}

describe('Papercup local/hosted canonical adapter fixture (VOICE-P003-papercup)', () => {
  it('normalizes both transports into the shared transcript/sentence/completion contract', () => {
    const local = runFixture('papercup-local');
    const hosted = runFixture('papercup-hosted');

    expect(local.map((event) => event.type)).toEqual([
      'transcript.final', 'assistant.sentence', 'completed',
    ]);
    expect(hosted.map((event) => event.type)).toEqual(local.map((event) => event.type));
    expect(local.slice(0, 2)).toEqual(hosted.slice(0, 2));
    expect(local[2]).toMatchObject({
      type: 'completed', metrics: { executor: 'papercup-local', firstSentenceMs: 75, totalMs: 100 },
    });
    expect(hosted[2]).toMatchObject({
      type: 'completed', metrics: { executor: 'papercup-hosted', firstSentenceMs: 75, totalMs: 100 },
    });
  });
});
