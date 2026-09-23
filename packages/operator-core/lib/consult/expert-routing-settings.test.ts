/**
 * expert-routing-settings.test.ts — consult-expert-routing-2026-09-22 P-005.
 *
 * The property under test is TOTALITY: every read path must yield a usable
 * policy. This module sits on the dispatch critical path, so "settings are
 * broken" has to degrade to the owner-stated seed, never to a throw and never
 * to an empty allowlist (which the dispatcher would report as
 * no_available_responder — a consult silently refused because a settings row
 * was malformed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  readOperatorState: vi.fn(),
  writeOperatorState: vi.fn(),
  invalidateOperatorStateCache: vi.fn(),
}));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: mocks.readOperatorState,
  writeOperatorState: mocks.writeOperatorState,
  invalidateOperatorStateCache: mocks.invalidateOperatorStateCache,
}));

import {
  bindConsultExpertRoutingSettings,
  readConsultExpertRoutingSettings,
  writeConsultExpertRoutingSettings,
  normalizeConsultExpertRoutingSettings,
  normalizeRecencyHalfLifeDays,
  seedConsultExpertRoutingSettings,
  loadExpertModelRanks,
  MIN_RECENCY_HALF_LIFE_DAYS,
  MAX_RECENCY_HALF_LIFE_DAYS,
} from './expert-routing-settings';
import { DEFAULT_RECENCY_HALF_LIFE_DAYS } from './relevance-router';

const WS = 'papercusp-workspace';

beforeEach(() => {
  mocks.readOperatorState.mockReset();
  mocks.writeOperatorState.mockReset();
  mocks.invalidateOperatorStateCache.mockReset();
});

describe('the seed is the owner-stated policy (D-004)', () => {
  it('seeds Claude opus/fable then ChatGPT sol/astra, densely ranked', () => {
    // D-006 fixes the owner-approved default order.
    expect(seedConsultExpertRoutingSettings().allowlist).toEqual([
      { rank: 1, agent: 'claude', model: 'fable' },
      { rank: 2, agent: 'claude', model: 'opus' },
      { rank: 3, agent: 'codex', model: 'sol' },
      { rank: 4, agent: 'codex', model: 'astra' },
    ]);
  });

  it('seeds the router default half-life rather than a second copy of it', () => {
    // Derived, not duplicated: relevance-router owns the number.
    expect(seedConsultExpertRoutingSettings().recencyHalfLifeDays).toBe(
      DEFAULT_RECENCY_HALF_LIFE_DAYS,
    );
  });
});

describe('route-time settings snapshot', () => {
  it('uses the same persisted snapshot for recency comparison and dispatch ranks', async () => {
    const settings = {
      allowlist: [{ rank: 1, agent: 'codex' as const, model: 'sol' }],
      recencyHalfLifeDays: 14,
    };
    const bound = bindConsultExpertRoutingSettings(settings);

    expect(bound.recencyHalfLifeDays).toBe(14);
    await expect(bound.loadRanks(WS)).resolves.toBe(settings.allowlist);
  });
});

describe('reads always yield a usable policy', () => {
  it('falls back to the seed when the workspace has no stored row', async () => {
    mocks.readOperatorState.mockResolvedValue(null);
    await expect(readConsultExpertRoutingSettings(WS)).resolves.toEqual(
      seedConsultExpertRoutingSettings(),
    );
  });

  it('falls back to the seed when the settings read THROWS', async () => {
    // A pre-migration box or a PG blip. The consult must still route.
    mocks.readOperatorState.mockRejectedValue(new Error('relation does not exist'));
    await expect(readConsultExpertRoutingSettings(WS)).resolves.toEqual(
      seedConsultExpertRoutingSettings(),
    );
  });

  it('falls back to the seed allowlist when the stored one normalizes to empty', async () => {
    // Every row malformed => an EMPTY list, which the dispatcher would read as
    // "no model may answer". That is an unusable setting, not a policy.
    mocks.readOperatorState.mockResolvedValue({ allowlist: [{ agent: 'nope', model: '' }] });
    const settings = await readConsultExpertRoutingSettings(WS);
    expect(settings.allowlist).toEqual(seedConsultExpertRoutingSettings().allowlist);
  });

  it('returns the stored allowlist when it is usable', async () => {
    mocks.readOperatorState.mockResolvedValue({
      allowlist: [{ rank: 1, agent: 'codex', model: 'sol' }],
      recencyHalfLifeDays: 14,
    });
    await expect(readConsultExpertRoutingSettings(WS)).resolves.toEqual({
      allowlist: [{ rank: 1, agent: 'codex', model: 'sol' }],
      recencyHalfLifeDays: 14,
    });
  });
});

describe('normalization', () => {
  it('re-numbers ranks densely so a GUI reorder cannot leave gaps', () => {
    const { allowlist } = normalizeConsultExpertRoutingSettings({
      allowlist: [
        { rank: 7, agent: 'codex', model: 'astra' },
        { rank: 1, agent: 'claude', model: 'opus' },
        { rank: 4, agent: 'claude', model: 'fable' },
      ],
    });
    expect(allowlist.map((e) => [e.rank, e.model])).toEqual([
      [1, 'opus'],
      [2, 'fable'],
      [3, 'astra'],
    ]);
  });

  it('drops a duplicate (backend, model) rather than spending a walk step on it', () => {
    const { allowlist } = normalizeConsultExpertRoutingSettings({
      allowlist: [
        { rank: 1, agent: 'claude', model: 'opus' },
        { rank: 2, agent: 'claude', model: 'opus' },
        { rank: 3, agent: 'codex', model: 'sol' },
      ],
    });
    expect(allowlist).toEqual([
      { rank: 1, agent: 'claude', model: 'opus' },
      { rank: 2, agent: 'codex', model: 'sol' },
    ]);
  });
});

describe('recency half-life bounds', () => {
  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined])(
    'falls back to the default for %p',
    (raw) => {
      expect(normalizeRecencyHalfLifeDays(raw)).toBe(DEFAULT_RECENCY_HALF_LIFE_DAYS);
    },
  );

  it('clamps into the usable band instead of flattening stage-2 ordering', () => {
    expect(normalizeRecencyHalfLifeDays(0.001)).toBe(MIN_RECENCY_HALF_LIFE_DAYS);
    expect(normalizeRecencyHalfLifeDays(10_000)).toBe(MAX_RECENCY_HALF_LIFE_DAYS);
  });

  it('passes an in-band value through unchanged', () => {
    expect(normalizeRecencyHalfLifeDays(14)).toBe(14);
  });
});

describe('loadExpertModelRanks (the ExpertModelAllowlistDeps.loadRanks seam)', () => {
  it('returns null with no stored row, so the resolver picks the seed itself', async () => {
    mocks.readOperatorState.mockResolvedValue(null);
    await expect(loadExpertModelRanks(WS)).resolves.toBeNull();
  });

  it('returns null when the stored allowlist normalizes to empty', async () => {
    // Null, NOT []: an empty array would be a positive claim that no model may
    // answer, and resolveExpertModelAllowlist would honour it.
    mocks.readOperatorState.mockResolvedValue({ allowlist: [] });
    await expect(loadExpertModelRanks(WS)).resolves.toBeNull();
  });

  it('returns the normalized ranks when a usable list is stored', async () => {
    mocks.readOperatorState.mockResolvedValue({
      allowlist: [{ rank: 9, agent: 'omp', model: 'astra' }],
    });
    await expect(loadExpertModelRanks(WS)).resolves.toEqual([
      { rank: 1, agent: 'omp', model: 'astra' },
    ]);
  });
});

describe('writes', () => {
  it('persists the NORMALIZED settings and returns what was stored', async () => {
    mocks.writeOperatorState.mockResolvedValue(undefined);
    const stored = await writeConsultExpertRoutingSettings(
      {
        allowlist: [
          { rank: 5, agent: 'codex', model: 'sol' },
          { rank: 2, agent: 'claude', model: 'opus' },
        ],
        recencyHalfLifeDays: 99_999,
      },
      WS,
    );

    const expected = {
      allowlist: [
        { rank: 1, agent: 'claude', model: 'opus' },
        { rank: 2, agent: 'codex', model: 'sol' },
      ],
      recencyHalfLifeDays: MAX_RECENCY_HALF_LIFE_DAYS,
    };
    expect(stored).toEqual(expected);
    expect(mocks.writeOperatorState).toHaveBeenCalledWith(
      'operator_consult_expert_routing',
      expected,
      WS,
    );
    expect(mocks.invalidateOperatorStateCache).toHaveBeenCalledWith(
      'operator_consult_expert_routing',
      WS,
    );
  });
});
