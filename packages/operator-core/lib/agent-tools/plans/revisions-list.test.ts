/**
 * revisions-list.test.ts — the plans:revisions HANDLER (listPlanRevisions/
 * resolvePlanScope mocked). Pins the success projection + breadcrumb, the empty-chain
 * (not an error) case, and the DB-failure → explicit isError
 * {error:'revisions_unavailable'} mapping (never a misleading empty chain). A
 * regression that swallows a DB error into an empty list is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/revisions-list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'web') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./revisions', () => ({ listPlanRevisions: vi.fn() }));
vi.mock('./source', () => ({ resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));

import { listPlanRevisions } from './revisions';
const listM = vi.mocked(listPlanRevisions);
const tool = (await import('./revisions-list')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const meta = vi.fn();
const call = (slug = 'p1') => tool.handler({ slug, harness: 'web' } as never, { metadata: meta } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  listM.mockResolvedValue([] as never);
});

describe('plans:revisions handler', () => {
  it('returns the revision chain and emits a revisionCount breadcrumb', async () => {
    listM.mockResolvedValue([{ seq: 2, author: 'agent', rationale: 'why' }] as never);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ revisions: [{ seq: 2, author: 'agent' }] });
    expect(meta).toHaveBeenCalledWith({ slug: 'p1', revisionCount: 1 });
  });

  it('returns an empty chain (not an error) for a plan with no revisions', async () => {
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ revisions: [] });
  });

  it('maps a DB failure to revisions_unavailable (isError)', async () => {
    listM.mockRejectedValue(new Error('relation missing'));
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'revisions_unavailable', slug: 'p1' });
  });
});
