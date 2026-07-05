/**
 * amend.test.ts — the work_items:amend HANDLER wiring (the pure core buildAmendment
 * is covered separately in build-amendment.test.ts). This pins the parts only the
 * handler does: the flag gate, the not-found guard, and — the load-bearing bit —
 * how it derives buildAmendment's authority inputs from the live context:
 *   • authoritative = (role !== 'bee')   → disposed vs proposed
 *   • claimedByOther = wi.assignee set AND != caller → in-flight / compensation
 * plus that it writes the rendered amendment durably (commentWorkItem). A regression
 * that treats a Queen as a bee, or fails to flag NEEDS-COMPENSATION on a peer's
 * in-flight node, is what this catches. The PG layer (getWorkItem/commentWorkItem)
 * and flags are mocked; buildAmendment/renderAmendment run for real.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/amend.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'bee-1' })) }));
vi.mock('../../work-items', () => ({ getWorkItem: vi.fn(), commentWorkItem: vi.fn() }));

import { getFlag } from '@papercusp/flags/server';
import { getWorkItem, commentWorkItem } from '../../work-items';
const getFlagM = vi.mocked(getFlag);
const getWI = vi.mocked(getWorkItem);
const comment = vi.mocked(commentWorkItem);
const tool = (await import('./amend')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>, role = 'cup') =>
  tool.handler({ id: 'WI-1', kind: 'note', rationale: 'because', ...args } as never, { role } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  getFlagM.mockResolvedValue(true);
  comment.mockResolvedValue({ id: 'msg-1' } as never);
});

describe('work_items:amend handler', () => {
  it('declines when the feature flag is off (and does not touch the work-item)', async () => {
    getFlagM.mockResolvedValue(false);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, disabled: true });
    expect(getWI).not.toHaveBeenCalled();
  });

  it('returns not-found when the work-item does not exist', async () => {
    getWI.mockResolvedValue(null as never);
    const b = body(await call({}));
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/not found/i);
    expect(comment).not.toHaveBeenCalled();
  });

  it('a bee PROPOSES (disposition=proposed) and the amendment is written durably', async () => {
    getWI.mockResolvedValue({ state: 'todo', assignee: undefined, harness: 'web' } as never);
    const b = body(await call({ kind: 'note', rationale: 'noticed a gap' }, 'cup'));
    expect(b).toMatchObject({ ok: true, recorded: true });
    expect(b.amendment).toMatchObject({ disposition: 'proposed', inFlight: false, requiresCompensation: false });
    // durable write got the rendered line, attributed to the caller
    expect(comment).toHaveBeenCalledTimes(1);
    const [id, line, owner] = comment.mock.calls[0]!;
    expect(id).toBe('WI-1');
    expect(owner).toBe('bee-1');
    expect(String(line)).toContain('⟐ amend[note]');
    expect(String(line)).toContain('noticed a gap');
  });

  it('a Queen DISPOSES, and a disruptive drop on a PEER-CLAIMED in-flight node needs compensation', async () => {
    getWI.mockResolvedValue({ state: 'wip', assignee: 'other-bee', harness: 'web' } as never);
    const b = body(await call({ kind: 'drop', rationale: 'approach is wrong' }, 'mug'));
    expect(b.amendment).toMatchObject({
      disposition: 'disposed',
      inFlight: true,
      requiresCompensation: true,
    });
    expect(String(comment.mock.calls[0]![1])).toContain('NEEDS-COMPENSATION');
  });

  it('a NON-disruptive note on an in-flight node is in-flight but needs NO compensation', async () => {
    getWI.mockResolvedValue({ state: 'wip', assignee: 'bee-1', harness: 'web' } as never);
    const b = body(await call({ kind: 'note', rationale: 'fyi' }, 'cup'));
    expect(b.amendment).toMatchObject({ inFlight: true, requiresCompensation: false });
  });
});
