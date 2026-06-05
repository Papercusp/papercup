/**
 * Unit tests for the coord_threads + coord_thread_posts projections (Track A,
 * distributed-coordination-shared-harness-2026-06-04). Pure — no PG.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCoordThreadProjection,
  isCoordThreadRow,
  _testing as threadT,
  type CoordThreadRow,
} from '../coord-thread';
import {
  buildCoordThreadPostProjection,
  isCoordThreadPostRow,
  _testing as postT,
  type CoordThreadPostRow,
} from '../coord-thread-post';

const thread: CoordThreadRow = {
  harness_slug: 'papercup',
  thread_id: 'thr-conv-1',
  parent_kind: 'conversation',
  parent_ref: 'conv-1',
  title: 'Q1',
  created_by: 'su-1',
  created_at: 1_700_000_000_000,
  last_post_at: 1_700_000_100_000,
  post_count: 2,
};

const post: CoordThreadPostRow = {
  harness_slug: 'papercup',
  post_msg_id: 'mq01-0000-abc',
  thread_id: 'thr-conv-1',
  author_id: 'su-2',
  body: 'a reply',
  created_at: 1_700_000_050_000,
};

describe('coord-thread projection', () => {
  it('exposes the registered tableTag + keys on thread_id', () => {
    expect(buildCoordThreadProjection({ workspaceId: 'w', harnessSlug: 'papercup' }).tableTag).toBe('coord-threads');
    expect(threadT.composeKey(thread)).toBe('thr-conv-1');
  });
  it('decodeValue accepts a well-formed thread + a thread with null last_post_at', () => {
    expect(threadT.decodeValue(thread)).toEqual(thread);
    expect(isCoordThreadRow({ ...thread, last_post_at: null, post_count: 0 })).toBe(true);
  });
  it('rejects malformed threads', () => {
    expect(isCoordThreadRow({ ...thread, thread_id: '' })).toBe(false);
    expect(isCoordThreadRow({ ...thread, parent_ref: '' })).toBe(false);
    expect(isCoordThreadRow({ ...thread, created_at: 'x' })).toBe(false);
    expect(isCoordThreadRow({ ...thread, post_count: 1.5 })).toBe(false);
    expect(isCoordThreadRow({ ...thread, harness_slug: '' })).toBe(false);
    expect(isCoordThreadRow(null)).toBe(false);
  });
});

describe('coord-thread-post projection', () => {
  it('exposes the registered tableTag + keys on post_msg_id', () => {
    expect(buildCoordThreadPostProjection({ workspaceId: 'w', harnessSlug: 'papercup' }).tableTag).toBe('coord-thread-posts');
    expect(postT.composeKey(post)).toBe('mq01-0000-abc');
  });
  it('decodeValue accepts a well-formed post + a null author_id (substrate post)', () => {
    expect(postT.decodeValue(post)).toEqual(post);
    expect(isCoordThreadPostRow({ ...post, author_id: null })).toBe(true);
  });
  it('rejects malformed posts', () => {
    expect(isCoordThreadPostRow({ ...post, post_msg_id: '' })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, thread_id: '' })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, body: 5 })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, created_at: 'x' })).toBe(false);
    expect(isCoordThreadPostRow({ ...post, harness_slug: '' })).toBe(false);
    expect(isCoordThreadPostRow(null)).toBe(false);
  });
});
