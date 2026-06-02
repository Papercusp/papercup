/**
 * P-070 — coverage for the contributor_usage_events runtime (PG-ledger core):
 * makeUsageEventId (ULID shape + time-sortable), emitUsageEvent (INSERT
 * value-threading + ON CONFLICT idempotency + provided-id reuse), and
 * rollupForContributor (GROUP-BY fold → counts/total/last_event_ts, empty +
 * unknown-kind handling). The org-PG `sql` tagged template is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUsageEventId, emitUsageEvent, rollupForContributor } from './usage-events';
import { isUsageEventId, USAGE_EVENT_ID_LENGTH } from './contributor-usage-event-types';

const zeros = (n: number) => Buffer.alloc(n, 0);

describe('makeUsageEventId', () => {
  it('produces a valid 26-char ULID-shaped id', () => {
    const id = makeUsageEventId(1_700_000_000_000, zeros);
    expect(id).toHaveLength(USAGE_EVENT_ID_LENGTH);
    expect(isUsageEventId(id)).toBe(true);
  });
  it('is lexically time-sortable by its timestamp prefix', () => {
    const earlier = makeUsageEventId(1_700_000_000_000, zeros);
    const later = makeUsageEventId(1_700_000_001_000, zeros);
    expect(earlier < later).toBe(true);
  });
  it('varies with randomness', () => {
    const a = makeUsageEventId(1_700_000_000_000, () => Buffer.alloc(16, 1));
    const b = makeUsageEventId(1_700_000_000_000, () => Buffer.alloc(16, 2));
    expect(a).not.toBe(b);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // same ts prefix
  });
});

function makeSql() {
  const sql = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), {
    json: vi.fn((x: unknown) => ({ __json: x })),
  });
  return sql;
}

describe('emitUsageEvent', () => {
  let sql: ReturnType<typeof makeSql>;
  beforeEach(() => {
    sql = makeSql();
  });

  it('threads the row values into the INSERT and returns the event_id', async () => {
    const res = await emitUsageEvent(
      {
        harness_slug: 'papercup',
        github_user_id: 42,
        device_pubkey: 'dev-abc',
        kind: 'feature_authored',
        ref_id: 'F-1',
        payload: { title: 'Do it' },
      },
      { sql: sql as never, nowMs: 1_700_000_000_000, eventId: 'EVT00000000000000000000000' },
    );
    expect(res.event_id).toBe('EVT00000000000000000000000');
    const values = (sql.mock.calls[0] as unknown as unknown[]).slice(1);
    expect(values[0]).toBe('papercup'); // harness_slug
    expect(values[1]).toBe('EVT00000000000000000000000'); // event_id
    expect(values[2]).toBe(42); // github_user_id
    expect(values[3]).toBe('dev-abc'); // device_pubkey
    expect(values[4]).toBe('feature_authored'); // kind
    expect(values[5]).toBe('F-1'); // ref_id
    // payload is bound as JSON.stringify(...)::jsonb (NOT sql.json — that throws
    // under the operator's getOrgPg client; see agent-insights/postgres-js-jsonb-binding).
    expect(values[6]).toBe(JSON.stringify({ title: 'Do it' }));
    expect(sql.json).not.toHaveBeenCalled();
    expect(values[7]).toBe(1_700_000_000_000); // ts ms (inside to_timestamp)
    expect(values[8]).toBe(1); // schema_version
  });

  it('null-defaults ref_id + payload (no sql.json for a null payload)', async () => {
    await emitUsageEvent(
      { harness_slug: 'h', github_user_id: 1, device_pubkey: 'd', kind: 'agent_run_completed' },
      { sql: sql as never, eventId: 'E' },
    );
    const values = (sql.mock.calls[0] as unknown as unknown[]).slice(1);
    expect(values[5]).toBeNull(); // ref_id
    expect(values[6]).toBeNull(); // payload
    expect(sql.json).not.toHaveBeenCalled();
  });

  it('generates a valid ULID when no eventId is provided', async () => {
    const res = await emitUsageEvent(
      { harness_slug: 'h', github_user_id: 1, device_pubkey: 'd', kind: 'plan_authored' },
      { sql: sql as never, nowMs: 1_700_000_000_000 },
    );
    expect(isUsageEventId(res.event_id)).toBe(true);
  });
});

describe('rollupForContributor', () => {
  it('folds GROUP-BY rows into counts/total/last_event_ts', async () => {
    const sql = makeSql();
    sql.mockResolvedValueOnce([
      { kind: 'feature_authored', n: '3', last_ms: '1700000002000' },
      { kind: 'pr_opened', n: 2n, last_ms: 1700000005000 },
    ]);
    const r = await rollupForContributor(42, 'papercup', { sql: sql as never });
    expect(r.counts.feature_authored).toBe(3);
    expect(r.counts.pr_opened).toBe(2);
    expect(r.counts.agent_run_completed).toBe(0); // unmentioned kind stays 0
    expect(r.total).toBe(5);
    expect(r.last_event_ts).toBe(1700000005000); // max across kinds
  });

  it('returns an empty rollup when there are no events', async () => {
    const sql = makeSql();
    sql.mockResolvedValueOnce([]);
    const r = await rollupForContributor(7, 'h', { sql: sql as never });
    expect(r.total).toBe(0);
    expect(r.last_event_ts).toBeNull();
    expect(Object.values(r.counts).every((c) => c === 0)).toBe(true);
  });

  it('ignores unknown/legacy kinds', async () => {
    const sql = makeSql();
    sql.mockResolvedValueOnce([
      { kind: 'feature_authored', n: '1', last_ms: '100' },
      { kind: 'legacy_unknown_kind', n: '99', last_ms: '999' },
    ]);
    const r = await rollupForContributor(1, 'h', { sql: sql as never });
    expect(r.total).toBe(1); // the unknown kind's 99 is not counted
    expect(r.last_event_ts).toBe(100);
  });
});
