/**
 * envelope.test.ts — the coordination ordering foundation. EVERY coord surface
 * sorts by compareByTsThenId, so its (ts, then msg_id) tiebreak must be exact; and
 * newMsgId must be lex-monotonic even for ids minted in the same millisecond (the
 * intra-ms seq counter) — otherwise a same-ms batch sorts nondeterministically and
 * thread/plan-event reads flap.
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/envelope.test.ts
 */
import { describe, expect, it } from 'vitest';
import { compareByTsThenId, newMsgId } from './envelope';
import type { CoordEnvelope } from './envelope';

const e = (ts: string, msg_id: string): CoordEnvelope => ({ ts, msg_id }) as unknown as CoordEnvelope;

describe('compareByTsThenId', () => {
  it('orders by ts first', () => {
    expect(compareByTsThenId(e('2026-01-01T00:00:01Z', 'z'), e('2026-01-01T00:00:02Z', 'a'))).toBeLessThan(0);
    expect(compareByTsThenId(e('2026-01-01T00:00:02Z', 'a'), e('2026-01-01T00:00:01Z', 'z'))).toBeGreaterThan(0);
  });

  it('breaks ties by msg_id', () => {
    expect(compareByTsThenId(e('t', 'a'), e('t', 'b'))).toBeLessThan(0);
    expect(compareByTsThenId(e('t', 'b'), e('t', 'a'))).toBeGreaterThan(0);
  });

  it('returns 0 for identical (ts, msg_id)', () => {
    expect(compareByTsThenId(e('t', 'x'), e('t', 'x'))).toBe(0);
  });

  it('sorts an array deterministically', () => {
    const arr = [e('t2', 'a'), e('t1', 'b'), e('t1', 'a')];
    expect(arr.slice().sort(compareByTsThenId).map((x) => `${x.ts}/${x.msg_id}`)).toEqual([
      't1/a',
      't1/b',
      't2/a',
    ]);
  });
});

describe('newMsgId', () => {
  it('has the <ms>-<seq>-<hex> three-part shape', () => {
    const parts = newMsgId().split('-');
    expect(parts).toHaveLength(3);
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/); // randomUUID, dashes stripped
  });

  it('is lex-monotonic and unique across a tight same-process burst (intra-ms seq)', () => {
    const ids = Array.from({ length: 100 }, () => newMsgId());
    // already-ascending: a plain lexical sort must be a no-op
    expect(ids.slice().sort()).toEqual(ids);
    // all unique
    expect(new Set(ids).size).toBe(ids.length);
  });
});
