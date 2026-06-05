import { describe, expect, it } from 'vitest';
import {
  mayAskActiveNow,
  sayContainsWantActive,
  userDismissesOperator,
  userReplyDeclinesActive,
} from './OperatorConversationProvider';

describe('userDismissesOperator', () => {
  it.each([
    'shut up',
    'leave me alone',
    'stop talking',
    'stop asking',
    'ease off',
    'be quiet',
    'go quiet',
    "i'm busy",
    'I am busy',
    'let me think',
    'let me work',
    'let me focus',
    'i need quiet',
    'i need silence',
    "you're talking too much",
    'too much talking',
  ])('matches dismissal: %s', (s) => expect(userDismissesOperator(s)).toBe(true));

  it.each([
    'stop sharing that screen',
    'busy day today',
    'thinking about it',
    'quiet morning',
    'how do I focus on the right thing?',
    "I'm busy with the worker right now, can you check on it?", // C2: long context, has '?'
    'are you busy with that?',                                    // C2: question
    'let me think — what are the options?',                       // C2: question
    'when I said let me think I meant about the auth flow not generally', // C2: phrase deep in long sentence
  ])('does NOT match conversational/incidental: %s', (s) =>
    expect(userDismissesOperator(s)).toBe(false),
  );

  it.each([
    'ok, leave me alone',     // preamble allowed
    'hey, shut up',           // preamble allowed
    'wait — be quiet',        // preamble allowed
    'i need quiet for a sec', // short message
  ])('matches with brief preamble or short message: %s', (s) =>
    expect(userDismissesOperator(s)).toBe(true),
  );
});

describe('sayContainsWantActive', () => {
  it.each([
    'Want me back to active mode?',
    'Want me back active?',
    'Do you want to go back into active mode?',
  ])('matches: %s', (s) => expect(sayContainsWantActive(s)).toBe(true));

  it.each([
    'How are you?',
    'I will stay active.',
    'Active and listening.',
  ])('does not match unrelated say: %s', (s) =>
    expect(sayContainsWantActive(s)).toBe(false),
  );
});

describe('userReplyDeclinesActive', () => {
  it.each([
    'no',
    'No.',
    'nah',
    'nope',
    'not yet',
    'not now',
    'not really',
    'keep quiet',
    'keep it quiet',
    'keep passive',
    'stay passive',
    'stay quiet',
    'leave it',
  ])('matches decline: %s', (s) => expect(userReplyDeclinesActive(s)).toBe(true));

  it.each([
    'yes',
    'sure',
    'go for it',
    'okay',
    'go active',
    'wake up',
    "let's do it",
    'maybe later', // intentionally NOT matched (heuristic is conservative; "later" alone is ambiguous)
  ])('does not match: %s', (s) => expect(userReplyDeclinesActive(s)).toBe(false));
});

// Synthesize the State shape inline — keep this test independent of the
// provider's internal types in case the State interface gains fields.
type S = Parameters<typeof mayAskActiveNow>[0];
const NOW = 1_000_000_000;

function makeState(overrides: Partial<S> = {}): S {
  return {
    mode: 'passive',
    sub: 'passive_idle',
    messages: [],
    error: null,
    recentUserTurnTsMs: [NOW - 90_000, NOW - 60_000, NOW - 30_000], // 3 in last 2min
    wantActiveAskedAtMs: 0,
    wantActiveDeclinedAtMs: 0,
    userTurnsSinceDecline: 0,
    ...(overrides as object),
  } as S;
}

describe('mayAskActiveNow', () => {
  it('false in active mode', () => {
    expect(mayAskActiveNow(makeState({ mode: 'active' }), NOW)).toBe(false);
  });

  it('true with 3 user turns in 2min and no decline yet', () => {
    expect(mayAskActiveNow(makeState(), NOW)).toBe(true);
  });

  it('false when fewer than 3 user turns in window', () => {
    expect(
      mayAskActiveNow(makeState({ recentUserTurnTsMs: [NOW - 10_000, NOW - 5_000] }), NOW),
    ).toBe(false);
  });

  it('false right after a decline (within 10min cooldown, <5 user turns)', () => {
    expect(
      mayAskActiveNow(
        makeState({
          wantActiveDeclinedAtMs: NOW - 60_000,
          userTurnsSinceDecline: 3,
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it('true once 5 user turns have happened since the decline (cooldown lifted by turns)', () => {
    expect(
      mayAskActiveNow(
        makeState({
          wantActiveDeclinedAtMs: NOW - 60_000,
          userTurnsSinceDecline: 5,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it('true once 10 minutes have passed since decline (cooldown lifted by time)', () => {
    expect(
      mayAskActiveNow(
        makeState({
          wantActiveDeclinedAtMs: NOW - (10 * 60 * 1000 + 1),
          userTurnsSinceDecline: 0,
        }),
        NOW,
      ),
    ).toBe(true);
  });
});
