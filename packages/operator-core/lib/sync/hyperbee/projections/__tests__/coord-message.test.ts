/**
 * Unit tests for the coord_event_log (message rail) projection (Track A,
 * distributed-coordination-shared-harness-2026-06-04). Pure — no PG.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCoordMessageProjection,
  isCoordMessageRow,
  _testing,
  type CoordMessageRow,
} from '../coord-message';

const valid: CoordMessageRow = {
  harness_slug: 'papercup',
  msg_id: 'mq00-0000-abc',
  surface: 'messages',
  writer_key: 'su-1',
  body: { ts: '2026-06-04T00:00:00Z', msg_id: 'mq00-0000-abc', from: 'su-1', to: ['su-2'], kind: 'message', summary: 'hi' },
  ts: 1_700_000_000_000,
};

describe('coord-message projection', () => {
  it('exposes the registered tableTag', () => {
    const p = buildCoordMessageProjection({ workspaceId: 'w', harnessSlug: 'papercup' });
    expect(p.tableTag).toBe('coord-messages');
  });

  it('composeKey is the msg_id', () => {
    expect(_testing.composeKey(valid)).toBe('mq00-0000-abc');
  });

  it('decodeValue accepts a well-formed harness-scoped message', () => {
    expect(_testing.decodeValue(valid)).toEqual(valid);
    expect(isCoordMessageRow(valid)).toBe(true);
  });

  it('accepts handoff + escalation surfaces; rejects plan-events and unknown surfaces', () => {
    expect(isCoordMessageRow({ ...valid, surface: 'handoffs' })).toBe(true);
    expect(isCoordMessageRow({ ...valid, surface: 'escalations' })).toBe(true);
    expect(isCoordMessageRow({ ...valid, surface: 'plan-events' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, surface: 'nope' })).toBe(false);
  });

  it('rejects a fan-out delivery copy (body.notify_kind set) — defensive double of the trigger filter', () => {
    expect(isCoordMessageRow({ ...valid, body: { ...valid.body, notify_kind: 'topic' } })).toBe(false);
  });

  it('accepts a null writer_key (event surfaces write NULL)', () => {
    expect(isCoordMessageRow({ ...valid, surface: 'handoffs', writer_key: null })).toBe(true);
  });

  it('rejects missing / wrong-typed required fields', () => {
    expect(isCoordMessageRow({ ...valid, msg_id: '' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, harness_slug: '' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, body: null })).toBe(false);
    expect(isCoordMessageRow({ ...valid, body: ['not', 'an', 'object'] })).toBe(false);
    expect(isCoordMessageRow({ ...valid, ts: 'soon' })).toBe(false);
    expect(isCoordMessageRow({ ...valid, writer_key: 5 })).toBe(false);
    expect(isCoordMessageRow(null)).toBe(false);
    expect(isCoordMessageRow({})).toBe(false);
  });

  it('the federated surface set is exactly messages/handoffs/escalations', () => {
    expect([..._testing.FEDERATED_SURFACES].sort()).toEqual(['escalations', 'handoffs', 'messages']);
  });
});
