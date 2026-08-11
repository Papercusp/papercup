/**
 * session-chat-popup-timestamps-and-modes-2026-08-09 P-002 — the sent-message
 * echo. The reported symptom was "I sent 'go' and nothing happened" against a
 * send that had in fact succeeded, because the popup renders only the agent's
 * transcript and a mid-turn coord injection never appears there as a prompt.
 *
 * The interesting half is ABSORPTION: a send to an IDLE agent DOES eventually
 * land as a real prompt, and an echo that fails to stand down at that moment
 * shows the owner their message twice — a worse bug than the one being fixed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat-types';
import {
  ECHO_ABSORB_SLACK_MS,
  PER_OWNER_CAP,
  __resetSentEchoes,
  getSentEchoes,
  mergeSentEchoes,
  recordSentEcho,
  settleSentEcho,
  type SentEcho,
} from './sent-message-echo';

const AT = new Date(2026, 7, 9, 23, 14, 0).getTime();
const echo = (over: Partial<SentEcho> = {}): SentEcho => ({
  id: 'echo-1',
  text: 'go',
  atMs: AT,
  delivery: 'sent',
  ...over,
});
/** A transcript turn as the mapper produces it. */
const turn = (role: ChatMessage['role'], content: string, tsMs?: number): ChatMessage => ({
  role,
  content,
  ...(tsMs === undefined ? {} : { ts: new Date(tsMs).toISOString() }),
});

beforeEach(() => __resetSentEchoes());

describe('mergeSentEchoes', () => {
  it('appends a sent message the transcript does not show — the reported bug', () => {
    const out = mergeSentEchoes([turn('assistant', 'working', AT - 60_000)], [echo()]);
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ['assistant', 'working'],
      ['user', 'go'],
    ]);
  });

  it('stamps the appended message so it carries a time like every other row (P-001)', () => {
    const out = mergeSentEchoes([], [echo()]);
    expect(out[0].ts).toBe(new Date(AT).toISOString());
  });

  it('ABSORBS the echo once the same message arrives in the transcript — never renders it twice', () => {
    // The idle-agent path: a coord:send with no tool_result blocks beside it
    // DOES surface as a real prompt, so the echo must stand down.
    const out = mergeSentEchoes([turn('user', 'go', AT + 2_000)], [echo()]);
    expect(out).toHaveLength(1);
  });

  it('absorbs across cross-machine clock skew, within the declared slack', () => {
    // The echo is stamped by this browser, the turn by the agent's host. A
    // strict >= would leave the message double-rendered whenever the agent's
    // clock trails ours.
    const justInside = mergeSentEchoes([turn('user', 'go', AT - (ECHO_ABSORB_SLACK_MS - 1_000))], [echo()]);
    expect(justInside).toHaveLength(1);

    // Far enough BEFORE the send that it must be a different, earlier message
    // that happened to say the same thing — so this send is still unshown.
    const wellBefore = mergeSentEchoes([turn('user', 'go', AT - 10 * 60_000)], [echo()]);
    expect(wellBefore).toHaveLength(2);
  });

  it('a transcript turn absorbs at most ONE echo, so sending the same text twice shows twice', () => {
    const twice = [echo({ id: 'echo-1' }), echo({ id: 'echo-2', atMs: AT + 1_000 })];
    const out = mergeSentEchoes([turn('user', 'go', AT + 2_000)], twice);
    // One landed and was absorbed; the other is still only known to this tab.
    expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('never absorbs against an ASSISTANT turn that happens to repeat the text', () => {
    const out = mergeSentEchoes([turn('assistant', 'go', AT + 1_000)], [echo()]);
    expect(out).toHaveLength(2);
  });

  it('absorbs against an UNDATED turn (a feed with no timestamps cannot disprove the match)', () => {
    const out = mergeSentEchoes([turn('user', 'go')], [echo()]);
    expect(out).toHaveLength(1);
  });

  it('DROPS a failed send rather than leaving it in the conversation', () => {
    // A message that never left must not sit in the transcript looking like part
    // of it — the composer's error banner is what reports the failure.
    const out = mergeSentEchoes([], [echo({ delivery: 'failed' })]);
    expect(out).toEqual([]);
  });

  it('shows a still-sending message immediately (the optimism this exists for)', () => {
    const out = mergeSentEchoes([], [echo({ delivery: 'sending' })]);
    expect(out.map((m) => m.content)).toEqual(['go']);
  });

  it('returns the ORIGINAL array untouched when there is nothing to add', () => {
    // Identity matters: `messages` feeds a useMemo whose consumer is the
    // virtualized, memoized transcript. A fresh array on every render would
    // defeat that for every session that never sends anything.
    const msgs = [turn('assistant', 'hi', AT)];
    expect(mergeSentEchoes(msgs, [])).toBe(msgs);
    expect(mergeSentEchoes(msgs, [echo({ delivery: 'failed' })])).toBe(msgs);
    expect(mergeSentEchoes(msgs, [echo({ text: 'hi' })])).not.toBe(msgs);
  });

  /**
   * EI-20130618357432548 — the guard this suite was missing, and the shape of the
   * bug the owner reported.
   *
   * Every absorption case above pairs an echo with a transcript turn whose text is
   * EXACTLY equal. The failure in the wild was the other shape: the message arrives
   * EMBEDDED in a larger machine envelope (a wake-pump `[await-event] …` blob that
   * quotes it), so absorption cannot fire — and the echo was then appended, landing
   * BELOW a reply that came 48 seconds after the send.
   *
   * The absorb miss is acceptable (it degrades to a duplicate). Its POSITION is not:
   * a message must never render below an answer to it.
   */
  it('a message quoted inside a larger envelope still renders in CHRONOLOGICAL order, not last', () => {
    const envelope =
      '⟦turn-origin:wake-pump nonce:abc123ef⟧ [await-event] coord:inbox-wake:su-1 fired — hi.';
    const out = mergeSentEchoes(
      [
        turn('user', envelope, AT + 1_000),
        turn('assistant', 'the reply, 48s after the send', AT + 48_000),
      ],
      [echo({ text: 'hi' })],
    );
    // Absorption legitimately misses (the texts are not equal) → a duplicate.
    expect(out.filter((m) => m.role === 'user' && m.content === 'hi')).toHaveLength(1);
    // …but it must NOT be last: the reply it preceded stays below it.
    expect(out[out.length - 1].content).toBe('the reply, 48s after the send');
  });

  it('still APPENDS when nothing in the transcript is later — the ordinary waiting-for-a-reply case', () => {
    const out = mergeSentEchoes(
      [turn('assistant', 'earlier', AT - 60_000), turn('user', 'also earlier', AT - 30_000)],
      [echo()],
    );
    expect(out[out.length - 1].content).toBe('go');
  });

  it('places an echo among several later messages at its own instant', () => {
    const out = mergeSentEchoes(
      [
        turn('assistant', 'before', AT - 10_000),
        turn('assistant', 'after-1', AT + 10_000),
        turn('assistant', 'after-2', AT + 20_000),
      ],
      [echo()],
    );
    expect(out.map((m) => m.content)).toEqual(['before', 'go', 'after-1', 'after-2']);
  });

  it('never hoists an echo above an UNDATED turn — an unknown instant cannot prove it came later', () => {
    // Byte-identical to the pre-fix append behavior for a feed with no timestamps.
    const out = mergeSentEchoes([turn('assistant', 'undated')], [echo()]);
    expect(out.map((m) => m.content)).toEqual(['undated', 'go']);
  });

  it('orders multiple pending echoes oldest-first', () => {
    const out = mergeSentEchoes(
      [],
      [echo({ id: 'b', text: 'second', atMs: AT + 5_000 }), echo({ id: 'a', text: 'first', atMs: AT })],
    );
    expect(out.map((m) => m.content)).toEqual(['first', 'second']);
  });
});

