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
import {
  deriveSessionTurns,
  pickTopMessageIndex,
  resolveFocusPrecedence,
  turnAtInstant,
  turnAtMessageIndex,
  turnSizeRatios,
} from './session-turn-index';
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

/*
 * The two rules below had NO coverage until the independent acceptance grading
 * (EI-21986741094464185) found that their audit citations resolved to files
 * containing zero references to them. Both were inline in components; both are
 * now pure, which is what makes these assertions possible at all.
 */

describe('resolveFocusPrecedence (P-003 — a live gesture beats a stale anchor)', () => {
  it('lets the rail jump win over the URL search anchor', () => {
    const r = resolveFocusPrecedence({ jumpToIndex: 7, jumpNonce: 3, focusIndex: 2 });
    expect(r.railJumpActive).toBe(true);
    expect(r.focusIndex).toBe(7);
    expect(r.focusNonce).toBe(3);
  });

  it('THE REGRESSION: the anchor does not re-win on the click after the first', () => {
    // The bug this rule exists to stop. The URL anchor is set for the life of
    // the popup, so it is still 2 on every later click. If it ever re-won, the
    // rail would scroll to turn 2 no matter which row the reader pressed.
    const anchor = 2;
    for (const clicked of [5, 9, 0, 4]) {
      const r = resolveFocusPrecedence({ jumpToIndex: clicked, jumpNonce: 1, focusIndex: anchor });
      expect(r.focusIndex).toBe(clicked);
    }
  });

  it('falls back to the anchor only while no jump is active', () => {
    const r = resolveFocusPrecedence({ jumpToIndex: null, focusIndex: 2 });
    expect(r.railJumpActive).toBe(false);
    expect(r.focusIndex).toBe(2);
    // The nonce must go null too, or a stale one re-fires the previous jump.
    expect(r.focusNonce).toBeNull();
  });

  it('treats a negative jump index as no jump, not as index -1', () => {
    expect(resolveFocusPrecedence({ jumpToIndex: -1, focusIndex: 2 }).focusIndex).toBe(2);
  });

  it('suppresses the anchor on a projection, but never the rail jump', () => {
    // A projection's indices are not the anchor's indices, so honouring it
    // would scroll somewhere arbitrary. The rail's index IS projected-array
    // relative, so it stays valid.
    expect(resolveFocusPrecedence({ focusIndex: 2, projection: true }).focusIndex).toBeUndefined();
    expect(
      resolveFocusPrecedence({ jumpToIndex: 7, jumpNonce: 1, focusIndex: 2, projection: true })
        .focusIndex,
    ).toBe(7);
  });

  it('carries a missing nonce as null rather than undefined', () => {
    expect(resolveFocusPrecedence({ jumpToIndex: 4 }).focusNonce).toBeNull();
  });
});

describe('pickTopMessageIndex (P-005 — what makes the rail an indicator, not a menu)', () => {
  const rows = [
    { index: 0, top: -400 },
    { index: 1, top: -120 },
    { index: 2, top: 40 },
    { index: 3, top: 300 },
  ];

  it('reports the last row whose top edge has passed the probe', () => {
    expect(pickTopMessageIndex(rows, 32)).toBe(1);
  });

  it('follows the reader down the transcript', () => {
    expect(pickTopMessageIndex(rows, 320)).toBe(3);
  });

  it('clamps to the first rendered row instead of blanking the marker', () => {
    // Scrolled above everything rendered. -1 here would blank the live row at
    // the top of every transcript, which is the visible bug.
    expect(pickTopMessageIndex(rows, -500)).toBe(0);
  });

  it('clamps to the first RENDERED row, not row 0, when the top is virtualized away', () => {
    const windowed = [
      { index: 40, top: 500 },
      { index: 41, top: 760 },
    ];
    expect(pickTopMessageIndex(windowed, 32)).toBe(40);
  });

  it('is order-independent — the virtualizer does not guarantee DOM order', () => {
    expect(pickTopMessageIndex([...rows].reverse(), 32)).toBe(1);
  });

  it('ignores rows with an unparseable data-message-index', () => {
    const dirty = [{ index: Number.NaN, top: -900 }, ...rows];
    expect(pickTopMessageIndex(dirty, 32)).toBe(1);
  });

  it('returns -1 for an empty transcript', () => {
    expect(pickTopMessageIndex([], 32)).toBe(-1);
  });
});

/**
 * turnAtInstant — the "see where this was asked ↑" derivation (WI-7323 / D-007
 * step 5). The cases carrying the weight are the REFUSALS: the link is only
 * shippable because it can say "not here", and every -1 below is a transcript a
 * nearest-neighbour implementation would answer confidently and wrongly.
 */
