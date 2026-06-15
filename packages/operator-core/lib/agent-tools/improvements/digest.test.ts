import { describe, it, expect, beforeEach, vi } from 'vitest';
import digestTool from './digest';
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
});
