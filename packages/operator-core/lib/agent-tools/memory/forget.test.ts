/**
 * forget.test.ts — the memory:forget HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Backend mocked. Pins the inline
 * { id } single form, the ids:[…] many form (per-item results keyed by id), a
 * per-item delete failure failing only itself, and the top-level availability
 * gate. A wedged backend → top-level { ok:false, reason:'memory_timeout' } is
 * covered in b1-timeout.test.ts.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/forget.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));

import forget from './forget';
import { getMemoryBackend } from '../../memory/backend';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
};

const fakeBackend = (): FakeBackend => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  forget: vi.fn(async () => undefined),
});

const useBackend = (b: FakeBackend): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

type Out = { content: { text: string }[] };
const body = async (args: unknown): Promise<{ ok: boolean; reason?: string; results: { ok: boolean; id: string; error?: string }[]; counts: { ok: number; failed: number } }> =>
  JSON.parse(((await forget.handler(args as never, {} as never)) as Out).content[0].text);

describe('memory:forget handler (bulk keyed-array)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inline { id } deletes one and returns a single result', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ id: 'm1' });
    expect(r).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(r.results[0]).toMatchObject({ ok: true, id: 'm1' });
    expect(b.forget).toHaveBeenCalledWith('m1');
  });

  it('ids:[…] deletes many; per-item results keyed by id', async () => {
    const b = fakeBackend();
    useBackend(b);
    const r = await body({ ids: ['m1', 'm2', 'm3'] });
    expect(r.counts).toEqual({ ok: 3, failed: 0 });
    expect(r.results.map((x) => x.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('a backend delete failure fails only that item; top-level ok stays true', async () => {
    const b = fakeBackend();
    b.forget.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('delete blew up');
    });
    useBackend(b);
    const r = await body({ ids: ['m1', 'bad', 'm2'] });
    expect(r).toMatchObject({ ok: true, counts: { ok: 2, failed: 1 } });
    expect(r.results[1]).toMatchObject({ ok: false, id: 'bad', error: 'delete blew up' });
  });

  it('availability gate short-circuits the whole batch (no per-id delete)', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'memory_backend_disabled' });
    useBackend(b);
    const r = await body({ ids: ['m1', 'm2'] });
    expect(r).toMatchObject({ ok: false, reason: 'memory_backend_disabled' });
    expect(b.forget).not.toHaveBeenCalled();
  });
});
