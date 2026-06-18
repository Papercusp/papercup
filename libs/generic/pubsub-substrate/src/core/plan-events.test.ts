/**
 * plan-events.test.ts — filterPlanEvents is the pure read filter behind
 * coord:plan-events. A wrong filter shows an agent stale/foreign plan events or
 * hides ones it needs. Pinned: only `plan_event` kinds pass, the since_ts cutoff
 * is STRICT (equal ts excluded), planSlugs/events filters keep only matches (and
 * exclude envelopes missing that field), and results sort ascending by (ts, msg_id).
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/plan-events.test.ts
 */
import { describe, expect, it } from 'vitest';
import { filterPlanEvents } from './plan-events';
import type { CoordEnvelope } from './envelope';

const ev = (msg_id: string, over: Record<string, unknown> = {}): CoordEnvelope =>
  ({ msg_id, kind: 'plan_event', ts: '2026-01-01T00:00:01Z', plan_slug: 'p1', event: 'created', ...over }) as unknown as CoordEnvelope;
const ids = (xs: CoordEnvelope[]) => xs.map((x) => x.msg_id);

describe('filterPlanEvents', () => {
  it('keeps only plan_event kinds', () => {
    const lines = [ev('a'), ev('b', { kind: 'message' }), ev('c', { kind: 'ack' })];
    expect(ids(filterPlanEvents(lines))).toEqual(['a']);
  });

  it('with no opts returns all plan events, sorted by (ts, msg_id)', () => {
    const lines = [ev('c', { ts: '2026-01-01T00:00:03Z' }), ev('a', { ts: '2026-01-01T00:00:01Z' }), ev('b', { ts: '2026-01-01T00:00:02Z' })];
    expect(ids(filterPlanEvents(lines))).toEqual(['a', 'b', 'c']);
  });

  it('applies a STRICT since_ts cutoff (equal ts excluded)', () => {
    const lines = [
      ev('old', { ts: '2026-01-01T00:00:01Z' }),
      ev('eq', { ts: '2026-01-01T00:00:02Z' }),
      ev('new', { ts: '2026-01-01T00:00:03Z' }),
    ];
    expect(ids(filterPlanEvents(lines, { since_ts: '2026-01-01T00:00:02Z' }))).toEqual(['new']);
  });

  it('filters by planSlugs and excludes envelopes missing a slug', () => {
    const lines = [ev('a', { plan_slug: 'p1' }), ev('b', { plan_slug: 'p2' }), ev('c', { plan_slug: undefined })];
    expect(ids(filterPlanEvents(lines, { planSlugs: ['p1'] }))).toEqual(['a']);
  });

  it('filters by event types and excludes envelopes missing an event', () => {
    const lines = [
      ev('a', { event: 'created' }),
      ev('b', { event: 'item_added' }),
      ev('c', { event: undefined }),
    ];
    expect(ids(filterPlanEvents(lines, { events: ['item_added'] }))).toEqual(['b']);
  });

  it('combines since + slug + event filters', () => {
    const lines = [
      ev('keep', { ts: '2026-01-01T00:00:05Z', plan_slug: 'p1', event: 'promoted' }),
      ev('wrong-slug', { ts: '2026-01-01T00:00:05Z', plan_slug: 'p2', event: 'promoted' }),
      ev('too-old', { ts: '2026-01-01T00:00:01Z', plan_slug: 'p1', event: 'promoted' }),
      ev('wrong-event', { ts: '2026-01-01T00:00:05Z', plan_slug: 'p1', event: 'created' }),
    ];
    expect(ids(filterPlanEvents(lines, { since_ts: '2026-01-01T00:00:02Z', planSlugs: ['p1'], events: ['promoted'] }))).toEqual(['keep']);
  });
});
