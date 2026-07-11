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

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('../pot/started', () => ({ listStartedPots: vi.fn() }));
vi.mock('../pot/placement-watchdog', () => ({ resolveMugOwner: vi.fn() }));
vi.mock('../pot/watchdog', () => ({ recentWatchdogFires: vi.fn(), recordFire: vi.fn() }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: vi.fn() }));
const sendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage: (...args: unknown[]) => sendMessage(...args) }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_ws: string, fn: () => unknown) => fn() }));

import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import {
  selectUngradedFilings,
  shouldNudgeMug,
  suIdeateUngradedStaleSec,
  fireGradingNudge,
  SU_IDEATE_UNGRADED_EPOCH_MS,
  SU_IDEATE_UNGRADED_BATCH_CAP,
  type SuUngradedCandidate,
} from './ungraded-filings-watchdog';

const DAY = 86_400_000;
const NOW = 100 * DAY;

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

describe('fireGradingNudge (the WI-963 two-half delivery)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fires the best-effort event-key wake AND durably parks an @role:mug message', async () => {
    await fireGradingNudge('ws-1', 'mug-owner-123', [filing('idea-su-1', 10)], 604_800);

    // The event-key wake — best-effort (the resolved Mug owner id is often an
    // already-ended fresh-per-wake session by sweep time; harmless if so).
    expect(wakeRecipients).toHaveBeenCalledWith(
      ['mug-owner-123'],
      expect.objectContaining({ source: 'su-ideate-ungraded', workspaceId: 'ws-1' }),
    );

    // The RELIABLE half: a durable coord message addressed to the `@role:mug` slot,
    // sent inside the target workspace — mug-brief-launch.ts drains that slot into
    // the Mug's VERY NEXT wake brief regardless of which owner id it boots under.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = sendMessage.mock.calls[0] as [
      { ownerId: string; source: string; workspaceId: string },
      { to: string[]; summary: string; body: string },
    ];
    expect(identity.workspaceId).toBe('ws-1');
    expect(opts.to).toEqual(['@role:mug']);
    // The nudge names the filing + the grading verb (the Mug's next action).
    expect(opts.summary).toContain('idea-su-1');
    expect(opts.summary).toContain('blender:grade-idea');
    expect(opts.body).toContain('wi:idea-su-1');
  });

  it('a park failure never throws out of fireGradingNudge (best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockRejectedValueOnce(new Error('coord down'));
    await expect(
      fireGradingNudge('ws-1', 'mug-owner-1', [filing('idea-su-2', 10)], 604_800),
    ).resolves.toBeUndefined();
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('@role:mug park failed'));
    warn.mockRestore();
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
  });
});
