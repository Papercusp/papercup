/**
 * push-utilization-io — the P-011 live-leg mapping policy, PG-free.
 *
 * What these pin (the store's SQL has its own integration suite):
 *   • the row→ledger OBSERVATION-GRACE policy: stamped ⇒ observed; unstamped +
 *     stale ⇒ observed-IGNORED (the D-005 signal); unstamped + fresh (or an
 *     unageable delivered_at) ⇒ PENDING, excluded from every rate;
 *   • queued rows never reach the ledger (not yet through selection);
 *   • dropped rows carry their reason into droppedByReason;
 *   • runUtilizationReport forwards the window args to the store read and rolls
 *     the mapped ledger through the pure scorer (advisoryOnly stamped through).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushDeliveryRow } from './push-delivery-store';
import { recentDeliveries } from './push-delivery-store';
import {
  DEFAULT_OBSERVATION_GRACE_MS,
  ledgerFromRows,
  rowToLedgerEntry,
  runUtilizationReport,
} from './push-utilization-io';

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('./push-delivery-store', () => ({
  recentDeliveries: vi.fn<(filter?: object) => Promise<PushDeliveryRow[]>>(async () => []),
}));

const mockRecent = vi.mocked(recentDeliveries);

const NOW = Date.parse('2026-07-14T12:00:00.000Z');
const now = () => NOW;
const minsAgo = (m: number) => new Date(NOW - m * 60 * 1000).toISOString();

let nextId = 1;
function row(over: Partial<PushDeliveryRow> = {}): PushDeliveryRow {
  return {
    id: nextId++,
    target_owner_id: 'su-recv',
    target_session_id: null,
    workspace_id: 'default',
    matcher_kind: 'collision',
    severity: 'critical',
    handle_kind: 'session',
    handle_ref: 'su-peer',
    handle_query: ['foo'],
    teaser: 'peer converging',
    score: 0.8,
    source_session_id: 'su-peer',
    status: 'delivered',
    drop_reason: null,
    enqueued_at: minsAgo(120),
    delivered_at: minsAgo(90),
    pulled_at: null,
    acted_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
});

describe('rowToLedgerEntry — the observation-grace policy', () => {
  it('a queued row is not on the ledger (never went through selection)', () => {
    expect(rowToLedgerEntry(row({ status: 'queued', delivered_at: null }), { now })).toBeNull();
  });

  it('a stamped delivered row is OBSERVED with the stamps as booleans', () => {
    const pulledOnly = rowToLedgerEntry(row({ pulled_at: minsAgo(80) }), { now })!;
    expect(pulledOnly.delivery).toEqual({ kind: 'delivered' });
    expect(pulledOnly.outcome).toEqual({ pulled: true, acted: false });

    // acted from the teaser alone, without a pull — still genuine engagement.
    const actedOnly = rowToLedgerEntry(row({ acted_at: minsAgo(80) }), { now })!;
    expect(actedOnly.outcome).toEqual({ pulled: false, acted: true });
  });

  it('unstamped + past the grace ⇒ observed-IGNORED (the D-005 eviction signal)', () => {
    const entry = rowToLedgerEntry(row({ delivered_at: minsAgo(90) }), { now })!;
    expect(entry.outcome).toEqual({ pulled: false, acted: false });
  });

  it('unstamped + within the grace ⇒ PENDING (outcome null, excluded from rates)', () => {
    const entry = rowToLedgerEntry(row({ delivered_at: minsAgo(10) }), { now })!;
    expect(entry.outcome).toBeNull();
  });

  it('an unageable delivered_at stays PENDING — silence is never fabricated into "ignored"', () => {
    expect(rowToLedgerEntry(row({ delivered_at: null }), { now })!.outcome).toBeNull();
    expect(rowToLedgerEntry(row({ delivered_at: 'not-a-timestamp' }), { now })!.outcome).toBeNull();
  });

  it('parses the pg text timestamp format (space separator, short offset)', () => {
    const stale = rowToLedgerEntry(row({ delivered_at: '2026-07-14 06:00:00.123+00' }), { now })!;
    expect(stale.outcome).toEqual({ pulled: false, acted: false });
  });

  it('a dropped row carries its reason and never an outcome', () => {
    const entry = rowToLedgerEntry(row({ status: 'dropped', drop_reason: 'not-novel', delivered_at: null }), { now })!;
    expect(entry.delivery).toEqual({ kind: 'dropped', reason: 'not-novel' });
    expect(entry.outcome).toBeNull();
  });

  it('the grace is tunable', () => {
    const policy = { now, observationGraceMs: 5 * 60 * 1000 };
    expect(rowToLedgerEntry(row({ delivered_at: minsAgo(10) }), policy)!.outcome).toEqual({
      pulled: false,
      acted: false,
    });
    expect(rowToLedgerEntry(row({ delivered_at: minsAgo(2) }), policy)!.outcome).toBeNull();
  });
});

describe('ledgerFromRows', () => {
  it('counts queued (skipped) and pending-observation rows alongside the entries', () => {
    const { entries, queued, pendingObservation } = ledgerFromRows(
      [
        row({ status: 'queued', delivered_at: null }),
        row({ delivered_at: minsAgo(10) }), // pending
        row({ delivered_at: minsAgo(90) }), // observed-ignored
        row({ status: 'dropped', drop_reason: 'below-floor', delivered_at: null }),
      ],
      { now },
    );
    expect(entries).toHaveLength(3);
    expect(queued).toBe(1);
    expect(pendingObservation).toBe(1);
  });
});

describe('runUtilizationReport', () => {
  it('forwards the window to the store read and rolls the ledger through the scorer', async () => {
    mockRecent.mockResolvedValueOnce([
      row({ handle_ref: 'su-a', pulled_at: minsAgo(80) }), // engaged
      row({ handle_ref: 'su-b', delivered_at: minsAgo(90) }), // ignored
      row({ handle_ref: 'su-c', delivered_at: minsAgo(5) }), // pending
      row({ handle_ref: 'su-d', status: 'dropped', drop_reason: 'budget-exhausted', delivered_at: null }),
      row({ handle_ref: 'su-e', status: 'queued', delivered_at: null }),
      row({ matcher_kind: 'dead-end', handle_kind: 'fact', handle_ref: 'fact/x', acted_at: minsAgo(70) }),
    ]);

    const since = new Date(NOW - 24 * 60 * 60 * 1000);
    const result = await runUtilizationReport({ targetOwnerId: 'su-recv', since, limit: 200, now });

    expect(mockRecent).toHaveBeenCalledWith({ targetOwnerId: 'su-recv', since, limit: 200 });
    expect(result.counts).toEqual({ rows: 6, ledgerEntries: 5, queued: 1, pendingObservation: 1 });
    expect(result.window).toEqual({
      targetOwnerId: 'su-recv',
      since: since.toISOString(),
      limit: 200,
      observationGraceMs: DEFAULT_OBSERVATION_GRACE_MS,
    });

    const collision = result.report.matchers.find((m) => m.matcherKind === 'collision')!;
    expect(collision.delivered).toBe(3);
    expect(collision.observed).toBe(2); // pending su-c excluded
    expect(collision.pulled).toBe(1);
    expect(collision.engaged).toBe(1);
    expect(collision.ignored).toBe(1);
    expect(collision.droppedByReason['budget-exhausted']).toBe(1);

    const deadEnd = result.report.matchers.find((m) => m.matcherKind === 'dead-end')!;
    expect(deadEnd.acted).toBe(1);
    expect(deadEnd.engagementRate).toBe(1);

    expect(result.report.advisoryOnly).toBe(true);
    expect(result.report.recommendations.every((r) => r.advisoryOnly)).toBe(true);
    // Far below minObserved ⇒ the advisory never recommends eviction on thin data.
    expect(result.report.recommendations.every((r) => r.suggestedAction === 'gather-more-data')).toBe(true);
  });

  it('defaults: whole-fleet cut, 500-row cap, default grace', async () => {
    mockRecent.mockResolvedValueOnce([]);
    const result = await runUtilizationReport({ now });
    expect(mockRecent).toHaveBeenCalledWith({ targetOwnerId: undefined, since: undefined, limit: 500 });
    expect(result.window).toEqual({
      targetOwnerId: null,
      since: null,
      limit: 500,
      observationGraceMs: DEFAULT_OBSERVATION_GRACE_MS,
    });
    expect(result.report.totals.delivered).toBe(0);
  });
});
