/**
 * D2 (unit) — coord_thread_posts projection: validation + key + provenance stamping.
 *
 * coord-thread-post.ts had ZERO isolated coverage (it was only exercised
 * transitively through the coord-thread unit test's decode + the federation
 * integration suites). This file pins:
 *   - `isCoordThreadPostRow` accepts a well-formed post and rejects malformed
 *     body / author_id / thread_id / post_msg_id / created_at / harness_slug.
 *   - `composeKey` → `post_msg_id` (the per-harness Hyperbee key; the bigserial
 *     `id` is machine-local and never the key).
 *   - `writeToPg` stamps the provenance trio (fed_ts / origin / author_pubkey)
 *     into the bound INSERT params, and defaults `fed_ts` to `created_at` when no
 *     provenance ts is supplied (the `provenance?.ts ?? row.created_at ?? null`
 *     fallback unique to this projection).
 *
 * Pure unit — a capturing tagged-template SQL spy records the bound params; no PG.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  buildCoordThreadPostProjection,
  isCoordThreadPostRow,
  _testing,
  type CoordThreadPostRow,
} from '../coord-thread-post';

const post: CoordThreadPostRow = {
  harness_slug: 'papercup',
  post_msg_id: 'mq01-0000-abc',
  thread_id: 'thr-conv-1',
  author_id: 'su-2',
  body: 'a reply',
  created_at: 1_700_000_050_000,
};

/** A tagged-template SQL spy that records the interpolated VALUES of every call.
 *  The projection writers call it as ``sql`INSERT ... ${v1} ... ${v2}` ``; we
 *  capture `values` so the test can assert what got stamped without a DB. The
 *  nested `to_timestamp` fragment is itself a `sql\`...\`` call, so this spy must
 *  return a benign marker for nested calls (postgres-js fragments) while still
 *  recording the TOP-LEVEL call's values. */
function makeCapturingSql(): { sql: postgres.Sql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve([]);
  }) as unknown as postgres.Sql;
  return { sql: fn, calls };
}

describe('D2 — isCoordThreadPostRow validation', () => {
  it('accepts a well-formed post', () => {
    expect(isCoordThreadPostRow(post)).toBe(true);
    expect(_testing.decodeValue(post)).toEqual(post);
  });

  it('accepts a null author_id (a substrate/system post)', () => {
    expect(isCoordThreadPostRow({ ...post, author_id: null })).toBe(true);
  });

  it('accepts an empty-string body (an empty post is a valid post)', () => {
    expect(isCoordThreadPostRow({ ...post, body: '' })).toBe(true);
  });

  it('rejects a non-string body', () => {
    expect(isCoordThreadPostRow({ ...post, body: 5 })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, body: null })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, body: undefined })).toBe(false);
  });

  it('rejects a non-string, non-null author_id', () => {
    expect(isCoordThreadPostRow({ ...post, author_id: 7 })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, author_id: {} })).toBe(false);
  });

  it('rejects empty / missing post_msg_id, thread_id, harness_slug', () => {
    expect(isCoordThreadPostRow({ ...post, post_msg_id: '' })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, thread_id: '' })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, harness_slug: '' })).toBe(false);
  });

  it('rejects a non-finite / non-number created_at', () => {
    expect(isCoordThreadPostRow({ ...post, created_at: 'x' })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, created_at: NaN })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, created_at: Infinity })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isCoordThreadPostRow(null)).toBe(false);
    expect(isCoordThreadPostRow('a-string')).toBe(false);
    expect(_testing.decodeValue(42)).toBeNull();
  });
});

describe('D2 — composeKey is the post_msg_id (not the local bigserial id)', () => {
  it('keys on post_msg_id', () => {
    expect(_testing.composeKey(post)).toBe('mq01-0000-abc');
    const p = buildCoordThreadPostProjection({ workspaceId: 'w', harnessSlug: 'papercup' });
    expect(p.composeKey(post)).toBe('mq01-0000-abc');
  });

  it('the projection sets skipOwnOps (EI-117 CDC echo breaker) + the coord-thread-posts tag', () => {
    const p = buildCoordThreadPostProjection({ workspaceId: 'w', harnessSlug: 'papercup' });
    expect(p.tableTag).toBe('coord-thread-posts');
    expect(p.skipOwnOps).toBe(true);
  });
});

describe('D2 — writeToPg stamps the provenance trio into the INSERT', () => {
  it('stamps fed_ts / origin / author_pubkey from the provenance context', async () => {
    const { sql, calls } = makeCapturingSql();
    const p = buildCoordThreadPostProjection({ workspaceId: 'ws-1', harnessSlug: 'papercup', sql });
    await p.writeToPg(post, { authorPubkey: 'pub-aa', origin: 'remote', ts: 9_999 });
    expect(calls).toHaveLength(1);
    const values = calls[0];
    // The bound VALUES include the provenance trio (origin / author_pubkey / fed_ts).
    expect(values).toContain('remote'); // origin
    expect(values).toContain('pub-aa'); // author_pubkey
    expect(values).toContain(9_999); // fed_ts (explicit provenance ts wins)
    // …and the federated content.
    expect(values).toContain('papercup');
    expect(values).toContain('thr-conv-1');
    expect(values).toContain('mq01-0000-abc');
    expect(values).toContain('a reply');
    expect(values).toContain('ws-1'); // bound workspace_id (NOT federated)
  });

  it('defaults fed_ts to created_at when the provenance ts is absent', async () => {
    const { sql, calls } = makeCapturingSql();
    const p = buildCoordThreadPostProjection({ workspaceId: 'ws-1', harnessSlug: 'papercup', sql });
    // Provenance present but ts undefined → fed_ts falls back to row.created_at.
    await p.writeToPg(post, { authorPubkey: 'pub-bb', origin: 'local' });
    expect(calls[0]).toContain(post.created_at); // fed_ts === created_at fallback
  });

  it('defaults origin=local + author_pubkey=null when NO provenance is supplied', async () => {
    const { sql, calls } = makeCapturingSql();
    const p = buildCoordThreadPostProjection({ workspaceId: 'ws-1', harnessSlug: 'papercup', sql });
    await p.writeToPg(post);
    const values = calls[0];
    expect(values).toContain('local'); // default origin
    expect(values).toContain(null); // default author_pubkey
    expect(values).toContain(post.created_at); // fed_ts fallback
  });

  it('does NOT write when the row is for a different harness (per-harness demux guard)', async () => {
    const { sql, calls } = makeCapturingSql();
    const p = buildCoordThreadPostProjection({ workspaceId: 'ws-1', harnessSlug: 'OTHER-harness', sql });
    await p.writeToPg(post, { authorPubkey: 'x', origin: 'remote', ts: 1 });
    expect(calls).toHaveLength(0); // guarded out before touching sql
  });
});
