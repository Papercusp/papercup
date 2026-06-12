/**
 * isPossiblyWedged — the alive-but-silent classifier (liveness-hardening
 * P-009). Pins: only running/restarting rows with a FRESH heartbeat and a
 * stream silent past the threshold flag; no-output-yet rows never flag
 * (absence of signal ≠ wedge); stale-heartbeat rows belong to the reclaim
 * path, not the wedge badge.
 */
import { describe, test, expect } from 'vitest';
import { isPossiblyWedged, WEDGE_SILENT_MS, RECLAIM_STALE_MS } from './spawn-reclaim';

const NOW = 10_000_000_000;
const fresh = new Date(NOW - 10_000); // heartbeat 10s ago — well inside stale window
const silentLong = new Date(NOW - WEDGE_SILENT_MS - 60_000);
const talkedRecently = new Date(NOW - 30_000);

describe('isPossiblyWedged', () => {
  test('alive + heartbeating + stream silent past threshold → wedged candidate', () => {
    expect(
      isPossiblyWedged(
        { status: 'running', heartbeatAt: fresh, lastOutputAt: silentLong },
        { now: NOW },
      ),
    ).toBe(true);
  });

  test('actively emitting → not wedged', () => {
    expect(
      isPossiblyWedged(
        { status: 'running', heartbeatAt: fresh, lastOutputAt: talkedRecently },
        { now: NOW },
      ),
    ).toBe(false);
  });

  test('no output ever observed → never flagged (absence of signal ≠ wedge)', () => {
    expect(
      isPossiblyWedged({ status: 'running', heartbeatAt: fresh, lastOutputAt: null }, { now: NOW }),
    ).toBe(false);
  });

  test('stale heartbeat → the reclaim path owns it, not the wedge badge', () => {
    const staleBeat = new Date(NOW - RECLAIM_STALE_MS - 1_000);
    expect(
      isPossiblyWedged(
        { status: 'running', heartbeatAt: staleBeat, lastOutputAt: silentLong },
        { now: NOW },
      ),
    ).toBe(false);
  });

  test('terminal rows never flag', () => {
    for (const status of ['done', 'failed', 'cancelled', 'reaped']) {
      expect(
        isPossiblyWedged({ status, heartbeatAt: fresh, lastOutputAt: silentLong }, { now: NOW }),
      ).toBe(false);
    }
  });

  test('restarting counts as supervised-live', () => {
    expect(
      isPossiblyWedged(
        { status: 'restarting', heartbeatAt: fresh, lastOutputAt: silentLong },
        { now: NOW },
      ),
    ).toBe(true);
  });
});
