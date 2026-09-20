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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// Only the coverage probe is faked; every other ungraded-scope export stays real, so a
// default of 0 leaves the pre-existing suites reading exactly as they did before.
const { outsideScopes } = vi.hoisted(() => ({
  outsideScopes: vi.fn<(...args: never[]) => Promise<number>>(),
}));
vi.mock('./ungraded-scope', async (orig) => ({
  ...(await orig<typeof import('./ungraded-scope')>()),
  countActionableUngradedOutsideScopes: outsideScopes,
}));

import { listBlenderMaintenanceScopes, listBlenderMaintenanceWorkspaceIds } from '../pot/started';
import {
  selectUngradedFilings,
  shouldNudgeMug,
  ungradedFilingsStaleSec,
  ungradedFilingsConfig,
  ungradedFilingsSweep,
  ungradedFireScopeKey,
  fireGradingNudge,
  SU_IDEATE_UNGRADED_EPOCH_MS,
  UNGRADED_BATCH_CAP,
  UNGRADED_NUDGE_SOURCE,
  type UngradedCandidate,
} from './ungraded-filings-watchdog';
import {
  DEFAULT_UNGRADED_EPOCH_POLICY,
  SCOUT_UNGRADED_EPOCH_MS,
  epochMsForOrigin,
} from './ungraded-scope';

const DAY = 86_400_000;
const NOW = 100 * DAY;

afterEach(() => {
  dbRows.current = [];
  vi.mocked(listBlenderMaintenanceScopes).mockReset();
  vi.mocked(listBlenderMaintenanceWorkspaceIds).mockReset().mockReturnValue([]);
  outsideScopes.mockReset().mockResolvedValue(0);
});

function filing(ideaId: string, ageDays: number, origin = 'su-ideate'): UngradedCandidate {
  return { ideaId, origin, title: null, routedRef: `wi:${ideaId}`, routedAtMs: NOW - ageDays * DAY };
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
    const bad: UngradedCandidate = {
      ideaId: 'nan',
      origin: 'su-ideate',
      title: null,
      routedRef: 'wi:nan',
      routedAtMs: Number.NaN,
    };
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

  it('defaults the cap to UNGRADED_BATCH_CAP', () => {
    const many = Array.from({ length: UNGRADED_BATCH_CAP + 5 }, (_, i) => filing(`f${i}`, 8 + i));
    const got = selectUngradedFilings(many, { now: NOW, thresholdMs: 7 * DAY, epochMs: 0 });
    expect(got).toHaveLength(UNGRADED_BATCH_CAP);
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
    expect(ungradedFilingsStaleSec()).toBe(604_800);
  });

  it('honors PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '86400';
    expect(ungradedFilingsStaleSec()).toBe(86_400);
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '0';
    expect(ungradedFilingsStaleSec()).toBe(0);
  });

  it('falls back to the default on a non-numeric value (fail-soft)', () => {
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = 'nonsense';
    expect(ungradedFilingsStaleSec()).toBe(604_800);
    expect(ungradedFilingsConfig()).toMatchObject({
      enabled: true,
      effectiveThresholdSec: 604_800,
      overrideSource: 'invalid-environment-fallback',
      rawOverride: 'nonsense',
    });
  });

  it('reports the effective source and kill-switch state from the same config reader as the sweep', () => {
    process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC = '0';
    expect(ungradedFilingsConfig()).toMatchObject({
      enabled: false,
      effectiveThresholdSec: 0,
      overrideSource: 'environment',
      policy: DEFAULT_UNGRADED_EPOCH_POLICY,
      batchCap: UNGRADED_BATCH_CAP,
    });
    // P-001: the readback carries the WHOLE per-origin policy, not one origin's floor.
    // A single `epochMs` here is what let the rail's diagnostics describe every
    // producer with su-ideate's line.
    expect(ungradedFilingsConfig().policy.byOrigin['su-ideate']).toBe(SU_IDEATE_UNGRADED_EPOCH_MS);
    expect(ungradedFilingsConfig().policy.byOrigin.scout).toBe(SCOUT_UNGRADED_EPOCH_MS);
  });
});