describe('the echo store', () => {
  it('records a send as pending and settles it', () => {
    const id = recordSentEcho('su-a', 'go');
    expect(mergeSentEchoes([], getSentEchoes('su-a'))).toHaveLength(1);
    settleSentEcho('su-a', id, 'failed');
    expect(mergeSentEchoes([], getSentEchoes('su-a'))).toHaveLength(0);
  });

  it('keeps echoes SEPARATE per agent — one popup never shows another agent’s sends', () => {
    recordSentEcho('su-a', 'for a');
    recordSentEcho('su-b', 'for b');
    expect(mergeSentEchoes([], getSentEchoes('su-a')).map((m) => m.content)).toEqual(['for a']);
    expect(mergeSentEchoes([], getSentEchoes('su-b')).map((m) => m.content)).toEqual(['for b']);
  });

  it('is BOUNDED — a long-lived tab cannot grow it without limit, and the NEWEST survive', () => {
    for (let i = 0; i < PER_OWNER_CAP + 10; i++) recordSentEcho('su-a', `msg-${i}`);
    const kept = getSentEchoes('su-a');
    expect(kept).toHaveLength(PER_OWNER_CAP);
    // Trimmed from the front: the recent sends are the ones you are looking for.
    expect(kept[kept.length - 1].text).toBe(`msg-${PER_OWNER_CAP + 9}`);
  });

  it('settling an unknown owner or id is a no-op rather than a throw', () => {
    expect(() => settleSentEcho('nobody', 'echo-999', 'sent')).not.toThrow();
    const id = recordSentEcho('su-a', 'go');
    expect(() => settleSentEcho('su-a', `${id}-nope`, 'sent')).not.toThrow();
  });
});

