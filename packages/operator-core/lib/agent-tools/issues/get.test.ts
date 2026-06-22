/**
 * get.test.ts — the issues:get HANDLER (getIssueDetail mocked), bulk keyed-array
 * contract (bulk-endpoint-standardization-2026-06-21). Pins: the inline { id }
 * single form → one result; the ids:[…] many form → per-item results keyed by id;
 * a not-found item → that item's { ok:false } WITHOUT failing the batch.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/issues/get.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../issues-engineer', () => ({ getIssueDetail: vi.fn() }));

import { getIssueDetail } from '../../issues-engineer';
const getM = vi.mocked(getIssueDetail);
const tool = (await import('./get')).default;

type Out = { content: { text: string }[] };
const body = async (args: unknown) => JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('issues:get handler (bulk keyed-array)', () => {
  it('inline { id } returns a single result', async () => {
    getM.mockResolvedValue({ id: 'EI-1', title: 'x' } as never);
    const b = await body({ id: 'EI-1' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1', issue: { id: 'EI-1' } });
  });

  it('ids:[…] fetches many; a not-found item fails only itself (counts.failed=1)', async () => {
    getM.mockImplementation(async (id: string) => (id === 'EI-X' ? null : ({ id, title: id } as never)));
    const b = await body({ ids: ['EI-1', 'EI-X', 'EI-2'] });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.results).toHaveLength(3);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['EI-1', true],
      ['EI-X', false],
      ['EI-2', true],
    ]);
    expect(b.results[1]).toMatchObject({ ok: false, id: 'EI-X', error: 'issue not found' });
  });

  it('dedups id + ids into one merged list', async () => {
    getM.mockImplementation(async (id: string) => ({ id } as never));
    const b = await body({ id: 'EI-1', ids: ['EI-1', 'EI-2'] });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['EI-1', 'EI-2']);
  });
});
