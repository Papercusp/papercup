/**
 * Unit tests for the coord_conversations projection (Track A,
 * distributed-coordination-shared-harness-2026-06-04). Pure — no PG.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCoordConversationProjection,
  isCoordConversationRow,
  _testing,
  type CoordConversationRow,
} from '../coord-conversation';

const valid: CoordConversationRow = {
  harness_slug: 'papercup',
  id: 'conv-abc123',
  kind: 'question',
  scope: 'harness',
  asker_id: 'su-1',
  title: 'how does X work',
  body: 'the body',
  state: 'open',
  accepted_answer: null,
  capture_target: null,
  promoted_issue_id: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  resolved_at: null,
};

describe('coord-conversation projection', () => {
  it('exposes the registered tableTag', () => {
    const p = buildCoordConversationProjection({ workspaceId: 'w', harnessSlug: 'papercup' });
    expect(p.tableTag).toBe('coord-conversations');
  });

  it('composeKey is the conversation id', () => {
    expect(_testing.composeKey(valid)).toBe('conv-abc123');
  });

  it('decodeValue accepts a well-formed harness-scoped row', () => {
    expect(_testing.decodeValue(valid)).toEqual(valid);
    expect(isCoordConversationRow(valid)).toBe(true);
  });

  it('accepts a resolved conversation with an accepted answer + timestamp', () => {
    const resolved: CoordConversationRow = {
      ...valid,
      state: 'resolved',
      accepted_answer: 'the answer',
      capture_target: 'mem0',
      resolved_at: 1_700_000_100_000,
    };
    expect(isCoordConversationRow(resolved)).toBe(true);
  });

  it('rejects operator-scope rows (only harness-scoped conversations federate)', () => {
    expect(isCoordConversationRow({ ...valid, scope: 'operator' })).toBe(false);
  });

  it('rejects an unknown kind or state (CHECK-constrained enums)', () => {
    expect(isCoordConversationRow({ ...valid, kind: 'rumor' })).toBe(false);
    expect(isCoordConversationRow({ ...valid, state: 'archived' })).toBe(false);
  });

  it('rejects missing / wrong-typed required fields', () => {
    expect(isCoordConversationRow({ ...valid, id: '' })).toBe(false);
    expect(isCoordConversationRow({ ...valid, harness_slug: '' })).toBe(false);
    expect(isCoordConversationRow({ ...valid, created_at: 'nope' })).toBe(false);
    expect(isCoordConversationRow({ ...valid, body: null })).toBe(false);
    expect(isCoordConversationRow(null)).toBe(false);
    expect(isCoordConversationRow({})).toBe(false);
  });

  it('rejects a non-null, non-number resolved_at but accepts null', () => {
    expect(isCoordConversationRow({ ...valid, resolved_at: 'soon' })).toBe(false);
    expect(isCoordConversationRow({ ...valid, resolved_at: null })).toBe(true);
    expect(isCoordConversationRow({ ...valid, resolved_at: 1_700_000_200_000 })).toBe(true);
  });
});
