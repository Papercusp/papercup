/**
 * thread.test.ts — foldThread reconstructs a message thread from a flat envelope
 * set by walking the related_msg_id chain in BOTH directions. A bug either drops
 * replies (incomplete thread) or pulls in unrelated messages. Pinned: transitive
 * chains, walking from any member (root or leaf), exclusion of unrelated
 * envelopes, fan-out replies to one root, and ascending (ts, msg_id) ordering.
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/thread.test.ts
 */
import { describe, expect, it } from 'vitest';
import { foldThread } from './thread';
import type { CoordEnvelope } from './envelope';

const env = (msg_id: string, related_msg_id: string | null, ts: string): CoordEnvelope =>
  ({ msg_id, related_msg_id, ts }) as unknown as CoordEnvelope;

const ids = (xs: CoordEnvelope[]) => xs.map((x) => x.msg_id);

describe('foldThread', () => {
  it('returns just the root when nothing relates to it', () => {
    const all = [env('a', null, '2026-01-01T00:00:00Z'), env('z', null, '2026-01-01T00:00:01Z')];
    expect(ids(foldThread(all, 'a'))).toEqual(['a']);
  });

  it('collects a transitive chain a→b→c when walking from the root', () => {
    const all = [
      env('a', null, '2026-01-01T00:00:00Z'),
      env('b', 'a', '2026-01-01T00:00:01Z'),
      env('c', 'b', '2026-01-01T00:00:02Z'),
    ];
    expect(ids(foldThread(all, 'a'))).toEqual(['a', 'b', 'c']);
  });

  it('walks UP the chain when starting from a leaf', () => {
    const all = [
      env('a', null, '2026-01-01T00:00:00Z'),
      env('b', 'a', '2026-01-01T00:00:01Z'),
      env('c', 'b', '2026-01-01T00:00:02Z'),
    ];
    expect(ids(foldThread(all, 'c'))).toEqual(['a', 'b', 'c']);
  });

  it('excludes envelopes not connected to the thread', () => {
    const all = [
      env('a', null, '2026-01-01T00:00:00Z'),
      env('b', 'a', '2026-01-01T00:00:01Z'),
      env('x', null, '2026-01-01T00:00:02Z'), // unrelated
      env('y', 'x', '2026-01-01T00:00:03Z'), // unrelated chain
    ];
    expect(ids(foldThread(all, 'a'))).toEqual(['a', 'b']);
  });

  it('gathers fan-out replies that all point at the root', () => {
    const all = [
      env('root', null, '2026-01-01T00:00:00Z'),
      env('r1', 'root', '2026-01-01T00:00:01Z'),
      env('r2', 'root', '2026-01-01T00:00:02Z'),
    ];
    expect(ids(foldThread(all, 'r1')).sort()).toEqual(['r1', 'r2', 'root']);
  });

  it('sorts the thread ascending by (ts, msg_id) regardless of input order', () => {
    const all = [
      env('c', 'b', '2026-01-01T00:00:03Z'),
      env('a', null, '2026-01-01T00:00:01Z'),
      env('b', 'a', '2026-01-01T00:00:02Z'),
    ];
    expect(ids(foldThread(all, 'a'))).toEqual(['a', 'b', 'c']);
  });
});
