/**
 * two-tier.test.ts — the D-006 memory tiers (P-022 / FB-08): legacy
 * grandfathering, probationary admission shape, tier patching. Fake backend,
 * zero IO.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryBackend, RememberOptions, UpdatePatch } from '@papercusp/memory';
import { MEMORY_TIER_KEY, admitProbationaryMemory, memoryTierOf, setMemoryTier } from './two-tier';

describe('memoryTierOf', () => {
  it('explicit probationary reads probationary', () => {
    expect(memoryTierOf({ metadata: { [MEMORY_TIER_KEY]: 'probationary' } })).toBe('probationary');
  });

  it('everything else is validated — the whole legacy corpus is grandfathered', () => {
    expect(memoryTierOf({ metadata: { [MEMORY_TIER_KEY]: 'validated' } })).toBe('validated');
    expect(memoryTierOf({ metadata: {} })).toBe('validated');
    expect(memoryTierOf({})).toBe('validated');
    expect(memoryTierOf({ metadata: { [MEMORY_TIER_KEY]: 42 } })).toBe('validated'); // junk fails open
  });
});

function fakeBackend() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend = {
    name: 'fake',
    available: async () => ({ ok: true as const }),
    remember: async (text: string, opts: RememberOptions) => {
      calls.push({ method: 'remember', args: [text, opts] });
      return { ids: ['M1'], storedEvents: 1 };
    },
    search: async () => [],
    list: async () => [],
    get: async () => null,
    forget: async () => {},
    update: async (id: string, patch: UpdatePatch) => {
      calls.push({ method: 'update', args: [id, patch] });
    },
  } satisfies MemoryBackend;
  return { backend, calls };
}

describe('admitProbationaryMemory', () => {
  it('stores verbatim with the probationary tier merged into metadata', async () => {
    const { backend, calls } = fakeBackend();
    const id = await admitProbationaryMemory(backend, {
      text: 'lesson',
      scope: 'harness:test',
      kind: 'project',
      metadata: { origin: 'replay' },
    });
    expect(id).toBe('M1');
    const [text, opts] = calls[0].args as [string, RememberOptions];
    expect(text).toBe('lesson');
    expect(opts.verbatim).toBe(true);
    expect(opts.metadata).toEqual({ origin: 'replay', [MEMORY_TIER_KEY]: 'probationary' });
  });

  it('returns null when the backend declined to create an entry', async () => {
    const { backend } = fakeBackend();
    backend.remember = async () => ({ ids: [], storedEvents: 0 });
    expect(await admitProbationaryMemory(backend, { text: 't', scope: 's' })).toBeNull();
  });
});

describe('setMemoryTier', () => {
  it('patches the tier via the backend metadata merge-patch', async () => {
    const { backend, calls } = fakeBackend();
    await setMemoryTier(backend, 'M1', 'validated');
    expect(calls).toEqual([
      { method: 'update', args: ['M1', { metadata: { [MEMORY_TIER_KEY]: 'validated' } }] },
    ]);
  });
});
