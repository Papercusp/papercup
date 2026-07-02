/**
 * compaction-compliance-watchdog.test.ts — seeding + over-limit sweep
 * (agent-managed-compaction P-009 · context-trimming-tiers P-006/D-006).
 *
 * The seeding step is THE hook that arms agent-managed compaction: the
 * P-007 usage signal and self-compaction only engage for sessions whose
 * presence row carries a compaction_limit, and nothing else writes one by
 * default. Mocks the estimator/spec-resolver/presence writes; drives the
 * sweep with a fake `sql` tag that answers the two queries by shape.
 *
 * Run: cd packages/operator-core && npx vitest run lib/system-health/compaction-compliance-watchdog.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { estimateMock, specMock, setEstimateMock, setLimitMock } = vi.hoisted(() => ({
  estimateMock: vi.fn(),
  specMock: vi.fn(),
  setEstimateMock: vi.fn(async () => {}),
  setLimitMock: vi.fn(async () => {}),
}));
vi.mock('../compaction-usage', () => ({
  estimateContextTokensForOwner: estimateMock,
  resolveModelSpecForOwner: specMock,
}));
vi.mock('../agent-tools/coordination/presence', () => ({
  setContextEstimate: setEstimateMock,
  setCompactionLimit: setLimitMock,
}));

import { checkCompactionCompliance } from './compaction-compliance-watchdog';

/** Fake postgres tag: routes on the query text — the seed query selects
 *  `compaction_limit IS NULL`, the sweep `IS NOT NULL`. */
function fakeSql(opts: { unseeded?: Array<{ owner_id: string }>; seeded?: Array<{ owner_id: string; owner_label: string; compaction_limit: number }> }) {
  return ((strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('compaction_limit IS NULL')) return Promise.resolve(opts.unseeded ?? []);
    if (q.includes('compaction_limit IS NOT NULL')) return Promise.resolve(opts.seeded ?? []);
    return Promise.resolve([]);
  }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The watchdog narrates seeds/over-limit crossings on the console by design;
  // silence it so vitest-fail-on-console doesn't flag the expected output.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkCompactionCompliance seeding (context-trimming-tiers P-006)', () => {
  it('seeds the model-derived default for limit-less live sessions: [1m] → 825k, unresolvable → 158k', async () => {
    specMock.mockImplementation(async (owner: string) =>
      owner === 'su-wide' ? 'claude-fable-5[1m]' : null,
    );
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'su-wide' }, { owner_id: 'su-narrow' }] }),
    );
    expect(out.seeded).toEqual(['su-wide', 'su-narrow']);
    expect(setLimitMock).toHaveBeenCalledWith('su-wide', 825_000);
    expect(setLimitMock).toHaveBeenCalledWith('su-narrow', 158_000);
  });

  it('a per-owner seed failure never fails the pass (best-effort)', async () => {
    specMock.mockResolvedValue(null);
    setLimitMock.mockRejectedValueOnce(new Error('pg down'));
    const out = await checkCompactionCompliance(
      fakeSql({ unseeded: [{ owner_id: 'a' }, { owner_id: 'b' }] }),
    );
    expect(out.seeded).toEqual(['b']); // 'a' failed silently, 'b' seeded
  });
});

describe('checkCompactionCompliance sweep (agent-managed-compaction P-009)', () => {
  it('caches estimates and flags sessions over their own limit', async () => {
    estimateMock.mockImplementation(async (owner: string) => (owner === 'hot' ? 170_000 : 40_000));
    const out = await checkCompactionCompliance(
      fakeSql({
        seeded: [
          { owner_id: 'hot', owner_label: 'su · hot', compaction_limit: 158_000 },
          { owner_id: 'cool', owner_label: 'su · cool', compaction_limit: 158_000 },
        ],
      }),
    );
    expect(out.estimated).toEqual(['hot', 'cool']);
    expect(out.overLimit).toEqual(['hot']);
    expect(setEstimateMock).toHaveBeenCalledWith('hot', 170_000);
  });
});