describe('ungradedFilingsSweep observability', () => {
  it('returns a live error invariant when eligible backlog exists but no Blender scope is evaluated', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValueOnce([]);
    vi.mocked(listBlenderMaintenanceWorkspaceIds).mockReturnValueOnce(['ws-1']);
    dbRows.current = [{ c: 3 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ungradedFilingsSweep({ now: SU_IDEATE_UNGRADED_EPOCH_MS + 30 * DAY });

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
    const result = await ungradedFilingsSweep();
    expect(result).toEqual([
      {
        workspaceId: '*',
        installSlug: '*',
        origin: '*',
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

/**
 * WI-10002098 — the DETECTOR half of EI-23811029152367526.
 *
 * That item re-homed ONE stranded partition; these guard the CLASS, i.e. that something
 * still notices the next one. The defect was that the coverage probe's only call site sat
 * inside `if (scopes.length === 0)`, so it answered "did we have anything to look at?"
 * and never "is there backlog nobody can reach?". Those differ exactly when coverage is
 * PARTIAL — the common case, and the one that happened: 249 workspace-global `scout` rows
 * unreachable for a month while every registered partition graded normally and current.
 *
 * A coverage check that only fires at ZERO coverage is a liveness check, so the assertions
 * below are deliberately falsifiable in BOTH directions — re-gating the probe fails the
 * first, and a probe that cries wolf on a healthy workspace fails the third.
 */
describe('coverage is checked on every tick, not only at zero coverage (WI-10002098)', () => {
  const twoScopes = [
    { workspaceId: 'ws-1', installSlug: 'papercusp' },
    { workspaceId: 'ws-1', installSlug: 'portal' },
  ];
  const at = SU_IDEATE_UNGRADED_EPOCH_MS + 30 * DAY;

  it('REGRESSION: probes coverage even when scopes WERE evaluated', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValueOnce(twoScopes);
    dbRows.current = [];

    await ungradedFilingsSweep({ now: at });

    // The entire defect in one assertion: pre-fix, this path never called the probe.
    // Once per WORKSPACE, not once per scope — both fixtures share `ws-1`.
    expect(outsideScopes).toHaveBeenCalledTimes(1);
    expect(outsideScopes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: 'ws-1', harnessSlugs: ['papercusp', 'portal'] }),
    );
  });

  it('reports stale backlog no registered scope can reach', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValueOnce(twoScopes);
    dbRows.current = [];
    outsideScopes.mockResolvedValue(249);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await ungradedFilingsSweep({ now: at });

    expect(result).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-1',
        origin: '*',
        outcome: 'error',
        eligibleBacklogCount: 249,
        evaluatedScopeCount: 2,
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not reachable'));
    warn.mockRestore();
  });

  // The direction that decides whether this guard SURVIVES. A coverage alarm that fires
  // on a healthy workspace is deleted within the week, taking the real detector with it.
  it('stays silent when every stale filing is reachable', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValueOnce(twoScopes);
    dbRows.current = [];
    outsideScopes.mockResolvedValue(0);

    expect(await ungradedFilingsSweep({ now: at })).toEqual([]);
  });

  it('a probe that THREW is surfaced, never read as fully covered', async () => {
    vi.mocked(listBlenderMaintenanceScopes).mockResolvedValueOnce(twoScopes);
    dbRows.current = [];
    outsideScopes.mockRejectedValue(new Error('probe exploded'));

    const result = await ungradedFilingsSweep({ now: at });

    expect(result).toEqual([
      expect.objectContaining({
        outcome: 'error',
        reason: expect.stringContaining('probe exploded'),
      }),
    ]);
  });
});

/**
 * P-001 ANTI-REQUIREMENT GUARD (agent-review-filing-rail-and-class-aggregation-2026-09-05).
 *
 * The plan states it outright: adding `origin = 'agent-review'` beside the existing
 * `origin = 'su-ideate'` closes the measured gap and FAILS the requirement, because the
 * fourth producer strands exactly the same way. These assertions are what make that
 * distinction mechanical instead of a review opinion — a widening done by enumeration
 * passes every behavioural test above and only fails here.
 */
describe('the rail selects origins by construction, not by enumeration', () => {
  const source = readFileSync(join(__dirname, 'ungraded-filings-watchdog.ts'), 'utf8');
  // Strip block + line comments: the header DESCRIBES the origins it used to name, and
  // a guard that cannot tell prose from a predicate would forbid explaining the bug.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('names no producer origin in executable code', () => {
    // Deliberately checks the QUOTED literal, which is what a SQL predicate or an
    // `origin === '…'` branch needs. `UNGRADED_NUDGE_SOURCE`'s historical spelling is a
    // WatchdogSource value, not an origin, and contains no quoted origin token.
    const named = ["'su-ideate'", "'scout'", "'agent-review'", "'drill'"].filter((lit) =>
      code.includes(lit),
    );
    expect(
      named,
      'the sweep must resolve its origins from ungraded-scope.ts, never name one. A literal ' +
        'here means a fifth producer will strand exactly as agent-review did (EI-22180311569503146).',
    ).toEqual([]);
  });

  it('writes no human_grade predicate of its own', () => {
    // The population decision belongs to ungraded-scope.ts. This is the same property
    // its recurrence guard asserts from the other side; asserted here too so the rail
    // fails locally rather than only in the scope module's suite.
    expect(code).not.toMatch(/human_grade/);
  });

  it('CALIBRATION: the scan really reads this module (else both assertions are vacuous)', () => {
    expect(code).toContain('ungradedFilingsSweep');
    expect(code.length).toBeGreaterThan(2_000);
  });
});

describe('per-origin behaviour (P-001)', () => {
  it('judges each row against ITS OWN origin floor, not one shared line', () => {
    // A scout row and an su-ideate row with the SAME timestamp bucket differently,
    // because scout's floor (2026-08-12) is a month later than su-ideate's.
    const between = SU_IDEATE_UNGRADED_EPOCH_MS + DAY;
    expect(between).toBeLessThan(SCOUT_UNGRADED_EPOCH_MS);
    const now = SCOUT_UNGRADED_EPOCH_MS + 90 * DAY;
    const rows: UngradedCandidate[] = [
      { ...filing('su-row', 0, 'su-ideate'), routedAtMs: between },
      { ...filing('scout-row', 0, 'scout'), routedAtMs: between },
    ];
    const got = selectUngradedFilings(rows, { now, thresholdMs: 7 * DAY });
    expect(got.map((r) => r.ideaId)).toEqual(['su-row']);
  });

  it('includes an origin nobody has named, at the policy fallback floor', () => {
    // The promise ungraded-scope.ts always made about the COUNT, now true of the RAIL:
    // agent-review has no entry in byOrigin and is swept anyway.
    expect(DEFAULT_UNGRADED_EPOCH_POLICY.byOrigin['agent-review']).toBeUndefined();
    expect(epochMsForOrigin(DEFAULT_UNGRADED_EPOCH_POLICY, 'agent-review')).toBe(
      DEFAULT_UNGRADED_EPOCH_POLICY.fallbackMs,
    );
    const row = {
      ...filing('ar-1', 0, 'agent-review'),
      routedAtMs: DEFAULT_UNGRADED_EPOCH_POLICY.fallbackMs + DAY,
    };
    const got = selectUngradedFilings([row], {
      now: DEFAULT_UNGRADED_EPOCH_POLICY.fallbackMs + 30 * DAY,
      thresholdMs: 7 * DAY,
    });
    expect(got.map((r) => r.ideaId)).toEqual(['ar-1']);
  });

  it('gives each origin its own debounce slot under one shared WatchdogSource', () => {
    // Per-origin SOURCES would put the enumeration back into pot/watchdog.ts's closed
    // union; scopeKey is the mechanism that avoids it. The keys must differ, or the
    // loudest producer silences every other one for the whole debounce window.
    expect(UNGRADED_NUDGE_SOURCE).toBe('su-ideate-ungraded');
    expect(ungradedFireScopeKey('agent-review')).not.toBe(ungradedFireScopeKey('su-ideate'));
    expect(ungradedFireScopeKey('agent-review')).toContain('agent-review');
  });

  it('names the actual origin in the nudge it fires', async () => {
    // The old message said "su-ideate grading backstop" unconditionally. Nudging a
    // recipient to grade 1,397 agent-review filings under an su-ideate headline is how
    // a widened rail still reads as the narrow one.
    await fireGradingNudge('ws-1', null, [filing('ar-9', 10, 'agent-review')], 604_800, 'pot-1');
    expect(wakeMug).toHaveBeenCalledWith(
      expect.objectContaining({
        source: UNGRADED_NUDGE_SOURCE,
        summary: expect.stringContaining('agent-review grading backstop'),
        payload: expect.objectContaining({ origin: 'agent-review' }),
      }),
    );
  });
});
