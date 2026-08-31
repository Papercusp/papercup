/**
 * session-turn-index tests (chat-popup-turn-rail-2026-08-31 P-001, P-006).
 *
 * The rail is a NAVIGATION surface, so the cases carrying the most weight are
 * the ones where a wrong answer scrolls the reader somewhere they did not ask
 * for: which message a click lands on, and which row is marked live for a given
 * scroll position.
 *
 * Two properties get asserted hardest because they are the owner's actual ask:
 * a click lands on the ANSWER (never the question), and the answer chosen is the
 * turn's FINAL response rather than whichever assistant row happened to come
 * first. `answerIndex === null` is a first-class outcome (a turn still in
 * flight, or two questions in a row) and is asserted explicitly rather than
 * inferred from a fallback.
 */

import { describe, it, expect } from 'vitest';
import { deriveSessionTurns, turnAtMessageIndex, turnSizeRatios } from './session-turn-index';
import type { ChatMessage } from './chat-types';

const T0 = Date.parse('2026-08-31T09:14:00.000Z');
const iso = (msAfter: number) => new Date(T0 + msAfter).toISOString();

function user(content: string, ts?: string): ChatMessage {
  return { role: 'user', content, ...(ts ? { ts } : {}) };
}
function agent(content: string, opts: { tools?: string[]; ts?: string } = {}): ChatMessage {
  return {
    role: 'assistant',
    content,
    ...(opts.tools ? { tools: opts.tools.map((name) => ({ name })) } : {}),
    ...(opts.ts ? { ts: opts.ts } : {}),
  };
}

/** Two complete turns, the shape the popup renders for a real session. */
const TWO_TURNS: ChatMessage[] = [
  user('why is the gate red', iso(0)),
  agent('Not your change.', { tools: ['state:read', 'capability:git'], ts: iso(130_000) }),
  user('fix it then', iso(180_000)),
  agent('Both green.', { tools: ['testing:run'], ts: iso(580_000) }),
];

