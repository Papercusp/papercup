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
const codeSmellsLikeCode = (await import('./create')).codeSmellsLikeCode;

const ctx = { workspaceId: 'default', harnessSlug: 'papercup' } as never;
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(parse(args) as never, ctx)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  createM.mockImplementation(async (spec: { title: string }) => ({ ok: true, workItem: { id: `WI-${spec.title}`, kind: 'bug', title: spec.title } }) as never);
});

describe('codeSmellsLikeCode + the task nudge (WI-2874)', () => {
  it('flags code work via structural signals (source path / file ext / backticked ident / edit verbs)', () => {
    expect(codeSmellsLikeCode('Fix packages/operator-core/lib/foo.ts race')).toBe(true);
    expect(codeSmellsLikeCode('Update the docs-qa.ts endpoint')).toBe(true);
    expect(codeSmellsLikeCode('Rename `myHelperFn` in the resolver')).toBe(true);
    expect(codeSmellsLikeCode('Refactor the claim path', 'implement the new guard')).toBe(true);
  });
  it('does NOT flag genuine non-code tasks (false positives would be harmless anyway — it never blocks)', () => {
    expect(codeSmellsLikeCode('Research the best charting library for the dashboard')).toBe(false);
    expect(codeSmellsLikeCode('Decide whether to sunset the classic lexicon')).toBe(false);
    expect(codeSmellsLikeCode('Manually verify the 2-box federation drill on the rig')).toBe(false);
  });
  it('a code-smelling TASK is still created, with a non-blocking warning', async () => {
    const b = await body({ kind: 'task', title: 'refactor packages/foo/bar.ts' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(b.results[0].warning).toMatch(/NON-CODE only/);
  });
  it('a genuine non-code TASK gets NO warning', async () => {
    const b = await body({ kind: 'task', title: 'research the best date library' });
    expect(b.results[0].warning).toBeUndefined();
  });
  it('the nudge is task-only — a code-smelling change/bug is never warned', async () => {
    const b = await body({ kind: 'change', title: 'fix packages/foo/bar.ts' });
    expect(b.results[0].warning).toBeUndefined();
  });
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

  it('EI-7766: assign_to:"self" resolves to the caller ownerId, not the literal string (single-create path)', async () => {
    await body({ kind: 'bug', title: 'a', assign_to: 'self' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
  });

  it('EI-7766: assign_to:"self" resolves to the caller ownerId in the bulk items[] path too', async () => {
    await body({ items: [{ kind: 'bug', title: 'a', assign_to: 'self' }, { kind: 'bug', title: 'b', assign_to: 'bee-7' }] });
    expect(createM).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'a', assign_to: 'me' }), expect.anything());
    expect(createM).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'b', assign_to: 'bee-7' }), expect.anything());
  });

  it('a concrete assign_to ownerId is passed through unchanged (not confused with "self")', async () => {
    await body({ kind: 'bug', title: 'a', assign_to: 'someone-else' });
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ title: 'a', assign_to: 'someone-else' }), expect.anything());
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
