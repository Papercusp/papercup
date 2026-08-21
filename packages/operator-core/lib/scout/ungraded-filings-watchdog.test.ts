/**
 * su-ideate ungraded-filings grading backstop (su-ideate-learning-substrate-2026-07-10
 * P-006 — the draft-review-watchdog port). Pure tests for the stale-filing selection
 * (threshold + the D-013 epoch floor + the D-013 batch cap), the per-pot nudge
 * decision, the env tunable / kill switch, and the two-half fire (best-effort
 * event-key wake + durable @role:mug park). The IO deps are mocked only so importing
 * the module has no load-time side effects (mirrors draft-review-watchdog.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';

const { dbRows } = vi.hoisted(() => ({ dbRows: { current: [] as unknown[] } }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: () => Promise.resolve(dbRows.current) }),
}));
vi.mock('../pot/started', () => ({
  listBlenderMaintenanceScopes: vi.fn(),
  listBlenderMaintenanceWorkspaceIds: vi.fn(() => []),
}));
const { wakeMug } = vi.hoisted(() => ({ wakeMug: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../pot/placement-watchdog', () => ({ resolveMugOwner: vi.fn(), wakeMug }));
vi.mock('../pot/watchdog', () => ({ recentWatchdogFires: vi.fn(), recordFire: vi.fn() }));

import { listBlenderMaintenanceScopes, listBlenderMaintenanceWorkspaceIds } from '../pot/started';
import {
  selectUngradedFilings,
  shouldNudgeMug,
  suIdeateUngradedStaleSec,
  suIdeateUngradedConfig,
  suIdeateUngradedSweep,
  fireGradingNudge,
  SU_IDEATE_UNGRADED_EPOCH_MS,
  SU_IDEATE_UNGRADED_BATCH_CAP,
  type SuUngradedCandidate,
} from './ungraded-filings-watchdog';

const DAY = 86_400_000;
const NOW = 100 * DAY;

afterEach(() => {
  dbRows.current = [];
  vi.mocked(listBlenderMaintenanceScopes).mockReset();
  vi.mocked(listBlenderMaintenanceWorkspaceIds).mockReset().mockReturnValue([]);
});

function filing(ideaId: string, ageDays: number): SuUngradedCandidate {
  return { ideaId, title: null, routedRef: `wi:${ideaId}`, routedAtMs: NOW - ageDays * DAY };
}

describe('selectUngradedFilings', () => {
  // epochMs pinned to 0 so these cases exercise the threshold alone; the D-013
  // floor gets its own block below.
  const opts = { now: NOW, thresholdMs: 7 * DAY, epochMs: 0 };

  it('selects only filings past the staleness threshold', () => {
    const got = selectUngradedFilings([filing('fresh', 1), filing('stale', 14)], opts);
    expect(got.map((f) => f.ideaId)).toEqual(['stale']);
  });

  it('treats a filing exactly at the threshold as stale (>=)', () => {
    const got = selectUngradedFilings([filing('edge', 7)], opts);
    expect(got.map((f) => f.ideaId)).toEqual(['edge']);
  });

  it('returns the stale filings oldest-first', () => {
    const got = selectUngradedFilings([filing('newer', 8), filing('oldest', 30), filing('mid', 12)], opts);
    expect(got.map((f) => f.ideaId)).toEqual(['oldest', 'mid', 'newer']);
  });

  it('selects nothing when nothing is stale (default-safe — no nudge)', () => {
    expect(selectUngradedFilings([filing('a', 1), filing('b', 3)], opts)).toEqual([]);
  });

  it('selects nothing when the threshold is <= 0 (kill switch)', () => {
    expect(selectUngradedFilings([filing('stale', 999)], { now: NOW, thresholdMs: 0, epochMs: 0 })).toEqual([]);
    expect(selectUngradedFilings([filing('stale', 999)], { now: NOW, thresholdMs: -1, epochMs: 0 })).toEqual([]);
  });

  it('never selects a filing with a non-finite timestamp (never act blind)', () => {
    const bad: SuUngradedCandidate = { ideaId: 'nan', title: null, routedRef: 'wi:nan', routedAtMs: Number.NaN };
    expect(selectUngradedFilings([bad], opts)).toEqual([]);
  });
});

describe('D-013 flood guards (the backfilled corpus must not flood triage)', () => {
  it('never selects a filing routed before the enablement epoch, however stale', () => {
    const epochMs = 50 * DAY;
    const pre = { ...filing('pre-epoch', 60), routedAtMs: epochMs - 1 };
    const post = { ...filing('post-epoch', 10), routedAtMs: epochMs + DAY };
    const got = selectUngradedFilings([pre, post], { now: NOW, thresholdMs: 7 * DAY, epochMs });
    expect(got.map((f) => f.ideaId)).toEqual(['post-epoch']);
  });

  it('a filing routed exactly at the epoch is eligible (>=)', () => {
    const epochMs = 50 * DAY;
    const at = { ...filing('at-epoch', 50), routedAtMs: epochMs };
    const got = selectUngradedFilings([at], { now: NOW, thresholdMs: 7 * DAY, epochMs });
    expect(got.map((f) => f.ideaId)).toEqual(['at-epoch']);
  });

  it('caps the batch at `cap`, keeping the OLDEST filings', () => {
    const got = selectUngradedFilings(
      [filing('d8', 8), filing('d30', 30), filing('d12', 12), filing('d20', 20)],
      { now: NOW, thresholdMs: 7 * DAY, epochMs: 0, cap: 2 },
    );
    expect(got.map((f) => f.ideaId)).toEqual(['d30', 'd20']);
  });

  it('defaults the cap to SU_IDEATE_UNGRADED_BATCH_CAP', () => {
    const many = Array.from({ length: SU_IDEATE_UNGRADED_BATCH_CAP + 5 }, (_, i) => filing(`f${i}`, 8 + i));
    const got = selectUngradedFilings(many, { now: NOW, thresholdMs: 7 * DAY, epochMs: 0 });
    expect(got).toHaveLength(SU_IDEATE_UNGRADED_BATCH_CAP);
  });

  it('the default epoch floor is the P-006 enablement date (rows before it stay silent)', () => {
    // The live ledger's 85-row pre-P-006 corpus is all routed before this instant;
    // pinning the constant keeps a refactor from silently re-opening the floodgate.
    expect(SU_IDEATE_UNGRADED_EPOCH_MS).toBe(Date.parse('2026-07-11T00:00:00Z'));
    const stale = { ...filing('backfill', 999), routedAtMs: SU_IDEATE_UNGRADED_EPOCH_MS - 1 };
    expect(selectUngradedFilings([stale], { now: Date.now(), thresholdMs: 7 * DAY })).toEqual([]);
  });
});

describe('shouldNudgeMug', () => {
  it('nudges when there is a stale ungraded filing and not debounced', () => {
    expect(shouldNudgeMug({ staleCount: 2, alreadyFiredRecently: false })).toBe(true);
  });
  it('skips when nothing is stale', () => {
    expect(shouldNudgeMug({ staleCount: 0, alreadyFiredRecently: false })).toBe(false);
  });
  it('skips when already fired within the window (debounce)', () => {
    expect(shouldNudgeMug({ staleCount: 5, alreadyFiredRecently: true })).toBe(false);
  });
});

describe('fireGradingNudge (the WI-2187 stable Mug seam)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes the concrete owner and payload to the shared Mug wake seam', async () => {
    await fireGradingNudge('ws-1', 'mug-owner-123', [filing('idea-su-1', 10)], 604_800);
    expect(wakeMug).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', mugOwner: 'mug-owner-123', source: 'su-ideate-ungraded',
      summary: expect.stringContaining('idea-su-1'),
    }));
  });

  it('parks through the durable seam even when no concrete Mug owner exists', async () => {
    await fireGradingNudge('ws-1', null, [filing('idea-su-2', 10)], 604_800, 'pot-1');
    expect(wakeMug).toHaveBeenCalledWith(expect.objectContaining({ mugOwner: null, harnessSlug: 'pot-1' }));
  });
});

describe('suIdeateUngradedStaleSec tunable', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to a 7d stale threshold', () => {
    delete process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC;
    expect(suIdeateUngradedStaleSec()).toBe(604_800);
  });

  it('honors PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '86400';
    expect(suIdeateUngradedStaleSec()).toBe(86_400);
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '0';
    expect(suIdeateUngradedStaleSec()).toBe(0);
  });

  it('falls back to the default on a non-numeric value (fail-soft)', () => {
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = 'nonsense';
    expect(suIdeateUngradedStaleSec()).toBe(604_800);
    expect(suIdeateUngradedConfig()).toMatchObject({
      enabled: true,
      effectiveThresholdSec: 604_800,
      overrideSource: 'invalid-environment-fallback',
      rawOverride: 'nonsense',
    });
  });

  it('reports the effective source and kill-switch state from the same config reader as the sweep', () => {
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '0';
    expect(suIdeateUngradedConfig()).toMatchObject({
      enabled: false,
      effectiveThresholdSec: 0,
      overrideSource: 'environment',
      epochMs: SU_IDEATE_UNGRADED_EPOCH_MS,
      batchCap: SU_IDEATE_UNGRADED_BATCH_CAP,
    });
  });
});

describe('suIdeateUngradedSweep observability', () => {
  it('returns a live error invariant when eligible backlog exists but no Blender scope is evaluated', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValueOnce([]);
    vi.mocked(listBlenderMaintenanceWorkspaceIds).mockReturnValueOnce(['ws-1']);
    dbRows.current = [{ c: 3 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await suIdeateUngradedSweep({ now: SU_IDEATE_UNGRADED_EPOCH_MS + 30 * DAY });

    expect(result).toEqual([
      expect.objectContaining({
        outcome: 'error',
        evaluatedWorkspaceCount: 0,
        evaluatedScopeCount: 0,
        eligibleBacklogCount: 3,
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no registered Blender scopes'));
    warn.mockRestore();
  });

  it('returns a synthetic error result when the outer infrastructure read fails', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockRejectedValueOnce(new Error('scope registry unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await suIdeateUngradedSweep();
    expect(result).toEqual([
      {
        workspaceId: '*',
        installSlug: '*',
        outcome: 'error',
        evaluatedWorkspaceCount: 0,
        evaluatedScopeCount: 0,
        eligibleBacklogCount: 0,
        staleCount: 0,
        reason: 'scope registry unavailable',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scope registry unavailable'));
    warn.mockRestore();
  });
});
