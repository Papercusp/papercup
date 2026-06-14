import { describe, it, expect, beforeEach, vi } from 'vitest';
import changeFeedTool from './change-feed';
import { gatherCompletions, rankChangeFeed } from '../../curation/change-feed';
import { buildChangeFeedReaders } from '../../curation/change-feed-deps';

// PG-free unit: the change-feed core (gatherCompletions/rankChangeFeed) has its
// own suites; this pins the TOOL — the toRow null-coalescing projection, the
// harness filter applied BEFORE ranking, the limit default, and the
// { ok, count, rows, harness, userRequestedOnly } envelope (P-050 / P-006).
vi.mock('../../curation/change-feed', async (orig) => {
  const actual = (await orig()) as typeof import('../../curation/change-feed');
  return { ...actual, gatherCompletions: vi.fn(), rankChangeFeed: vi.fn() };
});
vi.mock('../../curation/change-feed-deps');

const mockGather = vi.mocked(gatherCompletions);
const mockRank = vi.mocked(rankChangeFeed);
const mockReaders = vi.mocked(buildChangeFeedReaders);

type Entry = Awaited<ReturnType<typeof gatherCompletions>>[number];

function entry(p: Partial<Entry> & { id: string }): Entry {
  return {
    kind: 'completion',
    title: `t-${p.id}`,
    ref: `ref-${p.id}`,
    ts: '2026-06-10T00:00:00Z',
    ...p,
  } as Entry;
}

function callTool(args: Record<string, unknown>) {
  return (
    changeFeedTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, {});
}

describe('curation:change-feed tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaders.mockReturnValue({} as ReturnType<typeof buildChangeFeedReaders>);
    mockGather.mockResolvedValue([]);
    // identity rank: returns whatever it is given so toRow runs on it.
    mockRank.mockImplementation((entries) => entries as ReturnType<typeof rankChangeFeed>);
  });

  it('projects entries with toRow, coalescing optional fields to null / false', async () => {
    mockGather.mockResolvedValue([
      entry({ id: 'a', detail: undefined, harness: undefined, workItemId: undefined, userRequested: undefined }),
    ]);
    const res = await callTool({});
    const body = JSON.parse(res.content[0].text);
    expect(body.rows[0]).toEqual({
      id: 'a',
      kind: 'completion',
      title: 't-a',
      detail: null,
      harness: null,
      workItemId: null,
      ref: 'ref-a',
      ts: '2026-06-10T00:00:00Z',
      userRequested: false,
    });
  });

  it('filters by harness BEFORE ranking, and labels the envelope with the harness', async () => {
    mockGather.mockResolvedValue([
      entry({ id: 'a', harness: 'foo' }),
      entry({ id: 'b', harness: 'bar' }),
      entry({ id: 'c', harness: 'foo' }),
    ]);
    const res = await callTool({ harness: 'foo' });
    const passedToRank = mockRank.mock.calls[0][0];
    expect(passedToRank.map((e: Entry) => e.id)).toEqual(['a', 'c']);
    const body = JSON.parse(res.content[0].text);
    expect(body.harness).toBe('foo');
    expect(body.count).toBe(2);
  });

  it('passes every entry to ranking and labels "fleet-wide" when no harness filter', async () => {
    mockGather.mockResolvedValue([entry({ id: 'a', harness: 'foo' }), entry({ id: 'b', harness: 'bar' })]);
    const res = await callTool({});
    expect(mockRank.mock.calls[0][0]).toHaveLength(2);
    const body = JSON.parse(res.content[0].text);
    expect(body.harness).toBe('fleet-wide');
    expect(body.userRequestedOnly).toBe(false);
  });

  it('defaults the rank limit to 100 and forwards userRequestedOnly', async () => {
    await callTool({ userRequestedOnly: true });
    expect(mockRank).toHaveBeenCalledWith(expect.anything(), { limit: 100, userRequestedOnly: true });
    mockRank.mockClear();
    await callTool({ limit: 5 });
    expect(mockRank).toHaveBeenCalledWith(expect.anything(), { limit: 5, userRequestedOnly: undefined });
  });

  it('reflects userRequestedOnly:true in the envelope', async () => {
    const res = await callTool({ userRequestedOnly: true });
    const body = JSON.parse(res.content[0].text);
    expect(body.userRequestedOnly).toBe(true);
    expect(body.ok).toBe(true);
  });
});
