import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  compute: vi.fn(),
  search: vi.fn(),
  create: vi.fn(),
  identity: vi.fn(() => ({ ownerId: 'su-flakiness' })),
}));

vi.mock('../../testing-flakiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../testing-flakiness')>()),
  computeFlakiness: h.compute,
}));
vi.mock('../../work-items', () => ({ searchWorkItems: h.search }));
vi.mock('../work_items/_create-core', () => ({ createOneWorkItem: h.create }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));

import tool from './flakiness';

type ToolResult = { content?: Array<{ text: string }>; data?: unknown; isError?: boolean };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  tool.handler(args as never, ctx as never) as Promise<ToolResult>;
const body = (result: ToolResult) => result.data ?? JSON.parse(result.content![0]!.text);

const candidate = {
  filePath: 'packages/operator-core/lib/example.test.ts',
  totalRuns: 6,
  passCount: 3,
  failCount: 3,
  flips: 3,
  flipRate: 0.6,
  lastStatus: 'pass',
  lastFinishedAt: '2026-08-22T06:00:00.000Z',
  recentStatuses: ['pass', 'fail', 'pass', 'fail', 'error', 'pass'],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockReturnValue({ ownerId: 'su-flakiness' });
  h.compute.mockResolvedValue([candidate]);
  h.search.mockResolvedValue({ items: [] });
  h.create.mockResolvedValue({ ok: true, workItem: { id: 'WI-created' } });
});

describe('testing:flakiness autoFile harness resolution', () => {
  it("fails loud for an unscoped '*' session before ranking or filing", async () => {
    const out = await call({ autoFile: true }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'harness_required', tool: 'testing:flakiness' });
    expect(h.compute).not.toHaveBeenCalled();
    expect(h.search).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('uses the concrete session harness for both ranking and each filed work-item', async () => {
    const out = await call({ autoFile: true }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });

    expect(h.compute).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'papercusp', workspaceId: 'ws-1' }));
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp' }),
      expect.objectContaining({ workspaceId: 'ws-1', harnessSlug: 'papercusp' }),
    );
    expect(body(out).filed).toEqual([{ filePath: candidate.filePath, id: 'WI-created' }]);
  });

  it("keeps an unscoped read workspace-wide instead of querying the '*' sentinel", async () => {
    await call({ autoFile: false }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(h.compute).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: null, workspaceId: 'ws-1' }));
    expect(h.create).not.toHaveBeenCalled();
  });
});
