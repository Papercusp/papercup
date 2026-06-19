/**
 * observe.test.ts — the work_items:observe HANDLER (observeWorkItem mocked). The
 * tuple-space `rd`: read a work-item's claimability without taking it. Pins the
 * found → { ok:true, ...obs } spread and the missing → { ok:false, error } mapping. A
 * regression that reports a missing item as observable is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/observe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({ observeWorkItem: vi.fn() }));

import { observeWorkItem } from '../../work-items';
const obsM = vi.mocked(observeWorkItem);
const tool = (await import('./observe')).default;

type Out = { content: { text: string }[] };
const call = () => tool.handler({ id: 'WI-1', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('work_items:observe handler', () => {
  it('spreads the observation when the item exists', async () => {
    obsM.mockResolvedValue({ id: 'WI-1', claimable: true, assignee: null } as never);
    expect(body(await call())).toMatchObject({ ok: true, id: 'WI-1', claimable: true });
  });

  it('maps a missing item to { ok:false, error }', async () => {
    obsM.mockResolvedValue(null as never);
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/WI-1.*not found/i);
  });
});