describe('turnAtInstant', () => {
  const TURNS = deriveSessionTurns(TWO_TURNS);

  it('places an instant inside a turn on that turn', () => {
    expect(turnAtInstant(TURNS, iso(60_000))).toBe(0);
    expect(turnAtInstant(TURNS, iso(300_000))).toBe(1);
  });

  it('places an instant exactly on a question at that turn', () => {
    expect(turnAtInstant(TURNS, iso(0))).toBe(0);
    expect(turnAtInstant(TURNS, iso(180_000))).toBe(1);
  });

  it('refuses an instant BEFORE the first question — the ask predates this transcript', () => {
    // The carry-respawn case: the owner id survives a respawn, the transcript
    // does not. Clamping to turn 0 here IS the wrong-message failure.
    expect(turnAtInstant(TURNS, iso(-1))).toBe(-1);
    expect(turnAtInstant(TURNS, iso(-86_400_000))).toBe(-1);
  });

  it('refuses an instant after a SETTLED transcript — no turn was running', () => {
    // TWO_TURNS ends with an answer, so the session was idle at iso(580_001).
    expect(turnAtInstant(TURNS, iso(580_001))).toBe(-1);
    expect(turnAtInstant(TURNS, iso(9_000_000))).toBe(-1);
  });

  it('refuses after a transcript whose final answer exists but is UNSTAMPED', () => {
    // The distinction the component test caught (2026-09-04): `answeredAt` is
    // null here because the feed stamped nothing, NOT because the turn is still
    // running. Keying "settled" off `answeredAt` reads this as open-ended, and
    // then an ask filed hours later links to the last turn. `answerIndex` is
    // derived from the messages, so it cannot drift with the metadata.
    const unstampedAnswer = deriveSessionTurns([user('q', iso(0)), agent('a')]);
    expect(unstampedAnswer[0].answeredAt).toBeNull();
    expect(unstampedAnswer[0].answerIndex).toBe(1);
    expect(turnAtInstant(unstampedAnswer, iso(9_000_000))).toBe(-1);
    // …while an instant INSIDE its known span still resolves.
    expect(turnAtInstant(unstampedAnswer, iso(0))).toBe(0);
  });

  it('accepts an instant after the last question while that turn is STILL STREAMING', () => {
    // The live case the link exists for: the agent filed the ask mid-turn and
    // has not answered yet, so there is no answeredAt to bound against.
    const streaming = deriveSessionTurns([...TWO_TURNS, user('and now?', iso(700_000))]);
    expect(streaming[2].answeredAt).toBeNull();
    expect(turnAtInstant(streaming, iso(760_000))).toBe(2);
  });

  it('attaches a gap instant to the turn that was most recently running', () => {
    // Between turn 1's answer (130s) and turn 2's question (180s) the agent is
    // idle. Pinned rather than left to chance: an emission from that owner
    // originated in the turn that just ran, not in one not yet asked.
    expect(turnAtInstant(TURNS, iso(150_000))).toBe(0);
  });

  it('refuses a missing or unparseable stamp', () => {
    expect(turnAtInstant(TURNS, null)).toBe(-1);
    expect(turnAtInstant(TURNS, undefined)).toBe(-1);
    expect(turnAtInstant(TURNS, '')).toBe(-1);
    expect(turnAtInstant(TURNS, 'sometime last tuesday')).toBe(-1);
  });

  it('refuses every instant when the feed stamps no questions', () => {
    // A feed with no `ts` yields askedAt: null on every turn. The honest result
    // is no links at all, never links derived from position.
    const unstamped = deriveSessionTurns([user('a'), agent('b'), user('c'), agent('d')]);
    expect(unstamped).toHaveLength(2);
    expect(turnAtInstant(unstamped, iso(60_000))).toBe(-1);
  });

  it('refuses on an empty transcript', () => {
    expect(turnAtInstant([], iso(60_000))).toBe(-1);
  });

  it('PROBE', async () => {
    const { sessionTimelineToChatMessages } = await import('./session-transcript-mapping');
    const msgs = sessionTimelineToChatMessages([
      { kind: 'prompt', text: 'first question', ts: iso(0) },
      { kind: 'text', text: 'first answer', ts: iso(60_000) },
      { kind: 'prompt', text: 'second question', ts: iso(120_000) },
      { kind: 'text', text: 'second answer', ts: iso(180_000) },
    ] as never);
    const t = deriveSessionTurns(msgs);
    throw new Error(
      JSON.stringify({ msgs: msgs.map((m) => ({ r: m.role, ts: m.ts, c: m.content })), t }),
    );
  });
});
