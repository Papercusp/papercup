/**
 * create.test.ts — work_items:create handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). The per-item core (`createOneWorkItem`)
 * is mocked — this exercises the tool's normalization (single spec OR items:[…] +
 * batch-level harness / workspace / assign_all_to_self) and the keyed-array envelope
 * that RETIRED work_items:create_batch. Each result self-describes; a mirror-duplicate
 * fails only that item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('./_create-core', () => ({ createOneWorkItem: vi.fn() }));

import { createOneWorkItem } from './_create-core';
const createM = vi.mocked(createOneWorkItem);
const tool = (await import('./create')).default;

const ctx = { workspaceId: 'default', harnessSlug: 'papercup' } as never;
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { content: { text: string }[] };
const body = async (args: unknown) => JSON.parse(((await tool.handler(parse(args) as never, ctx)) as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  createM.mockImplementation(async (spec: { title: string }) => ({ ok: true, workItem: { id: `WI-${spec.title}`, kind: 'bug', title: spec.title } }) as never);
});

describe('work_items:create handler (keyed-array)', () => {
  it('creates one inline and returns { ok, id, title, workItem }', async () => {
    const b = await body({ kind: 'bug', title: 'boom' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-boom', title: 'boom', workItem: { id: 'WI-boom' } });
    expect(createM).toHaveBeenCalledTimes(1);
  });

  it('creates MANY via items:[…] — one self-describing result per item', async () => {
    const b = await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'change', title: 'b' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['WI-a', 'WI-b']);
  });

  it('assign_all_to_self claims every item unless the item overrides via assign_to', async () => {
    await body({ items: [{ kind: 'bug', title: 'a' }, { kind: 'bug', title: 'b', assign_to: 'bee-7' }], assign_all_to_self: true });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', assign_to: 'bee-7' }), expect.anything());
  });

  it('batch-level harness is the default for items that omit one', async () => {
    await body({ items: [{ kind: 'feature', title: 'a' }], harness: 'h-default' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', harness: 'h-default' }), expect.anything());
  });

  it('a mirror-duplicate fails only that item (carries error + existing), batch still runs', async () => {
    createM.mockImplementation(async (spec: { title: string }) =>
      spec.title === 'dup'
        ? ({ ok: false, error: 'duplicate_mirror', message: 'references WI-9', existing: { id: 'WI-9', state: 'open' } } as never)
        : ({ ok: true, workItem: { id: `WI-${spec.title}`, title: spec.title } } as never),
    );
    const b = await body({ items: [{ kind: 'bug', title: 'ok' }, { kind: 'bug', title: 'dup' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, title: 'dup', error: 'duplicate_mirror', existing: { id: 'WI-9' } });
  });
});
