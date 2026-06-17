/**
 * Standing-approval auto-upgrade detector — refreshCandidates +
 * markCandidateShown (operator-standing-candidates.ts).
 *
 * These exercise the real grouping/threshold/carry-forward logic that is
 * otherwise reachable only through PG (`withWorkspace`) and the
 * operator-state cache (`readOperatorState`/`writeOperatorState`). We mock:
 *   - `@papercusp/db-org`        → synthetic audit_log rows
 *   - `./operator-preferences`   → controllable standingApprovals list
 *   - `./operator-state-pg`      → in-memory candidate cache (read/write)
 *   - `./workspace-registry`     → a fixed active workspace id
 *
 * Time is frozen via vi.setSystemTime so the 24h window cutoff is
 * deterministic.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const NOW = Date.parse('2026-06-16T12:00:00.000Z');
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Shared mutable state lives on a hoisted object so the vi.mock factories
// (which are hoisted above normal `const`s) can close over it safely.
const h = vi.hoisted(() => {
  const state: {
    mockRows: { details: { capability?: string; target?: string }; ts: number }[];
    mockApprovals: { capability: string; targetHarness: string; confirmedAt: string }[];
    storedCandidates: unknown;
    withWorkspaceThrows: boolean;
  } = { mockRows: [], mockApprovals: [], storedCandidates: undefined, withWorkspaceThrows: false };
  return {
    state,
    withWorkspace: vi.fn(async (_id: string, fn: (tx: unknown) => Promise<unknown>) => {
      if (state.withWorkspaceThrows) throw new Error('pg down');
      // The impl calls tx as a tagged-template function; return our rows.
      const tx = () => Promise.resolve(state.mockRows);
      return fn(tx as never);
    }),
    loadPreferences: vi.fn(async () => ({ raw: '', standingApprovals: state.mockApprovals })),
    readOperatorState: vi.fn(async (_key: string) => state.storedCandidates),
    writeOperatorState: vi.fn(async (_key: string, payload: unknown) => {
      state.storedCandidates = payload;
    }),
  };
});

vi.mock('@papercusp/db-org', () => ({ withWorkspace: h.withWorkspace }));
vi.mock('./operator-preferences', () => ({ loadPreferences: h.loadPreferences }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: h.readOperatorState,
  writeOperatorState: h.writeOperatorState,
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

const { withWorkspace, loadPreferences, readOperatorState, writeOperatorState } = h;

import {
  refreshCandidates,
  markCandidateShown,
  type StandingCandidate,
} from './operator-standing-candidates';

/** Helper: an audit_log dispatch row N ms before NOW. */
function row(cap: string | undefined, target: string | undefined, agoMs: number) {
  return { details: { capability: cap, target }, ts: NOW - agoMs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.state.mockRows = [];
  h.state.mockApprovals = [];
  h.state.storedCandidates = undefined;
  h.state.withWorkspaceThrows = false;
  withWorkspace.mockClear();
  readOperatorState.mockClear();
  writeOperatorState.mockClear();
  loadPreferences.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshCandidates — grouping + threshold (Gap 5)', () => {
  it('surfaces a pair with EXACTLY 3 silent dispatches in-window', async () => {
    h.state.mockRows = [
      row('deploy', 'app-a', 1000),
      row('deploy', 'app-a', 2000),
      row('deploy', 'app-a', 3000),
    ];
    const out = await refreshCandidates();
    expect(out).toHaveLength(1);
    expect(out[0].capability).toBe('deploy');
    expect(out[0].targetHarness).toBe('app-a');
    expect(out[0].count).toBe(3);
    // lastSeenAt = the most recent (smallest ago) row.
    expect(out[0].lastSeenAt).toBe(new Date(NOW - 1000).toISOString());
  });

  it('does NOT surface a pair with only 2 dispatches (below threshold)', async () => {
    h.state.mockRows = [row('deploy', 'app-a', 1000), row('deploy', 'app-a', 2000)];
    const out = await refreshCandidates();
    expect(out).toEqual([]);
  });

  it('threshold boundary: 2 stays hidden, the 3rd flips it to surfaced', async () => {
    // Fault-injection anchor for 5a: the count===3 boundary is load-bearing.
    h.state.mockRows = [row('cap', 'tgt', 100), row('cap', 'tgt', 200)];
    expect(await refreshCandidates()).toHaveLength(0);
    h.state.mockRows = [...h.state.mockRows, row('cap', 'tgt', 300)];
    expect(await refreshCandidates()).toHaveLength(1);
  });

  it('groups distinct (capability,target) pairs independently', async () => {
    h.state.mockRows = [
      row('deploy', 'app-a', 100),
      row('deploy', 'app-a', 200),
      row('deploy', 'app-a', 300),
      row('publish', 'site-x', 100),
      row('publish', 'site-x', 200),
      // publish/site-x only has 2 → excluded
    ];
    const out = await refreshCandidates();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ capability: 'deploy', targetHarness: 'app-a', count: 3 });
  });
});

