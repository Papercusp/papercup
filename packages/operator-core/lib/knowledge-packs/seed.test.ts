/**
 * seed tests (learning-packs-2026-06-11 P-005) — mocked memory backend;
 * pins verbatim writes, scope key, provenance metadata, shape filtering,
 * undo, and the degraded paths (unavailable store, partial write failure).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

vi.mock('../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));

import { getMemoryBackend } from '../memory/backend';
import { seedPackIntoHive, shapesFromDetection } from './seed';
import type { KnowledgePack } from './pack-format';

type RememberCall = [string, Record<string, unknown>];

const makeBackend = (opts: { available?: boolean; failOn?: string[] } = {}) => {
  let n = 0;
  const forgotten: string[] = [];
  const backend = {
    name: 'fake',
    available: vi.fn(async () =>
      opts.available === false ? { ok: false as const, reason: 'down' } : { ok: true as const },
    ),
    remember: vi.fn(async (text: string) => {
      if (opts.failOn?.some((s) => text.includes(s))) throw new Error('embed failed');
      n += 1;
      return { ids: [`id-${n}`] };
    }),
    forget: vi.fn(async (id: string) => {
      forgotten.push(id);
    }),
  };
  vi.mocked(getMemoryBackend).mockReturnValue(backend as unknown as ReturnType<typeof getMemoryBackend>);
  return { backend, forgotten };
};

const pack: KnowledgePack = {
  manifest: { id: 'coding', title: 'T', description: 'd', version: '1.0.0' },
  items: [
    { id: 'a', title: 'A', kind: 'feedback', appliesTo: ['any'], text: 'body a' },
    { id: 'b', title: 'B', kind: 'reference', appliesTo: ['ui'], text: 'body b' },
    { id: 'c', title: 'C', kind: 'feedback', appliesTo: ['cli'], text: 'body c' },
  ],
};

beforeEach(() => vi.mocked(getMemoryBackend).mockReset());

describe('shapesFromDetection', () => {
  it('maps frontend → ui; everything else conservative undefined', () => {
    expect(shapesFromDetection({ flags: { frontend: true, monorepo: false } })).toEqual(['ui']);
    expect(shapesFromDetection({ flags: { frontend: false } })).toBeUndefined();
    expect(shapesFromDetection(undefined)).toBeUndefined();
    expect(shapesFromDetection('garbage')).toBeUndefined();
  });
});

describe('seedPackIntoHive', () => {
  it('P-006 writes standalone identity knowledge to the existing harness pool', async () => {
    const { backend } = makeBackend();
    const result = await seedPackIntoHive({ workspaceId: 'w', potSlug: 'member', pack,
      memoryTarget: { kind: 'harness', slug: 'member' } });
    expect(result.ok).toBe(true);
    const calls = backend.remember.mock.calls as unknown as RememberCall[];
    expect(calls[0]?.[1]).toMatchObject({ scope: 'harness:member',
      metadata: { scope: 'harness', harness_slug: 'member', workspace_id: 'w', source: 'pack' } });
    expect(calls[0]?.[1].metadata).not.toHaveProperty('hive_slug');
  });
  it('writes verbatim rows with hive scope + provenance; filters by shape', async () => {
    const { backend } = makeBackend();
    const res = await seedPackIntoHive({
      workspaceId: 'ws-1',
      potSlug: 'my-hive',
      pack,
      shapes: ['ui'],
    });
    expect(res.ok).toBe(true);
    expect(res.seeded).toBe(2); // 'a' (any) + 'b' (ui); 'c' (cli) filtered
    expect(res.skippedByShape).toBe(1);
    expect(res.packId).toBe('coding');
    expect(res.packVersion).toBe('1.0.0');

    const calls = backend.remember.mock.calls as unknown as RememberCall[];
    expect(calls.map(([text]) => text)).toEqual(['A — body a', 'B — body b']);
    const [, optsA] = calls[0];
    expect(optsA).toMatchObject({
      scope: 'hive:my-hive',
      kind: 'feedback',
      verbatim: true,
      metadata: {
        scope: 'hive',
        hive_slug: 'my-hive',
        workspace_id: 'ws-1',
        created_by: 'system',
        source: 'pack',
        pack_id: 'coding',
        pack_version: '1.0.0',
        pack_item_id: 'a',
        applies_to: ['any'],
      },
    });
  });

  it('repo-less (no shapes) seeds any-only; undo forgets every written id', async () => {
    const { forgotten } = makeBackend();
    const res = await seedPackIntoHive({ workspaceId: 'ws', potSlug: 'h', pack });
    expect(res.seeded).toBe(1);
    expect(res.ids).toEqual(['id-1']);
    await res.undo();
    expect(forgotten).toEqual(['id-1']);
  });

  it('unavailable store → ok:false, nothing written, undo is a no-op', async () => {
    const { backend, forgotten } = makeBackend({ available: false });
    const res = await seedPackIntoHive({ workspaceId: 'ws', potSlug: 'h', pack });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/memory_unavailable/);
    expect(res.seeded).toBe(0);
    expect(backend.remember).not.toHaveBeenCalled();
    await res.undo();
    expect(forgotten).toEqual([]);
  });

  it('a failed write never aborts the batch; counted + reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      makeBackend({ failOn: ['body a'] });
      const res = await seedPackIntoHive({
        workspaceId: 'ws',
        potSlug: 'h',
        pack,
        shapes: ['ui', 'cli'],
      });
      expect(res.failed).toBe(1);
      expect(res.seeded).toBe(2); // b + c landed despite a failing
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/1 write/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('coding/a'));
    } finally {
      warn.mockRestore();
    }
  });

  it('createdBy overrides the system stamp', async () => {
    const { backend } = makeBackend();
    await seedPackIntoHive({ workspaceId: 'ws', potSlug: 'h', pack, createdBy: 'user-7' });
    const [, o] = backend.remember.mock.calls[0] as unknown as RememberCall;
    expect((o.metadata as Record<string, unknown>).created_by).toBe('user-7');
  });
});
