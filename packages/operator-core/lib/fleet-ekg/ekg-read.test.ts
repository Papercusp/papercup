/**
 * ekg-read.test.ts — the pure snapshot projection behind the `learning.ekg`
 * resolver (P-030 / FB-10). SQL lives in readEkgSnapshot (integration-covered
 * via fleet-ekg.integration.test.ts); this pins the row→panel mapping.
 */
import { describe, expect, it } from 'vitest';
import { ekgSnapshotFromRows, EMPTY_EKG_SNAPSHOT, type EkgShiftRow } from './ekg-read';

const row = (over: Partial<EkgShiftRow> = {}): EkgShiftRow => ({
  id: 1,
  window_date: '2026-06-12',
  feature: 'errorRate',
  kind: 'numeric',
  score: 0.31,
  severity: 'major',
  direction: 'up',
  baseline_summary: 0.05,
  window_summary: 0.4,
  window_sessions: 12,
  baseline_sessions: 88,
  attributed: false,
  ledger_candidates: null,
  notified_at: null,
  ...over,
});

const vitals = { sessionsEmbedded: 500, sessions7d: 120, scannedAt: '2026-06-12T10:00:00.000Z' };

describe('ekgSnapshotFromRows', () => {
  it('maps rows, counts unattributed, carries vitals', () => {
    const snap = ekgSnapshotFromRows(
      [
        row(),
        row({
          id: 2,
          feature: 'toolMix',
          kind: 'mix',
          attributed: true,
          ledger_candidates: [
            { id: 'c1', source: 'gym:accept', mutationClass: 'gym', target: 'papercup/worker', recordedAt: '2026-06-12T08:00:00.000Z', summary: null },
          ],
          notified_at: new Date('2026-06-12T11:00:00.000Z'),
        }),
      ],
      vitals,
    );
    expect(snap.totalShifts).toBe(2);
    expect(snap.unattributedShifts).toBe(1);
    expect(snap.sessionsEmbedded).toBe(500);
    expect(snap.sessions7d).toBe(120);
    expect(snap.scannedAt).toBe(vitals.scannedAt);
    const attributed = snap.shifts.find((s) => s.id === 2)!;
    expect(attributed.ledgerCandidates).toHaveLength(1);
    expect(attributed.notifiedAt).toBe('2026-06-12T11:00:00.000Z');
    const unattributed = snap.shifts.find((s) => s.id === 1)!;
    expect(unattributed.ledgerCandidates).toEqual([]);
  });

  it('sorts newest window first, then by score; caps at the limit', () => {
    const rows = [
      row({ id: 1, window_date: '2026-06-10', score: 0.9 }),
      row({ id: 2, window_date: '2026-06-12', score: 0.2, feature: 'b' }),
      row({ id: 3, window_date: '2026-06-12', score: 0.8, feature: 'a' }),
    ];
    const snap = ekgSnapshotFromRows(rows, vitals);
    expect(snap.shifts.map((s) => s.id)).toEqual([3, 2, 1]);
    expect(ekgSnapshotFromRows(rows, vitals, 2).shifts).toHaveLength(2);
    // totalShifts still counts everything, not just the page.
    expect(ekgSnapshotFromRows(rows, vitals, 2).totalShifts).toBe(3);
  });

  it('Date-typed window_date normalizes to YYYY-MM-DD', () => {
    const snap = ekgSnapshotFromRows([row({ window_date: new Date('2026-06-12T00:00:00.000Z') })], vitals);
    expect(snap.shifts[0].windowDate).toBe('2026-06-12');
  });

  it('the empty snapshot is the degraded-read shape', () => {
    expect(EMPTY_EKG_SNAPSHOT).toEqual({
      shifts: [],
      totalShifts: 0,
      unattributedShifts: 0,
      sessionsEmbedded: 0,
      sessions7d: 0,
      scannedAt: null,
    });
  });
});
