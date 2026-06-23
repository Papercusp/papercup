/**
 * spawn-reclaim tests — focused on isPossiblyWedged (the fleet:tree wedge-check).
 *
 * Regression for EI-482 / EI-492: fleet:tree threw `row.heartbeatAt.getTime is not
 * a function` on a LIVE subtree because heartbeatAt arrives as a STRING from a raw
 * PG read, not a Date. The getMs guard (commit 7c4bc23b5) normalizes Date | string |
 * number; these tests pin that so the crash can't regress.
 */

import { describe, it, expect } from 'vitest';
import { isPossiblyWedged, WEDGE_SILENT_MS, shouldRelaunchReclaimedSpawn } from './spawn-reclaim';

const NOW = Date.parse('2026-06-14T02:00:00.000Z');
const opts = { now: NOW, staleMs: 60 * 60_000, silentMs: WEDGE_SILENT_MS }; // 60m stale, 10m silent
const fresh = '2026-06-14T01:59:00.000Z'; // heartbeat 1m ago (supervised-live)
const silent = '2026-06-14T01:40:00.000Z'; // last output 20m ago (> 10m silent)

describe('isPossiblyWedged — Date/string heartbeat normalization (EI-482/EI-492 regression)', () => {
  it('does NOT crash and classifies correctly when heartbeatAt/lastOutputAt are STRINGS (the raw-PG-read crash input)', () => {
    expect(() =>
      isPossiblyWedged({ status: 'running', heartbeatAt: fresh, lastOutputAt: silent }, opts),
    ).not.toThrow();
    expect(isPossiblyWedged({ status: 'running', heartbeatAt: fresh, lastOutputAt: silent }, opts)).toBe(true);
  });

  it('classifies identically whether heartbeat/output are Date or string (parity)', () => {
    const asString = isPossiblyWedged(
      { status: 'running', heartbeatAt: fresh, lastOutputAt: silent },
      opts,
    );
    const asDate = isPossiblyWedged(
      { status: 'running', heartbeatAt: new Date(fresh), lastOutputAt: new Date(silent) },
      opts,
    );
    expect(asString).toBe(asDate);
    expect(asDate).toBe(true);
  });

  it('is false for a stale heartbeat (reclaim path owns it, not the wedge display)', () => {
    const stale = '2026-06-14T00:00:00.000Z'; // 2h ago > 60m staleMs
    expect(isPossiblyWedged({ status: 'running', heartbeatAt: stale, lastOutputAt: silent }, opts)).toBe(false);
  });

  it('is false when not running, when there is no heartbeat, and when there is no last output', () => {
    expect(isPossiblyWedged({ status: 'done', heartbeatAt: fresh, lastOutputAt: silent }, opts)).toBe(false);
    expect(isPossiblyWedged({ status: 'running', heartbeatAt: null, lastOutputAt: silent }, opts)).toBe(false);
    expect(isPossiblyWedged({ status: 'running', heartbeatAt: fresh, lastOutputAt: null }, opts)).toBe(false);
  });

  it('is false when output is recent (fresh heartbeat, not silent past the threshold)', () => {
    const recentOutput = '2026-06-14T01:58:00.000Z'; // 2m ago < 10m silent
    expect(isPossiblyWedged({ status: 'running', heartbeatAt: fresh, lastOutputAt: recentOutput }, opts)).toBe(false);
  });
});

/**
 * shouldRelaunchReclaimedSpawn — the boot-reconcile RE-LAUNCH branch (EI-85
 * restart-kills). A reclaimed queen/bee whose durable work-item is non-terminal is
 * RE-LAUNCHED (so the work survives a host restart); a terminal/missing work-item,
 * or a non-queen/bee role, keeps the plain reclaim-to-`failed` floor.
 */
describe('shouldRelaunchReclaimedSpawn — boot-reconcile relaunch branch (EI-85)', () => {
  it('re-launches a queen unconditionally (the hive driver has no single work-item)', () => {
    expect(shouldRelaunchReclaimedSpawn({ childRole: 'queen', workItemId: null, workItemStatus: null })).toBe(true);
    // even with an (unused) work-item that happens to be terminal, a queen re-launches
    expect(shouldRelaunchReclaimedSpawn({ childRole: 'queen', workItemId: 'F-1', workItemStatus: 'passed' })).toBe(true);
  });

  it('re-launches a bee whose work-item is NON-terminal (in_progress / validating / failing / wip)', () => {
    for (const status of ['in_progress', 'validating', 'failing', 'wip', 'todo', 'needs-human', 'blocked']) {
      expect(shouldRelaunchReclaimedSpawn({ childRole: 'bee', workItemId: 'F-1', workItemStatus: status })).toBe(true);
    }
  });

  it('RECLAIMS (does NOT re-launch) a bee whose work-item is TERMINAL (passed / deprecated)', () => {
    expect(shouldRelaunchReclaimedSpawn({ childRole: 'bee', workItemId: 'F-1', workItemStatus: 'passed' })).toBe(false);
    expect(shouldRelaunchReclaimedSpawn({ childRole: 'bee', workItemId: 'F-1', workItemStatus: 'deprecated' })).toBe(false);
  });

  it('RECLAIMS a bee with NO work-item, or whose work-item row is gone (status null)', () => {
    expect(shouldRelaunchReclaimedSpawn({ childRole: 'bee', workItemId: null, workItemStatus: null })).toBe(false);
    expect(shouldRelaunchReclaimedSpawn({ childRole: 'bee', workItemId: 'F-gone', workItemStatus: null })).toBe(false);
  });

  it('RECLAIMS every non-queen/bee role (the reclaim-to-failed floor is unchanged for them)', () => {
    for (const role of ['worker', 'scoper', 'doc-steward', 'release-fixer', 'operator', 'architect']) {
      expect(shouldRelaunchReclaimedSpawn({ childRole: role, workItemId: 'F-1', workItemStatus: 'in_progress' })).toBe(false);
    }
  });
});
