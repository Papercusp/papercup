import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for operator-state PG (same pattern as
// the old operator-idle-snapshot tests): the helper's only side effect is the
// telemetry_reports ring buffer, so we capture it without touching PG.
const store = new Map<string, unknown>();
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async (table: string) => store.get(table) ?? null,
  writeOperatorState: async (table: string, payload: unknown) => {
    store.set(table, payload);
  },
}));

import { recordTelemetryReport, MAX_TELEMETRY_REPORTS } from './record-telemetry';

beforeEach(() => store.clear());

describe('recordTelemetryReport', () => {
  it('enqueues a report newest-first into the telemetry_reports ring and returns it', async () => {
    const a = await recordTelemetryReport({ kind: 'test', payload: { n: 1 }, receivedAt: '2026-01-01T00:00:00Z' });
    const b = await recordTelemetryReport({
      kind: 'substrate_admission_rejected',
      payload: { harness_slug: 'h', reason: 'bad_sig' },
      receivedAt: '2026-01-01T00:00:01Z',
    });

    expect(a.kind).toBe('test');
    expect(b).toMatchObject({ kind: 'substrate_admission_rejected', received_at: '2026-01-01T00:00:01Z' });

    const state = store.get('telemetry_reports') as { reports: Array<{ kind: string }> };
    // Newest first.
    expect(state.reports.map((r) => r.kind)).toEqual(['substrate_admission_rejected', 'test']);
  });

  it('caps the ring at MAX_TELEMETRY_REPORTS (drops the oldest)', async () => {
    const seeded = Array.from({ length: MAX_TELEMETRY_REPORTS }, (_, i) => ({
      received_at: `t${i}`,
      kind: 'test',
      payload: { i },
    }));
    store.set('telemetry_reports', { reports: seeded });

    await recordTelemetryReport({ kind: 'crash', payload: {}, receivedAt: 'newest' });

    const state = store.get('telemetry_reports') as { reports: Array<{ kind: string; received_at: string }> };
    expect(state.reports).toHaveLength(MAX_TELEMETRY_REPORTS);
    expect(state.reports[0]).toMatchObject({ kind: 'crash', received_at: 'newest' }); // newest kept at head
    expect(state.reports.some((r) => r.received_at === `t${MAX_TELEMETRY_REPORTS - 1}`)).toBe(false); // oldest dropped
  });

  it('defaults missing payload to null', async () => {
    const r = await recordTelemetryReport({ kind: 'test', payload: undefined });
    expect(r.payload).toBeNull();
  });
});
