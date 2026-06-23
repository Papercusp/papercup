/**
 * update.test.ts — the work_items:update HANDLER (updateWorkItem mocked), bulk
 * keyed-array contract. Pins the single-inline patch passthrough, the items:[…]
 * fan-out, the per-item not_found mapping (batch survives), and the feature-family
 * `unsupported_family` error mapping. The unified replacement for the retired
 * issues:update (coordination-unification-2026-06-23 P-009).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/update.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../work-items', () => ({ updateWorkItem: vi.fn() }));

import { updateWorkItem } from '../../work-items';
const updM = vi.mocked(updateWorkItem);
const tool = (await import('./update')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => vi.clearAllMocks());

describe('work_items:update handler (bulk keyed-array)', () => {
  it('edits one inline { id, …fields } and passes the patch + owner through', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-1', title: 'new' } } as never);
    const b = await body({ id: 'EI-1', title: 'new', severity: 'major' });
    expect(updM).toHaveBeenCalledWith(
      'EI-1',
      expect.objectContaining({ title: 'new', severity: 'major' }),
      'me',
      expect.objectContaining({ harness: undefined }),
    );
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1', item: { id: 'EI-1', title: 'new' } });
  });

  it('items:[…] heterogeneous fan-out preserves order + per-item harness', async () => {
    updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
    const b = await body({ items: [{ id: 'EI-1', title: 'a', harness: 'h1' }, { id: 'EI-2', body: 'b' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['EI-1', 'EI-2']);
    expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.any(Object), 'me', { harness: 'h1' });
  });

  it('a not_found item maps to { ok:false, error } without failing the rest', async () => {
    updM.mockImplementation(
      async (id: string) =>
        (id === 'EI-X' ? { ok: false, reason: 'not_found' } : { ok: true, item: { id } }) as never,
    );
    const b = await body({ items: [{ id: 'EI-1' }, { id: 'EI-X' }] });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'EI-X', error: expect.stringContaining('not found') });
  });

  it('a feature-family item maps to an unsupported_family error', async () => {
    updM.mockResolvedValue({ ok: false, reason: 'unsupported_family' } as never);
    const b = await body({ id: 'F-1', title: 'x' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'F-1', error: expect.stringContaining('feature-family') });
  });
});
