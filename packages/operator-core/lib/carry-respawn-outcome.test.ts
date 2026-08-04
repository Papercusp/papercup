import { describe, expect, it } from 'vitest';
import { deriveLastRespawnOutcome, priorRespawnNote } from './carry-respawn-outcome';

/**
 * EI-19480099650947832 — `session:request-compaction` returned `respawn: true`
 * and the cut never happened; the caller was never told. The host DID record
 * every outcome, in a per-owner JSONL no tool read. These rows are copied from
 * the real log that produced the filing:
 * ~/.papercusp/psu-pty/su-4a6e2255-….events.jsonl, 2026-08-03/04.
 */
const NOW = Date.parse('2026-08-04T00:47:00.000Z');

describe('deriveLastRespawnOutcome', () => {
  it('reports `dropped` with the host reason for the real 2026-08-04 failure sequence', () => {
    const rows = [
      { ts: '2026-08-04T00:25:22.517Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
      { ts: '2026-08-04T00:28:00.818Z', kind: 'respawn-rearm-queued', reason: 'busy-gate-expired' },
      { ts: '2026-08-04T00:32:17.214Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
      { ts: '2026-08-04T00:38:29.702Z', kind: 'respawn-carry-dropped', reason: 'busy-gate-expired' },
      { ts: '2026-08-04T00:39:49.595Z', kind: 'wake-turn-deferred-for-pending-respawn', reason: 'carry-respawn-pending' },
    ];
    const out = deriveLastRespawnOutcome(rows, { now: NOW });
    expect(out.outcome).toBe('dropped');
    expect(out.reason).toBe('busy-gate-expired');
    expect(out.ts).toBe('2026-08-04T00:38:29.702Z');
    expect(out.ageMs).toBe(NOW - Date.parse('2026-08-04T00:38:29.702Z'));
  });

  it('ignores non-lifecycle rows entirely — a wake deferral is not a verdict about a respawn', () => {
    const rows = [
      { ts: '2026-08-04T00:10:00.000Z', kind: 'respawn-carry-delivered' },
      { ts: '2026-08-04T00:25:22.517Z', kind: 'wake-turn-deferred-for-pending-respawn' },
      { ts: '2026-08-04T00:30:00.000Z', kind: 'stale-fire-dropped' },
      { ts: '2026-08-04T00:31:00.000Z', kind: 'shutdown-refused' },
    ];
    expect(deriveLastRespawnOutcome(rows, { now: NOW }).outcome).toBe('delivered');
  });

  it('a later success supersedes an earlier drop (newest-first, first lifecycle row wins)', () => {
    const rows = [
      { ts: '2026-08-03T16:16:42.518Z', kind: 'respawn-carry-dropped', reason: 'carry-stale' },
      { ts: '2026-08-03T16:52:28.309Z', kind: 'respawned' },
      { ts: '2026-08-03T16:53:01.997Z', kind: 'respawn-carry-delivered' },
    ];
    const out = deriveLastRespawnOutcome(rows, { now: NOW });
    expect(out.outcome).toBe('delivered');
    expect(out.reason).toBeUndefined();
  });

  it('reports `pending` while a re-poll is still in flight, including after a supersede', () => {
    expect(
      deriveLastRespawnOutcome([{ ts: '2026-08-04T00:28:00.818Z', kind: 'respawn-rearm-queued' }], { now: NOW })
        .outcome,
    ).toBe('pending');
    expect(
      deriveLastRespawnOutcome(
        [
          { ts: '2026-08-04T00:28:00.818Z', kind: 'respawn-rearm-queued' },
          { ts: '2026-08-04T00:38:29.702Z', kind: 'respawn-rearm-superseded', reason: 'superseded-pending-rearm' },
        ],
        { now: NOW },
      ).outcome,
    ).toBe('pending');
  });

  it('reports `none` for an empty / respawn-free log rather than guessing', () => {
    expect(deriveLastRespawnOutcome([], { now: NOW })).toEqual({ outcome: 'none' });
    expect(deriveLastRespawnOutcome([{ ts: '2026-08-04T00:00:00.000Z', kind: 'shutdown-accepted' }], { now: NOW })).toEqual(
      { outcome: 'none' },
    );
  });

  it('survives malformed rows (a partially-written final line, a row with no kind/ts)', () => {
    const rows = [
      {},
      { kind: '' },
      { kind: 'respawn-carry-dropped', reason: 'rearm-error' }, // no ts
    ];
    const out = deriveLastRespawnOutcome(rows, { now: NOW });
    expect(out.outcome).toBe('dropped');
    expect(out.ageMs).toBeNull();
    expect(out.ts).toBeUndefined();
  });
});

describe('priorRespawnNote', () => {
  it('warns LOUDLY and names the host reason when the previous respawn was dropped', () => {
    const note = priorRespawnNote({
      outcome: 'dropped',
      reason: 'busy-gate-expired',
      ts: '2026-08-04T00:38:29.702Z',
      ageMs: 9 * 60_000,
    });
    expect(note).toContain('prior-respawn-DROPPED');
    expect(note).toContain('busy-gate-expired');
    expect(note).toContain('9m ago');
    // The operative correction: an ack is not a landed cut.
    expect(note).toContain('An acknowledged request is NOT a landed cut');
  });

  it('says a pending re-poll is SUPERSEDED by this request rather than racing it', () => {
    const note = priorRespawnNote({ outcome: 'pending', ts: '2026-08-04T00:28:00.818Z', ageMs: 19 * 60_000 });
    expect(note).toContain('prior-respawn-STILL-PENDING');
    expect(note).toContain('SUPERSEDES');
  });

  // A warning that fires when nothing is wrong trains agents to ignore it —
  // the note is emitted ONLY on evidence.
  it('is SILENT when the last respawn delivered, when there is no history, or on a null verdict', () => {
    expect(priorRespawnNote({ outcome: 'delivered', ageMs: 1000 })).toBe('');
    expect(priorRespawnNote({ outcome: 'none' })).toBe('');
    expect(priorRespawnNote(null)).toBe('');
    expect(priorRespawnNote(undefined)).toBe('');
  });

  it('renders age sanely across the minute/hour boundary and with no timestamp at all', () => {
    expect(priorRespawnNote({ outcome: 'dropped', ageMs: 30_000 })).toContain('just now');
    expect(priorRespawnNote({ outcome: 'dropped', ageMs: 3 * 3_600_000 })).toContain('3h ago');
    expect(priorRespawnNote({ outcome: 'dropped', ageMs: null })).toContain('unknown age');
  });
});
