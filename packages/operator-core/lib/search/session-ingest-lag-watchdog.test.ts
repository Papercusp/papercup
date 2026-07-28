/**
 * Ingest-lag watchdog (session-turn-storage-2026-07-28 P-007, D-005).
 *
 * The recurrence guard for the class this watchdog exists to catch AND for the
 * false alarm it exists to avoid. On 2026-07-28 codex read 2 d 9 h "behind"
 * and omp 6 d 8 h while BOTH were fully caught up and simply unused — so the
 * first test below is the one that matters most: a quiet adapter must stay
 * silent no matter how large its wall-clock lag. A watchdog that pages for
 * that is worse than none, because the next real wedge arrives into an alert
 * everyone has learned to ignore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateIngestLag,
  sessionIngestLagSweep,
  INGEST_LAG_MIN_BACKLOG_BYTES,
  type AdapterLagObservation,
} from './session-ingest-lag-watchdog';

const HOUR = 3_600_000;
const obs = (over: Partial<AdapterLagObservation> = {}): AdapterLagObservation => ({
  sourceKind: 'codex',
  behindFiles: 0,
  backlogBytes: 0,
  oldestBacklogAgeMs: 0,
  worstPath: null,
  ...over,
});

describe('evaluateIngestLag', () => {
  it('stays SILENT for a quiet adapter, however stale its clock lag', () => {
    // The 2026-07-28 case: no unconsumed bytes anywhere. The verdict must not
    // consult wall-clock lag at all — there is no input for it to consult.
    const v = evaluateIngestLag(obs({ sourceKind: 'omp' }), HOUR);
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('fully caught up');
  });

  it('ignores a sub-floor backlog (a live session mid-line)', () => {
    const v = evaluateIngestLag(
      obs({ behindFiles: 3, backlogBytes: INGEST_LAG_MIN_BACKLOG_BYTES - 1, oldestBacklogAgeMs: 5 * HOUR }),
      HOUR,
    );
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('floor');
  });

  it('ignores a real backlog that is still inside the threshold window', () => {
    const v = evaluateIngestLag(
      obs({ behindFiles: 2, backlogBytes: 50 * 1024 * 1024, oldestBacklogAgeMs: HOUR / 2 }),
      HOUR,
    );
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('inside the threshold');
  });

  it('ALERTS when real unconsumed bytes have sat past the threshold', () => {
    const v = evaluateIngestLag(
      obs({ behindFiles: 4, backlogBytes: 12 * 1024 * 1024, oldestBacklogAgeMs: 3 * HOUR, worstPath: '/t/a.jsonl' }),
      HOUR,
    );
    expect(v.wedged).toBe(true);
    expect(v.reason).toContain('WEDGED');
    expect(v.reason).toContain('/t/a.jsonl');
    // The alert must say WHY it is trustworthy, so a responder does not
    // dismiss it as the usual lag noise.
    expect(v.reason).toContain('NOT a quiet client');
  });

  it('honours the kill switch', () => {
    const v = evaluateIngestLag(obs({ behindFiles: 9, backlogBytes: 1e9, oldestBacklogAgeMs: 99 * HOUR }), 0);
    expect(v.wedged).toBe(false);
  });
});

describe('sessionIngestLagSweep', () => {
  // The sweep logs its alerts to the operator journal deliberately (that log
  // line is how a wedge is diagnosed after the fact); silence it here so the
  // repo's fail-on-console guard sees an expected, asserted warning.
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  const deps = (observations: AdapterLagObservation[], fires = 0) => ({
    observe: async () => observations,
    recentWatchdogFires: vi.fn(
      async (_ws: string, _slug: string, _hours: number, _source?: unknown, _scopeKey?: string) => fires,
    ),
    recordFire: vi.fn(async () => ({}) as never),
    openEscalation: vi.fn(async () => ({}) as never),
  });

  it('records a fire and opens ONE escalation for a wedged adapter', async () => {
    const d = deps([obs({ behindFiles: 2, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR })]);
    const res = await sessionIngestLagSweep({}, d);
    expect(res).toEqual([expect.objectContaining({ sourceKind: 'codex', outcome: 'alerted' })]);
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('debounces a repeat fire inside the window', async () => {
    const d = deps([obs({ behindFiles: 2, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR })], 1);
    const res = await sessionIngestLagSweep({}, d);
    expect(res[0].outcome).toBe('debounced');
    expect(d.recordFire).not.toHaveBeenCalled();
  });

  it('debounces PER source_kind, so one wedge cannot mask another', async () => {
    // The EI-16071 trap from the sibling watchdog: a source-only debounce key
    // means the first alerting adapter suppresses every other one for the rest
    // of the window. The scope key is the source_kind, so assert it is passed.
    const d = deps([
      obs({ sourceKind: 'codex', behindFiles: 1, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR }),
      obs({ sourceKind: 'omp', behindFiles: 1, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR }),
    ]);
    await sessionIngestLagSweep({}, d);
    const scopes = d.recentWatchdogFires.mock.calls.map((c) => c[4]);
    expect(scopes).toEqual(['codex', 'omp']);
    expect(d.recordFire).toHaveBeenCalledTimes(2);
  });

  it('reports a healthy adapter without touching the fires ledger', async () => {
    const d = deps([obs()]);
    const res = await sessionIngestLagSweep({}, d);
    expect(res[0].outcome).toBe('healthy');
    expect(d.recentWatchdogFires).not.toHaveBeenCalled();
  });

  it('is fail-soft: an observe failure returns an error row, never throws', async () => {
    const res = await sessionIngestLagSweep({}, {
      observe: async () => { throw new Error('pg down'); },
    });
    expect(res).toEqual([{ sourceKind: '*', outcome: 'error', reason: 'pg down' }]);
  });
});
