/**
 * topics-tag.test.ts — the topics:tag HANDLER tag/untag branch (tagObject/untagObject/
 * listObjectTags mocked). Pins that remove:true routes to untagObject (and NOT
 * tagObject), the default routes to tagObject with the caller's ownerId, and either way
 * the resulting tag set is read back and projected. A regression that tags on remove
 * (or vice-versa) is what this catches.
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
  tool.handler({ object_kind: 'feature', object_ref: 'F-3', topic: 'arch', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  listM.mockResolvedValue(['arch'] as never);
});

describe('topics:tag handler', () => {
  it('tags (default) with the caller ownerId and returns the resulting tag set', async () => {
    const b = body(await call());
    expect(tagM).toHaveBeenCalledWith('feature', 'F-3', 'arch', 'me');
    expect(untagM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, object: { kind: 'feature', ref: 'F-3' }, topics: ['arch'] });
  });

  it('remove:true routes to untagObject and not tagObject', async () => {
    listM.mockResolvedValue([] as never);
    const b = body(await call({ remove: true }));
    expect(untagM).toHaveBeenCalledWith('feature', 'F-3', 'arch');
    expect(tagM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, topics: [] });
  });
});
