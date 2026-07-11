/**
 * Unit gates for the coord-deafness classifier
 * (coord-delivery-residual-gaps-2026-07-11 P-001). Pure logic only — the
 * batched tool_invocations read is a thin fail-soft query exercised live via
 * the presence overlay.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyCoordDeafness,
  coordDeafBudgetMs,
  DEFAULT_COORD_DEAF_BUDGET_MS,
  COORD_READ_TOOL_NAMES,
} from './inbox-read-freshness';

const NOW = Date.parse('2026-07-11T12:00:00Z');
const BUDGET = DEFAULT_COORD_DEAF_BUDGET_MS; // 10 min

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const liveRow = {
  sessionState: 'live' as const,
  lastActiveSecAgo: 30,
  startedAt: iso(60 * 60_000), // started an hour ago
};

describe('classifyCoordDeafness', () => {
  it('fresh read within budget → not deaf', () => {
    expect(
      classifyCoordDeafness({ ...liveRow, lastReadAt: iso(2 * 60_000) }, NOW, BUDGET),
    ).toBeNull();
  });

  it('live + active + read older than budget → stale, with lastReadAgoSec', () => {
    const v = classifyCoordDeafness({ ...liveRow, lastReadAt: iso(25 * 60_000) }, NOW, BUDGET);
    expect(v).toEqual({ state: 'stale', lastReadAgoSec: 25 * 60 });
  });

  it('live + active + NO read ever + session older than budget → missing', () => {
    const v = classifyCoordDeafness({ ...liveRow, lastReadAt: null }, NOW, BUDGET);
    expect(v).toEqual({ state: 'missing', lastReadAgoSec: null });
  });

  it('never-read but YOUNG session (grace) → not flagged', () => {
    expect(
      classifyCoordDeafness(
        { ...liveRow, startedAt: iso(3 * 60_000), lastReadAt: null },
        NOW,
        BUDGET,
      ),
    ).toBeNull();
  });

  it('parked / ended / unknown sessionState → never flagged (wake covers parked by design)', () => {
    for (const sessionState of ['parked', 'ended', null, undefined] as const) {
      expect(
        classifyCoordDeafness(
          { ...liveRow, sessionState, lastReadAt: iso(60 * 60_000) },
          NOW,
          BUDGET,
        ),
      ).toBeNull();
    }
  });

  it('idle session (lastActiveSecAgo past budget) → not deaf, just idle', () => {
    expect(
      classifyCoordDeafness(
        { ...liveRow, lastActiveSecAgo: 20 * 60, lastReadAt: iso(30 * 60_000) },
        NOW,
        BUDGET,
      ),
    ).toBeNull();
  });

  it('unknown activity (null / NaN / negative lastActiveSecAgo) fails toward null', () => {
    for (const lastActiveSecAgo of [null, undefined, Number.NaN, -5] as const) {
      expect(
        classifyCoordDeafness(
          { ...liveRow, lastActiveSecAgo, lastReadAt: iso(30 * 60_000) },
          NOW,
          BUDGET,
        ),
      ).toBeNull();
    }
  });

  it('no read + unknown/invalid startedAt fails toward null (never a false "missing")', () => {
    for (const startedAt of [null, undefined, 'not-a-date'] as const) {
      expect(
        classifyCoordDeafness({ ...liveRow, startedAt, lastReadAt: null }, NOW, BUDGET),
      ).toBeNull();
    }
  });

  it('boundary: read exactly AT budget age is not deaf; one second past is', () => {
    expect(classifyCoordDeafness({ ...liveRow, lastReadAt: iso(BUDGET) }, NOW, BUDGET)).toBeNull();
    const v = classifyCoordDeafness({ ...liveRow, lastReadAt: iso(BUDGET + 1000) }, NOW, BUDGET);
    expect(v?.state).toBe('stale');
  });
});

describe('coordDeafBudgetMs', () => {
  it('defaults when unset/garbage; clamps to ≥1 min; honors a sane override', () => {
    expect(coordDeafBudgetMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_COORD_DEAF_BUDGET_MS);
    expect(coordDeafBudgetMs({ PAPERCUSP_COORD_DEAF_BUDGET_MS: 'nope' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_COORD_DEAF_BUDGET_MS,
    );
    expect(coordDeafBudgetMs({ PAPERCUSP_COORD_DEAF_BUDGET_MS: '-1' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_COORD_DEAF_BUDGET_MS,
    );
    expect(coordDeafBudgetMs({ PAPERCUSP_COORD_DEAF_BUDGET_MS: '5' } as NodeJS.ProcessEnv)).toBe(
      60_000,
    );
    expect(
      coordDeafBudgetMs({ PAPERCUSP_COORD_DEAF_BUDGET_MS: '300000' } as NodeJS.ProcessEnv),
    ).toBe(300_000);
  });
});

describe('COORD_READ_TOOL_NAMES', () => {
  it('carries both colon and underscore spellings of inbox + orient', () => {
    expect([...COORD_READ_TOOL_NAMES].sort()).toEqual(
      ['coord:inbox', 'coord:orient', 'coord_inbox', 'coord_orient'].sort(),
    );
  });
});
