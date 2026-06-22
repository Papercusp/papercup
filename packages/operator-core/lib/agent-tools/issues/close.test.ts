/**
 * close.test.ts — the issues:close HANDLER (setIssueState mocked), bulk keyed-array
 * contract (bulk-endpoint-standardization-2026-06-21). Pins the default state
 * (omitted → 'resolved'), the explicit-state passthrough, the not_found mapping
 * (per item, batch survives), and the ids:[…] / items:[…] fan-out. A regression
 * that defaults to the wrong lifecycle state, or swallows a missing issue into a
 * fake success, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/issues/close.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../issues-engineer', () => ({ setIssueState: vi.fn() }));

import { setIssueState } from '../../issues-engineer';
const setM = vi.mocked(setIssueState);
const tool = (await import('./close')).default;

type Out = { content: { text: string }[] };
const body = async (args: Record<string, unknown>) =>
  JSON.parse(((await tool.handler(args as never, {} as never)) as Out).content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('issues:close handler (bulk keyed-array)', () => {
  it('defaults to state=resolved when omitted (single inline)', async () => {
    setM.mockResolvedValue({ id: 'EI-1', state: 'resolved' } as never);
    const b = await body({ id: 'EI-1' });
    expect(setM).toHaveBeenCalledWith('EI-1', 'resolved', 'me');
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, id: 'EI-1', issue: { id: 'EI-1', state: 'resolved' } });
  });

  it('passes an explicit state through', async () => {
    setM.mockResolvedValue({ id: 'EI-1', state: 'closed' } as never);
    await body({ id: 'EI-1', state: 'closed' });
    expect(setM).toHaveBeenCalledWith('EI-1', 'closed', 'me');
  });

  it('closes MANY to the same state via ids:[…] (homogeneous)', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({ id, state }) as never);
    const b = await body({ ids: ['EI-1', 'EI-2'], state: 'closed' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['EI-1', 'EI-2']);
    expect(setM).toHaveBeenCalledWith('EI-2', 'closed', 'me');
  });

  it('items:[…] heterogeneous; per-item state overrides the batch default', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({ id, state }) as never);
    const b = await body({ state: 'closed', items: [{ id: 'EI-1' }, { id: 'EI-2', state: 'open' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(setM).toHaveBeenNthCalledWith(1, 'EI-1', 'closed', 'me');
    expect(setM).toHaveBeenNthCalledWith(2, 'EI-2', 'open', 'me');
  });

  it('a missing issue maps to that item\'s { ok:false, error } without failing the rest', async () => {
    setM.mockImplementation(async (id: string) => (id === 'EI-X' ? null : ({ id, state: 'resolved' } as never)));
    const b = await body({ ids: ['EI-1', 'EI-X'] });
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'EI-X', error: 'issue not found' });
  });
});
