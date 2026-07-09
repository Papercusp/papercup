import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import digestTool, { boundDigestForSerialization, DIGEST_MAX_BYTES } from './digest';
import { readImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import { applyHumanQueueRanking } from '../../queue-ranker/human-queue';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: read-items / digest / human-queue each have their own suites;
// this pins the tool's compose order — read → buildDigest → applyHumanQueueRanking
// — the arg pass-through, and the { ok, digest } envelope. The human-lane MUST go
// through the ONE ranker so the tool and the Learning-tab resolver can't drift.
vi.mock('../../harness/improvements/read-items');
vi.mock('../../harness/improvements/digest');
vi.mock('../../queue-ranker/human-queue');
vi.mock('../coordination/identity');

const mockRead = vi.mocked(readImprovementItems);
const mockBuild = vi.mocked(buildDigest);
const mockRank = vi.mocked(applyHumanQueueRanking);
const mockIdentity = vi.mocked(resolveAgentIdentity);

function callTool(args: Record<string, unknown>, ctx: unknown = {}) {
  return (
    digestTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('improvements:digest tool envelope', () => {
  const ITEMS = [{ id: 'EI-1' }, { id: 'EI-2' }] as unknown as Awaited<ReturnType<typeof readImprovementItems>>;
  const BUILT = { auto: [], human: [] } as unknown as ReturnType<typeof buildDigest>;
  const RANKED = { auto: [], human: [{ id: 'EI-1', rank: 1 }] } as unknown as Awaited<
    ReturnType<typeof applyHumanQueueRanking>
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockRead.mockResolvedValue(ITEMS);
    mockBuild.mockReturnValue(BUILT);
    mockRank.mockResolvedValue(RANKED);
    // MUG_FULL_AUTONOMY graduated to default-ON (flip-dark-flags-default-on-2026-06-23). This
    // compose-order test asserts ownerFullAutonomy:false, so pin the flag OFF via the env override
    // (readOwnerFullAutonomyGrant uses the real getFlag, which honors PAPERCUSP_FLAG_*).
    process.env.PAPERCUSP_FLAG_PAPERCUSP_QUEEN_FULL_AUTONOMY = '0';
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_FLAG_PAPERCUSP_QUEEN_FULL_AUTONOMY;
  });

  it('passes state/limit/harnessSlug through to the read', async () => {
    await callTool({ state: 'open', limit: 25, harnessSlug: 'foo' });
    expect(mockRead).toHaveBeenCalledWith({ state: 'open', limit: 25, harnessSlug: 'foo' });
  });

  it('defaults every filter to undefined when args are omitted (rollups see resolved too)', async () => {
    await callTool({});
    expect(mockRead).toHaveBeenCalledWith({ state: undefined, limit: undefined, harnessSlug: undefined });
  });

  it('builds the digest from the read items, then ranks the human lane with the same items as candidates', async () => {
    await callTool({});
    expect(mockBuild).toHaveBeenCalledWith(ITEMS, { nowMs: expect.any(Number), ownerFullAutonomy: false });
    expect(mockRank).toHaveBeenCalledWith(BUILT, { candidates: ITEMS });
  });

  it('returns { ok:true, digest:<ranked> } — the ranked digest, not the raw build', async () => {
    const res = await callTool({});
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, digest: RANKED });
  });

  it('EI-1715: a read that exceeds the deadline → fast DEGRADED-but-valid digest (the Queen survey turn does NOT abort)', async () => {
    const prev = process.env.PAPERCUSP_DIGEST_TIMEOUT_MS;
    process.env.PAPERCUSP_DIGEST_TIMEOUT_MS = '15';
    try {
      mockRead.mockImplementation(() => new Promise(() => {}) as ReturnType<typeof readImprovementItems>); // never resolves (PG contention)
      const res = await callTool({});
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);          // a VALID response → the turn continues to declare-wake
      expect(body.degraded).toBe(true);
      expect(body.reason).toBe('digest_timeout');
      expect(body.digest).toBeDefined();
      // the degraded shape is the pure buildDigest([]) (no DB), not the hung read
      expect(mockBuild).toHaveBeenCalledWith([], { nowMs: expect.any(Number), ownerFullAutonomy: false });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_DIGEST_TIMEOUT_MS;
      else process.env.PAPERCUSP_DIGEST_TIMEOUT_MS = prev;
    }
  });
});

// EI-5350: the no-`limit` overflow guard. The cap must bite ONLY over budget, keep
// every rollup, and truncate the per-item arrays with a clear flag (the same
// truncate-and-flag pattern the bulk tools use).
function digestWith(autoEligibleCount: number) {
  return {
    generatedAt: '2026-06-30T00:00:00.000Z',
    total: autoEligibleCount,
    byKind: { bug: autoEligibleCount },
    headline: 'rollup headline that must survive truncation',
    recurringSignatures: [{ signature: 'x', count: 3 }],
    humanQueue: [],
    likelyDuplicates: [],
    autoEligible: Array.from({ length: autoEligibleCount }, (_, i) => ({
      id: `EI-${1000 + i}`,
      title: `item ${i} with a reasonably long title to take up some serialized bytes`,
      scope: 'operator',
      score: 15,
      tierReason: 'no protected path/keyword → AUTO-eligible (still gated by blueprint + tests)',
    })),
  };
}

describe('boundDigestForSerialization (EI-5350 byte-cap)', () => {
  it('returns the digest UNCHANGED when under budget', () => {
    const d = digestWith(3);
    expect(boundDigestForSerialization(d)).toBe(d); // same reference, no copy
    expect((boundDigestForSerialization(d) as Record<string, unknown>).truncated).toBeUndefined();
  });

  it('truncates oversized per-item arrays and adds a `truncated` flag when over budget', () => {
    const d = digestWith(300);
    const out = boundDigestForSerialization(d, { maxBytes: 2000, perArrayCap: 50 }) as Record<string, any>;
    expect(out.autoEligible).toHaveLength(50);
    expect(out.truncated.autoEligible).toEqual({ kept: 50, total: 300 });
    expect(typeof out.truncated.originalBytes).toBe('number');
    expect(out.truncated.note).toMatch(/Pass `limit`/);
  });

  it('keeps every rollup/headline intact when truncating', () => {
    const d = digestWith(300);
    const out = boundDigestForSerialization(d, { maxBytes: 2000, perArrayCap: 10 }) as Record<string, any>;
    expect(out.headline).toBe('rollup headline that must survive truncation');
    expect(out.byKind).toEqual({ bug: 300 });
    expect(out.total).toBe(300);
    expect(out.recurringSignatures).toEqual([{ signature: 'x', count: 3 }]);
  });

  it('only lists oversized arrays in `truncated` (an under-cap array is left whole)', () => {
    const d = digestWith(300);
    const out = boundDigestForSerialization(d, { maxBytes: 2000, perArrayCap: 50 }) as Record<string, any>;
    expect(out.truncated.humanQueue).toBeUndefined();
    expect(out.truncated.likelyDuplicates).toBeUndefined();
    expect(out.humanQueue).toEqual([]);
  });

  it('passes through non-object input', () => {
    expect(boundDigestForSerialization(null)).toBeNull();
    expect(boundDigestForSerialization(undefined)).toBeUndefined();
    expect(boundDigestForSerialization('x')).toBe('x');
  });

  it('has a sane default budget', () => {
    expect(DIGEST_MAX_BYTES).toBeGreaterThan(10_000);
    expect(DIGEST_MAX_BYTES).toBeLessThan(200_000);
  });
});
