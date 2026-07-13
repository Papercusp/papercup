/**
 * comment.test.ts — the work_items:comment HANDLER (commentWorkItem mocked), bulk
 * keyed-array contract (bulk-endpoint-standardization-2026-06-21). Pins: the inline
 * { id, body } single form → one result; the items:[…] many form → per-item results
 * keyed by id; a not-found item → that item's { ok:false } WITHOUT failing the batch;
 * a thrown engine error → { ok:false, id, error } via runBulk's keyOf.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/comment.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({
  commentWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
  isSettledWorkItemState: (s: string | null | undefined) => !!s && ['resolved', 'closed', 'done', 'passed', 'deprecated'].includes(s),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));

import { commentWorkItem, getWorkItem } from '../../work-items';
const cmtM = vi.mocked(commentWorkItem);
const getM = vi.mocked(getWorkItem);
const tool = (await import('./comment')).default;

type Out = { data: any };
const run = (args: unknown) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = async (args: unknown) => ((await run(args)).data);

beforeEach(() => vi.clearAllMocks());

describe('work_items:comment handler (bulk keyed-array)', () => {
  it('inline { id, body } posts one comment and returns a single result', async () => {
    cmtM.mockResolvedValue({ id: 'post-1' } as never);
    const b = await body({ id: 'WI-1', body: 'hello' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', post: { id: 'post-1' } });
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'hello', 'me', { harness: undefined });
  });

  it('items:[…] comments on many; a not-found item fails only itself', async () => {
    cmtM.mockImplementation(async (id: string) => (id === 'WI-X' ? null : ({ id: `post-${id}` } as never)));
    const b = await body({ items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-X', body: 'b' }, { id: 'WI-2', body: 'c' }] });
    expect(b.ok).toBe(true); // the batch ran
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { id: string; ok: boolean }) => [r.id, r.ok])).toEqual([
      ['WI-1', true],
      ['WI-X', false],
      ['WI-2', true],
    ]);
    expect(String(b.results[1].error)).toMatch(/WI-X.*not found/i);
  });

  it('a thrown engine error becomes that item\'s { ok:false, id, error } (batch survives)', async () => {
    cmtM.mockImplementation(async (id: string) => {
      if (id === 'WI-2') throw new Error('boom');
      return { id: `post-${id}` } as never;
    });
    const b = await body({ items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-2', body: 'b' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toEqual({ ok: false, id: 'WI-2', error: 'boom' });
  });

  it('per-item harness overrides the batch default', async () => {
    cmtM.mockResolvedValue({ id: 'p' } as never);
    await body({ harness: 'def', items: [{ id: 'WI-1', body: 'a' }, { id: 'WI-2', body: 'b', harness: 'web' }] });
    expect(cmtM).toHaveBeenNthCalledWith(1, 'WI-1', 'a', 'me', { harness: 'def' });
    expect(cmtM).toHaveBeenNthCalledWith(2, 'WI-2', 'b', 'me', { harness: 'web' });
  });

  describe('EI-8837: completion-shaped post on a still-open item gets a nudge hint', () => {
    it('a "DONE + GREEN" post on a non-terminal item carries `hint`', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      getM.mockResolvedValue({ id: 'WI-1', state: 'open' } as never);
      const b = await body({ id: 'WI-1', body: '✅ DONE + GREEN, all tests pass.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', hint: expect.stringContaining('work_items:set_state') });
      expect(getM).toHaveBeenCalledWith('WI-1', undefined);
    });

    it('the SAME post on an ALREADY-terminal item carries no hint', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      getM.mockResolvedValue({ id: 'WI-1', state: 'resolved' } as never);
      const b = await body({ id: 'WI-1', body: 'VM-verified, fully fixed.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(b.results[0].hint).toBeUndefined();
    });

    it('routine, non-completion-shaped chatter never triggers the getWorkItem lookup at all', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      const b = await body({ id: 'WI-1', body: 'still investigating, no conclusion yet' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(b.results[0].hint).toBeUndefined();
      expect(getM).not.toHaveBeenCalled();
    });

    it('a getWorkItem failure never fails the already-landed comment', async () => {
      cmtM.mockResolvedValue({ id: 'post-1' } as never);
      getM.mockRejectedValue(new Error('lookup boom'));
      const b = await body({ id: 'WI-1', body: 'fully fixed and verified.' });
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
      expect(b.results[0].hint).toBeUndefined();
    });
  });
});

/**
 * EI-10897 (the alias) + EI-10996 (the way the first cut of it broke the catalog).
 *
 * The tool is CALLED `comment`, so `{ id, comment }` is the spelling an agent reaches
 * for first; it used to be rejected. The alias is resolved HANDLER-side on purpose —
 * a zod `.transform()` in the args schema makes `z.toJSONSchema` throw, and that call
 * is un-try/caught in BOTH defineTool registration and the MCP tools/list handlers, so
 * one transform here takes down schema-gen for the ENTIRE tool catalog (it red-pinned
 * the release gate). The representability test below is that regression's guard.
 */
describe('body/comment alias (EI-10897) + schema representability (EI-10996)', () => {
  const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
  const safeParse = (x: unknown) => (tool.args as { safeParse: (x: unknown) => { success: boolean } }).safeParse(x);

  beforeEach(() => {
    cmtM.mockResolvedValue({ id: 'p1' } as never);
    getM.mockResolvedValue({ id: 'WI-1', state: 'wip' } as never);
  });

  it('accepts { id, comment } — the obvious spelling — and posts it as the body', async () => {
    await body(parse({ id: 'WI-1', comment: 'via the alias' }));
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'via the alias', 'me', expect.anything());
  });

  it('still accepts { id, body } (the alias is additive, not a rename)', async () => {
    await body(parse({ id: 'WI-1', body: 'via body' }));
    expect(cmtM).toHaveBeenCalledWith('WI-1', 'via body', 'me', expect.anything());
  });

  it('resolves the alias in the BULK path identically', async () => {
    await body(parse({ items: [{ id: 'WI-1', comment: 'a' }, { id: 'WI-2', body: 'b' }] }));
    expect(cmtM).toHaveBeenNthCalledWith(1, 'WI-1', 'a', 'me', expect.anything());
    expect(cmtM).toHaveBeenNthCalledWith(2, 'WI-2', 'b', 'me', expect.anything());
  });

  it('REJECTS both-with-different-text (never silently pick one)', () => {
    expect(safeParse({ id: 'WI-1', body: 'x', comment: 'y' }).success).toBe(false);
    expect(safeParse({ id: 'WI-1', body: 'same', comment: 'same' }).success).toBe(true);
  });

  it('REJECTS a comment with no text at all', () => {
    expect(safeParse({ id: 'WI-1' }).success).toBe(false);
    expect(safeParse({ items: [{ id: 'WI-1' }] }).success).toBe(false);
  });

  it('the args schema stays JSON-Schema-REPRESENTABLE — a .transform() here crashes the whole catalog (EI-10996)', async () => {
    const { z } = await import('zod');
    expect(() => z.toJSONSchema(tool.args as never)).not.toThrow();
    // …and the alias must actually be ADVERTISED, or an agent can never discover it.
    const schema = z.toJSONSchema(tool.args as never) as { properties?: Record<string, unknown> };
    expect(Object.keys(schema.properties ?? {})).toContain('comment');
  });
});
