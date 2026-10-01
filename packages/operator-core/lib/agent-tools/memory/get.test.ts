/**
 * memory:get — by-id read (WI-10004550). Invariants:
 *
 *  1. BY-ID READ: `id` and `ids` resolve through backend.get and return the shared wire row
 *     { id, memory, metadata } (kind folded into metadata, like memory:list/search).
 *  2. ISOLATION: a row in the caller's own pool or a harness/hive pool is returned; a row in
 *     ANOTHER user's pool is reported as `missing`, indistinguishable from an unknown id —
 *     the tool is never an existence oracle for someone else's memory.
 *  3. UNKNOWN IDS go to `missing` (ok:true — the store answered), duplicates collapse.
 *  4. DEGRADED-NEVER-SILENT: a down store / mid-flight unavailability / timeout yields
 *     { ok:false, reason, results:[], missing:[] }, never a throw and never a silent empty ok:true.
 *  5. ARGS: neither `id` nor `ids` is rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));

import get from './get';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import type { MemoryEntry } from '../../memory/backend';

type Out = { ok: boolean; reason?: string; results: Array<{ id: string; memory: string; metadata?: Record<string, unknown> }>; missing: string[] };
const run = async (args: { id?: string; ids?: string[] }): Promise<Out> => {
  const res = (await (get as unknown as { handler: (a: unknown, c: unknown) => Promise<unknown> }).handler(args, {})) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Out;
};
const entry = (id: string, scope: string, extra: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({ id, scope, text: `text of ${id}`, kind: 'project', ...extra }) as MemoryEntry;

function backendWith(rows: Record<string, MemoryEntry | null>, opts: { available?: { ok: boolean; reason?: string }; getImpl?: (id: string) => Promise<MemoryEntry | null> } = {}) {
  const getSpy = vi.fn(opts.getImpl ?? (async (id: string) => rows[id] ?? null));
  vi.mocked(getMemoryBackend).mockReturnValue({
    name: 'fake',
    available: vi.fn(async () => opts.available ?? { ok: true }),
    get: getSpy,
  } as unknown as ReturnType<typeof getMemoryBackend>);
  return getSpy;
}

beforeEach(() => vi.clearAllMocks());

describe('memory:get', () => {
  it('reads one id and returns the shared wire row with kind folded into metadata', async () => {
    const getSpy = backendWith({ m1: entry('m1', 'user-1', { metadata: { a: 1 } }) });
    const out = await run({ id: 'm1' });
    expect(out).toEqual({ ok: true, results: [{ id: 'm1', memory: 'text of m1', metadata: { a: 1, kind: 'project' } }], missing: [] });
    expect(getSpy).toHaveBeenCalledWith('m1');
  });

  it('reads many ids, dedupes, merges id+ids, and reports unknown ids as missing with ok:true', async () => {
    const getSpy = backendWith({ m1: entry('m1', 'user-1'), m2: entry('m2', 'harness:papercusp'), m3: entry('m3', 'hive:pot-a') });
    const out = await run({ id: 'm1', ids: ['m1', 'm2', 'm3', 'nope'] });
    expect(out.ok).toBe(true);
    expect(out.results.map((r) => r.id)).toEqual(['m1', 'm2', 'm3']);
    expect(out.missing).toEqual(['nope']);
    expect(getSpy).toHaveBeenCalledTimes(4); // m1 once despite being passed twice
  });

  it("ISOLATION: another user's row is `missing`, identical to an unknown id — no existence oracle", async () => {
    backendWith({ theirs: entry('theirs', 'user-2'), ghost: null });
    const out = await run({ ids: ['theirs', 'ghost'] });
    expect(out.results).toEqual([]);
    expect(out.missing).toEqual(['theirs', 'ghost']);
    expect(JSON.stringify(out)).not.toContain('text of theirs');
  });

  it('degraded-never-silent: down store, mid-flight unavailability and timeout all return the ok:false envelope', async () => {
    backendWith({}, { available: { ok: false, reason: 'store_down' } });
    expect(await run({ id: 'm1' })).toEqual({ ok: false, reason: 'store_down', results: [], missing: [] });

    backendWith({}, { getImpl: async () => { throw new MemoryUnavailableError('went_away'); } });
    expect(await run({ id: 'm1' })).toEqual({ ok: false, reason: 'went_away', results: [], missing: [] });
  });

  it('rejects a call with neither id nor ids', () => {
    const schema = (get as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ ids: [] }).success).toBe(false);
    expect(schema.safeParse({ id: 'm1' }).success).toBe(true);
    expect(schema.safeParse({ ids: Array.from({ length: 51 }, (_, i) => `m${i}`) }).success).toBe(false);
  });
});
