import { describe, expect, it } from 'vitest';
import {
  deriveLastRespawnOutcome,
  priorRespawnNote,
  droppedRespawnAmbientLine,
  DROPPED_RESPAWN_AMBIENT_MAX_AGE_MS,
} from './carry-respawn-outcome';

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

/**
 * EI-19326331501849713 (owner-directed 2026-08-09) — the AMBIENT line, which
 * exists because `priorRespawnNote` only reaches an agent that calls
 * `session:request-compaction` AGAIN, and a dropped respawn removes every reason
 * to call again. Measured on session bd819348: the owner read the resulting
 * silence as "the successor got an error" when no successor had ever existed.
 */
describe('droppedRespawnAmbientLine', () => {
  const dropped = (over: Partial<{ reason: string; ageMs: number | null }> = {}) => ({
    outcome: 'dropped' as const,
    reason: 'busy-gate-expired',
    ts: '2026-08-04T00:38:29.702Z',
    ageMs: 4 * 60_000,
    ...over,
  });

  it('warns on a RECENT drop, naming the reason and the observable that confirms it', () => {
    const line = droppedRespawnAmbientLine(dropped());
    expect(line).toContain('carry-respawn DROPPED');
    expect(line).toContain('busy-gate-expired');
    // The observable is what makes this actionable rather than merely alarming:
    // the agent can confirm it without any tool call.
    expect(line).toContain('still the same session');
    expect(line).toContain('session:request-compaction');
  });

  // A line that fires when nothing is wrong is a line agents learn to skip —
  // which would defeat the entire point of adding another per-turn line.
  it('is SILENT for delivered / pending / none / null', () => {
    expect(droppedRespawnAmbientLine({ outcome: 'delivered', ageMs: 1_000 })).toBeNull();
    expect(droppedRespawnAmbientLine({ outcome: 'pending', ageMs: 1_000 })).toBeNull();
    expect(droppedRespawnAmbientLine({ outcome: 'none' })).toBeNull();
    expect(droppedRespawnAmbientLine(null)).toBeNull();
    expect(droppedRespawnAmbientLine(undefined)).toBeNull();
  });

  it('goes quiet once the drop is old news, treating the boundary itself as still-recent', () => {
    expect(droppedRespawnAmbientLine(dropped({ ageMs: DROPPED_RESPAWN_AMBIENT_MAX_AGE_MS }))).not.toBeNull();
    expect(droppedRespawnAmbientLine(dropped({ ageMs: DROPPED_RESPAWN_AMBIENT_MAX_AGE_MS + 1 }))).toBeNull();
  });

  // An unparseable host timestamp yields ageMs null. Rendering that as "recent"
  // would nag every turn forever on exactly the rows we know least about.
  it('is SILENT on a drop of UNKNOWN age rather than assuming it is recent', () => {
    expect(droppedRespawnAmbientLine(dropped({ ageMs: null }))).toBeNull();
  });

  it('omits the reason clause cleanly when the host recorded none', () => {
    const line = droppedRespawnAmbientLine({ outcome: 'dropped', ageMs: 60_000 });
    expect(line).toContain('carry-respawn DROPPED');
    expect(line).not.toContain('(reason:');
  });

  // CONTROL (falsifiability, per the repo's guard-testing rule): the age gate is
  // the only thing between this line and permanent noise, so prove a
  // deliberately-weaker gate WOULD fire where the real one stays silent. If this
  // control ever stops discriminating, the assertions above have gone vacuous.
  it('CONTROL: an age-blind gate fires on an ancient drop where the real one does not', () => {
    const ancient = dropped({ ageMs: 30 * 24 * 3_600_000 });
    const ageBlindGate = (p: ReturnType<typeof dropped>) => (p.outcome === 'dropped' ? 'would fire' : null);
    expect(ageBlindGate(ancient)).not.toBeNull();
    expect(droppedRespawnAmbientLine(ancient)).toBeNull();
  });
});
