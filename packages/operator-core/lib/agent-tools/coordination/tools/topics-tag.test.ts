/**
 * topics-tag.test.ts — the topics:tag HANDLER tag/untag branch, bulk-standardized
 * (bulk-endpoint-standardization-2026-06-21, Phase 4). tagObject/untagObject/
 * listObjectTags mocked. Pins that remove:true routes to untagObject (and NOT
 * tagObject), the default routes to tagObject with the caller's ownerId, and either
 * way the resulting tag set is read back per item; single ({ object_kind, object_ref,
 * topic }) is n=1 of the envelope, many heterogeneous (items:[…]) fan over each
 * object, every result self-describes its `topic` + tagged `object`, and one failing
 * item NEVER fails the rest. A regression that tags on remove (or vice-versa) is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/topics-tag.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../../topics-feed', () => ({ tagObject: vi.fn(), untagObject: vi.fn(), listObjectTags: vi.fn() }));

import { tagObject, untagObject, listObjectTags } from '../../../topics-feed';
const tagM = vi.mocked(tagObject);
const untagM = vi.mocked(untagObject);
const listM = vi.mocked(listObjectTags);
const tool = (await import('./topics-tag')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler(tool.args.parse({ object_kind: 'feature', object_ref: 'F-3', topic: 'arch', ...args }) as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  listM.mockResolvedValue(['arch'] as never);
});

describe('topics:tag handler (bulk)', () => {
  it('single tag (default) uses the caller ownerId and returns an n=1 envelope', async () => {
    const b = body(await call());
    expect(tagM).toHaveBeenCalledWith('feature', 'F-3', 'arch', 'me');
    expect(untagM).not.toHaveBeenCalled();
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results).toEqual([
      { ok: true, topic: 'arch', object: { kind: 'feature', ref: 'F-3' }, topics: ['arch'] },
    ]);
  });

  it('remove:true routes to untagObject and not tagObject', async () => {
    listM.mockResolvedValue([] as never);
    const b = body(await call({ remove: true }));
    expect(untagM).toHaveBeenCalledWith('feature', 'F-3', 'arch');
    expect(tagM).not.toHaveBeenCalled();
    expect(b.results[0]).toMatchObject({ ok: true, topic: 'arch', topics: [] });
  });

  it('many heterogeneous items fan per object (tag + untag) and self-describe', async () => {
    const out = (await tool.handler(
      tool.args.parse({
        items: [
          { object_kind: 'feature', object_ref: 'F-1', topic: 'arch' },
          { object_kind: 'plan', object_ref: 'my-plan', topic: 'coord', remove: true },
        ],
      }) as never,
      {} as never,
    )) as Out;
    const b = body(out);
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(tagM).toHaveBeenCalledWith('feature', 'F-1', 'arch', 'me');
    expect(untagM).toHaveBeenCalledWith('plan', 'my-plan', 'coord');
    const byRef = Object.fromEntries(b.results.map((r: { object: { ref: string } }) => [r.object.ref, r]));
    expect(byRef['F-1']).toMatchObject({ ok: true, topic: 'arch', object: { kind: 'feature', ref: 'F-1' } });
    expect(byRef['my-plan']).toMatchObject({ ok: true, topic: 'coord', object: { kind: 'plan', ref: 'my-plan' } });
  });

  it('one failing item NEVER fails the rest', async () => {
    tagM.mockImplementation(async (_k, ref) => {
      if (ref === 'F-bad') throw new Error('boom');
    });
    const out = (await tool.handler(
      tool.args.parse({
        items: [
          { object_kind: 'feature', object_ref: 'F-ok', topic: 'arch' },
          { object_kind: 'feature', object_ref: 'F-bad', topic: 'arch' },
        ],
      }) as never,
      {} as never,
    )) as Out;
    const b = body(out);
    expect(b.ok).toBe(true);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    const byRef = Object.fromEntries(b.results.map((r: { object: { ref: string } }) => [r.object.ref, r]));
    expect(byRef['F-ok'].ok).toBe(true);
    expect(byRef['F-bad']).toMatchObject({ ok: false, topic: 'arch', error: 'boom' });
  });

  it('rejects an incomplete single call (missing object_ref) at the zod boundary', () => {
    expect(() => tool.args.parse({ object_kind: 'feature', topic: 'arch' })).toThrow();
  });
});