describe('deriveSessionTurns', () => {
  it('opens one turn per user message and numbers them from 1', () => {
    const turns = deriveSessionTurns(TWO_TURNS);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(turns.map((t) => t.question)).toEqual(['why is the gate red', 'fix it then']);
    expect(turns.map((t) => t.questionIndex)).toEqual([0, 2]);
  });

  it('points the jump at the ANSWER, not the question', () => {
    const turns = deriveSessionTurns(TWO_TURNS);
    expect(turns.map((t) => t.answerIndex)).toEqual([1, 3]);
    expect(turns.map((t) => t.jumpIndex)).toEqual([1, 3]);
    // The whole point of the feature: never the question index.
    turns.forEach((t) => expect(t.jumpIndex).not.toBe(t.questionIndex));
  });

  it('chooses the LAST non-empty assistant message as the answer', () => {
    const turns = deriveSessionTurns([
      user('do the thing'),
      agent('working on it'),
      agent('', { tools: ['Edit'] }),
      agent('Done — three files changed.'),
    ]);
    expect(turns[0].answerIndex).toBe(3);
    expect(turns[0].jumpIndex).toBe(3);
  });

  it('skips empty assistant messages when picking the answer', () => {
    const turns = deriveSessionTurns([user('go'), agent('the reply'), agent('   ')]);
    expect(turns[0].answerIndex).toBe(1);
  });

  it('treats a report card as an answer even with no text', () => {
    const withReport: ChatMessage = {
      role: 'assistant',
      content: '',
      /* A minimal stand-in, cast through `unknown`: the assertion is about the
         derivation treating a report-bearing message as an answer, not about
         ReportBlock's own shape — building a full one here would couple this
         test to a type it does not exercise. */
      report: { kind: 'status', title: 'Fleet status' } as unknown as ChatMessage['report'],
    };
    const turns = deriveSessionTurns([user('status?'), withReport]);
    expect(turns[0].answerIndex).toBe(1);
  });

  it('reports answerIndex null — and falls the jump back to the question — for a turn still in flight', () => {
    const turns = deriveSessionTurns([...TWO_TURNS, user('ship it', iso(600_000))]);
    expect(turns).toHaveLength(3);
    expect(turns[2].answerIndex).toBeNull();
    expect(turns[2].jumpIndex).toBe(4);
    expect(turns[2].questionIndex).toBe(4);
  });

  it('gives two consecutive questions their own turns, the first unanswered', () => {
    const turns = deriveSessionTurns([user('first'), user('second'), agent('one reply')]);
    expect(turns).toHaveLength(2);
    expect(turns[0].answerIndex).toBeNull();
    expect(turns[0].lastIndex).toBe(0);
    expect(turns[1].answerIndex).toBe(2);
  });

  it('sums tool chips across every assistant message in the turn', () => {
    const turns = deriveSessionTurns([
      user('big one'),
      agent('', { tools: ['a', 'b', 'c'] }),
      agent('done', { tools: ['d'] }),
    ]);
    expect(turns[0].toolCount).toBe(4);
  });

  it('ignores messages before the first question rather than inventing a turn 0', () => {
    const turns = deriveSessionTurns([agent('I woke up on a loop fire'), user('hello'), agent('hi')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].firstIndex).toBe(1);
    expect(turns[0].lastIndex).toBe(2);
  });

  it('returns no turns for an empty or answer-only transcript', () => {
    expect(deriveSessionTurns([])).toEqual([]);
    expect(deriveSessionTurns([agent('nothing was asked')])).toEqual([]);
  });

  it('measures duration only when both ends carry a stamp', () => {
    const turns = deriveSessionTurns(TWO_TURNS);
    expect(turns[0].durationMs).toBe(130_000);
    expect(turns[1].durationMs).toBe(400_000);
  });

  it('reports a null duration rather than a zero when a stamp is missing', () => {
    const noStamps = deriveSessionTurns([user('q'), agent('a')]);
    expect(noStamps[0].durationMs).toBeNull();
    const halfStamped = deriveSessionTurns([user('q', iso(0)), agent('a')]);
    expect(halfStamped[0].durationMs).toBeNull();
  });

  it('declines an unparseable or backwards stamp instead of reporting a negative duration', () => {
    expect(deriveSessionTurns([user('q', 'not a date'), agent('a', { ts: iso(0) })])[0].durationMs).toBeNull();
    const backwards = deriveSessionTurns([user('q', iso(500)), agent('a', { ts: iso(0) })]);
    expect(backwards[0].durationMs).toBeNull();
  });

  it('covers a contiguous index range per turn, so nothing on screen is unowned', () => {
    const turns = deriveSessionTurns(TWO_TURNS);
    expect(turns[0].lastIndex + 1).toBe(turns[1].firstIndex);
    expect(turns[turns.length - 1].lastIndex).toBe(TWO_TURNS.length - 1);
  });
});

describe('turnAtMessageIndex', () => {
  const turns = deriveSessionTurns(TWO_TURNS);

  it('maps every message in a turn back to that turn', () => {
    expect(turnAtMessageIndex(turns, 0)).toBe(0);
    expect(turnAtMessageIndex(turns, 1)).toBe(0);
    expect(turnAtMessageIndex(turns, 2)).toBe(1);
    expect(turnAtMessageIndex(turns, 3)).toBe(1);
  });

  it('returns -1 above the first question rather than guessing at row 0', () => {
    const late = deriveSessionTurns([agent('preamble'), user('q'), agent('a')]);
    expect(turnAtMessageIndex(late, 0)).toBe(-1);
    expect(turnAtMessageIndex(late, 1)).toBe(0);
  });

  it('returns -1 for an out-of-range or negative index', () => {
    expect(turnAtMessageIndex(turns, -1)).toBe(-1);
    expect(turnAtMessageIndex(turns, 99)).toBe(-1);
    expect(turnAtMessageIndex([], 0)).toBe(-1);
  });
});

describe('turnSizeRatios', () => {
  it('scales tick heights against the largest turn in the session', () => {
    const turns = deriveSessionTurns([
      user('short'),
      agent('a'),
      user('long'),
      agent(''),
      agent(''),
      agent('b'),
    ]);
    expect(turnSizeRatios(turns)).toEqual([0.5, 1]);
  });

  it('never divides by zero on an empty session', () => {
    expect(turnSizeRatios([])).toEqual([]);
  });
});
