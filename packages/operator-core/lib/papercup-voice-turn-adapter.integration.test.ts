/**
 * P-003 adapter fixture: both existing Papercup transport classes must produce
 * the same canonical event semantics without sharing their media lifecycle.
 */
import { describe, expect, it } from 'vitest';
import {
  VOICE_PROTOCOL_VERSION,
  parseVoiceTurnEventJson,
  serializeVoiceTurnEvent,
  type VoiceExecutorRequest,
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
  const request: VoiceExecutorRequest<{ source: 'server-vault' }> = {
    turn: {
      version: VOICE_PROTOCOL_VERSION,
      turnId: 'fixture-turn',
      sequence: 0,
      occurredAt: new Date(now).toISOString(),
      transport,
      latencyClass: 'deliberative',
      transcript: 'Where are we?',
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
    context: { source: 'server-vault' },
  };
  adapter.beginExecutorTurn(request);
  now += 75;
  adapter.assistantSentence('We are ready.');
  now += 25;
  adapter.complete();
  return events;
}

describe('Papercup local/hosted shared-executor fixture (VOICE-P007-papercup)', () => {
  it('normalizes both transports through one deep executor lifecycle', () => {
    const local = runFixture('papercup-local');
    const hosted = runFixture('papercup-hosted');

    expect(local.map((event) => event.type)).toEqual([
      'transcript.final', 'assistant.sentence', 'completed',
    ]);
    expect(hosted.map((event) => event.type)).toEqual(local.map((event) => event.type));
    expect(local.slice(0, 2)).toEqual(hosted.slice(0, 2));
    expect(local[2]).toMatchObject({
      type: 'completed',
      metrics: {
        executor: 'papercup-deep',
        latencyClass: 'deliberative',
        firstSentenceMs: 75,
        totalMs: 100,
      },
    });
    expect(hosted[2]).toEqual(local[2]);
  });
});