describe('refreshCandidates — window cutoff + filters (Gap 5)', () => {
  it('excludes dispatches older than 24h (ts >= cutoffMs)', async () => {
    // 3 in-window + 2 over-24h for the same pair. The query itself filters by
    // ts >= cutoffMs; we only feed rows the DB would return, so simulate it by
    // dropping out-of-window rows from h.state.mockRows. Here we keep exactly the 3
    // in-window rows to assert the in-window count surfaces (=3) and that an
    // out-of-window row does NOT inflate the count.
    h.state.mockRows = [
      row('deploy', 'app-a', 1000),
      row('deploy', 'app-a', WINDOW_MS - 1000), // just inside window
      row('deploy', 'app-a', WINDOW_MS + 60_000), // outside — would be filtered by SQL
    ];
    // The SQL `ts >= cutoffMs` is the real gate; emulate it the way the DB
    // would, so the test asserts the post-filter count is 2 (below threshold).
    const cutoff = NOW - WINDOW_MS;
    h.state.mockRows = h.state.mockRows.filter((r) => r.ts >= cutoff);
    const out = await refreshCandidates();
    // Only 2 rows survive the cutoff → below the threshold of 3.
    expect(out).toEqual([]);
  });

  it('filters out a pair the user has already approved', async () => {
    h.state.mockRows = [
      row('deploy', 'app-a', 100),
      row('deploy', 'app-a', 200),
      row('deploy', 'app-a', 300),
    ];
    h.state.mockApprovals = [{ capability: 'deploy', targetHarness: 'app-a', confirmedAt: '2026-06-01' }];
    const out = await refreshCandidates();
    expect(out).toEqual([]);
  });

  it('skips audit rows missing capability or target', async () => {
    h.state.mockRows = [
      row(undefined, 'app-a', 100),
      row('deploy', undefined, 200),
      row('deploy', 'app-a', 300),
      row('deploy', 'app-a', 400),
      row('deploy', 'app-a', 500),
    ];
    const out = await refreshCandidates();
    // Only the 3 fully-specified rows count → exactly at threshold.
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
  });

  it('returns cached candidates when the audit query throws', async () => {
    h.state.withWorkspaceThrows = true;
    h.state.storedCandidates = {
      candidates: [
        { capability: 'cached', targetHarness: 'h', count: 9, lastSeenAt: 'x', firstShownAt: null },
      ],
    };
    const out = await refreshCandidates();
    expect(out).toEqual((h.state.storedCandidates as { candidates: unknown[] }).candidates);
  });
});

