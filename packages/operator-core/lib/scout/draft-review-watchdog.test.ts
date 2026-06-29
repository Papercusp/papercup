/**
 * Scout-draft review backstop (queen-scout-feedback-loop-2026-06-20 D-003 #2, hardening).
 * Pure tests for the stale-draft selection + the per-hive nudge decision + the env
 * tunable / kill switch. The IO deps are mocked only so importing the module has no
 * load-time side effects (mirrors hive/watchdog-paused-recovery.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('../hive/started', () => ({ listStartedHives: vi.fn() }));
vi.mock('../hive/placement-watchdog', () => ({ resolveQueenOwner: vi.fn() }));
vi.mock('../hive/watchdog', () => ({ recentWatchdogFires: vi.fn(), recordFire: vi.fn() }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: vi.fn() }));

import {
  selectStaleDrafts,
  shouldNudgeHive,
  scoutDraftReviewStaleSec,
  type ScoutDraftCandidate,
} from './draft-review-watchdog';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function draft(slug: string, ageHours: number): ScoutDraftCandidate {
  return { planSlug: slug, title: null, updatedAtMs: NOW - ageHours * HOUR };
}

describe('selectStaleDrafts', () => {
  const opts = { now: NOW, thresholdMs: 12 * HOUR };

  it('selects only drafts past the staleness threshold', () => {
    const got = selectStaleDrafts([draft('fresh', 1), draft('stale', 24)], opts);
    expect(got.map((d) => d.planSlug)).toEqual(['stale']);
  });

  it('treats a draft exactly at the threshold as stale (>=)', () => {
    const got = selectStaleDrafts([draft('edge', 12)], opts);
    expect(got.map((d) => d.planSlug)).toEqual(['edge']);
  });

  it('returns the stale drafts oldest-first', () => {
    const got = selectStaleDrafts([draft('newer', 13), draft('oldest', 48), draft('mid', 20)], opts);
    expect(got.map((d) => d.planSlug)).toEqual(['oldest', 'mid', 'newer']);
  });

  it('selects nothing when nothing is stale (default-safe — no wake)', () => {
    expect(selectStaleDrafts([draft('a', 1), draft('b', 5)], opts)).toEqual([]);
  });

  it('selects nothing when the threshold is <= 0 (kill switch)', () => {
    expect(selectStaleDrafts([draft('stale', 999)], { now: NOW, thresholdMs: 0 })).toEqual([]);
    expect(selectStaleDrafts([draft('stale', 999)], { now: NOW, thresholdMs: -1 })).toEqual([]);
  });

  it('never selects a draft with a non-finite timestamp (never act blind)', () => {
    const bad: ScoutDraftCandidate = { planSlug: 'nan', title: null, updatedAtMs: Number.NaN };
    expect(selectStaleDrafts([bad], opts)).toEqual([]);
  });
});

describe('shouldNudgeHive', () => {
  it('nudges when there is a stale draft and not debounced', () => {
    expect(shouldNudgeHive({ staleCount: 2, alreadyFiredRecently: false })).toBe(true);
  });
  it('skips when nothing is stale', () => {
    expect(shouldNudgeHive({ staleCount: 0, alreadyFiredRecently: false })).toBe(false);
  });
  it('skips when already fired within the window (debounce)', () => {
    expect(shouldNudgeHive({ staleCount: 5, alreadyFiredRecently: true })).toBe(false);
  });
});

describe('scoutDraftReviewStaleSec tunable', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to a 12h stale threshold', () => {
    delete process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC;
    expect(scoutDraftReviewStaleSec()).toBe(43_200);
  });

  it('honors PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC (and <=0 = kill switch)', () => {
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '7200';
    expect(scoutDraftReviewStaleSec()).toBe(7_200);
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = '0';
    expect(scoutDraftReviewStaleSec()).toBe(0);
  });

  it('falls back to the default on a non-numeric value (fail-soft)', () => {
    process.env.PAPERCUSP_SCOUT_DRAFT_REVIEW_STALE_SEC = 'nonsense';
    expect(scoutDraftReviewStaleSec()).toBe(43_200);
  });
});