describe('refreshCandidates — firstShownAt carry-forward (Gap 5d)', () => {
  it('carries forward a non-null firstShownAt for a still-qualifying pair', async () => {
    h.state.storedCandidates = {
      candidates: [
        {
          capability: 'deploy',
          targetHarness: 'app-a',
          count: 3,
          lastSeenAt: 'old',
          firstShownAt: '2026-06-15T09:00:00.000Z',
        },
      ],
    };
    h.state.mockRows = [
      row('deploy', 'app-a', 100),
      row('deploy', 'app-a', 200),
      row('deploy', 'app-a', 300),
    ];
    const out = await refreshCandidates();
    expect(out).toHaveLength(1);
    expect(out[0].firstShownAt).toBe('2026-06-15T09:00:00.000Z');
  });

  it('starts firstShownAt null for a freshly re-proposed pair (does NOT copy a prior null)', async () => {
    // Prior list had the pair but with firstShownAt === null → re-proposed
    // pairs must start null (user has not seen this round).
    h.state.storedCandidates = {
      candidates: [
        {
          capability: 'deploy',
          targetHarness: 'app-a',
          count: 3,
          lastSeenAt: 'old',
          firstShownAt: null,
        },
      ],
    };
    h.state.mockRows = [
      row('deploy', 'app-a', 100),
      row('deploy', 'app-a', 200),
      row('deploy', 'app-a', 300),
    ];
    const out = await refreshCandidates();
    expect(out[0].firstShownAt).toBeNull();
  });

  it('a brand-new pair (not in prior list) starts firstShownAt null', async () => {
    h.state.storedCandidates = { candidates: [] };
    h.state.mockRows = [
      row('publish', 'site-x', 100),
      row('publish', 'site-x', 200),
      row('publish', 'site-x', 300),
    ];
    const out = await refreshCandidates();
    expect(out[0].firstShownAt).toBeNull();
  });

  it('persists the recomputed list via writeOperatorState', async () => {
    h.state.mockRows = [
      row('deploy', 'app-a', 100),
      row('deploy', 'app-a', 200),
      row('deploy', 'app-a', 300),
    ];
    await refreshCandidates();
    expect(writeOperatorState).toHaveBeenCalledWith(
      'operator_standing_candidates',
      expect.objectContaining({ candidates: expect.any(Array) }),
    );
  });
});

describe('markCandidateShown — idempotency (Gap 6)', () => {
  const cand = (over: Partial<StandingCandidate>): StandingCandidate => ({
    capability: 'deploy',
    targetHarness: 'app-a',
    count: 3,
    lastSeenAt: 'x',
    firstShownAt: null,
    ...over,
  });

  it('sets firstShownAt to now when currently null', async () => {
    h.state.storedCandidates = { candidates: [cand({})] };
    await markCandidateShown('deploy', 'app-a');
    expect(writeOperatorState).toHaveBeenCalledTimes(1);
    const written = (h.state.storedCandidates as { candidates: StandingCandidate[] }).candidates[0];
    expect(written.firstShownAt).toBe(new Date(NOW).toISOString());
  });

  it('does NOT overwrite a non-null firstShownAt and does NOT write', async () => {
    h.state.storedCandidates = {
      candidates: [cand({ firstShownAt: '2026-06-10T00:00:00.000Z' })],
    };
    await markCandidateShown('deploy', 'app-a');
    expect(writeOperatorState).not.toHaveBeenCalled();
    const after = (h.state.storedCandidates as { candidates: StandingCandidate[] }).candidates[0];
    expect(after.firstShownAt).toBe('2026-06-10T00:00:00.000Z');
  });

  it('does NOT write when no candidate matches', async () => {
    h.state.storedCandidates = { candidates: [cand({})] };
    await markCandidateShown('nonexistent', 'nope');
    expect(writeOperatorState).not.toHaveBeenCalled();
  });

  it('only touches the matching (capability,targetHarness) row', async () => {
    h.state.storedCandidates = {
      candidates: [
        cand({ capability: 'deploy', targetHarness: 'app-a' }),
        cand({ capability: 'publish', targetHarness: 'site-x' }),
      ],
    };
    await markCandidateShown('deploy', 'app-a');
    const rows = (h.state.storedCandidates as { candidates: StandingCandidate[] }).candidates;
    expect(rows[0].firstShownAt).toBe(new Date(NOW).toISOString());
    expect(rows[1].firstShownAt).toBeNull();
  });
});
