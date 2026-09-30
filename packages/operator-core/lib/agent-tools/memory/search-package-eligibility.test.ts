/**
 * portable-identity-packages P-007 / D-021 — memory:search takes the package
 * visibility path. The real-store integration test
 * (blueprint/package-memory-visibility.integration.test.ts) proves the
 * eligibility SQL and the hit shaping; this pins that the TOOL routes through
 * them: the caller's applied pins reach BOTH recall legs as
 * `archivedEligibility` (before ranking, inside the same pools), the returned
 * hits are exact-version deduped with provenance, and a resolver fault fails
 * closed to "no pack rows", never to "no recall".
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/memory/search-package-eligibility.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  MemoryUnavailableError: class MemoryUnavailableError extends Error {},
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
}));
vi.mock('../../memory/configure', () => ({
  isOpenAiEmbedInCooldown: vi.fn(() => false),
}));

// The wearer and its pins are the two inputs under test; everything else in
// the visibility module (eligibility fragment, hit shaping) stays REAL.
const wearer = vi.hoisted(() => ({
  ownerId: null as string | null,
  pins: null as ((input: { workspaceId: string; ownerId: string | null | undefined }) => Promise<ReadonlySet<string>>) | null,
  calls: [] as Array<{ workspaceId: string; ownerId: string | null | undefined }>,
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/identity')>()),
  resolveAgentIdentity: () => ({ ownerId: wearer.ownerId }),
}));
vi.mock('../../blueprint/package-memory-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../blueprint/package-memory-visibility')>()),
  wearerPackageResourcesOrEmpty: async (
    _sql: unknown,
    input: { workspaceId: string; ownerId: string | null | undefined },
  ) => {
    wearer.calls.push(input);
    return wearer.pins ? wearer.pins(input) : new Set<string>();
  },
}));

import search from './search';
import { getMemoryBackend } from '../../memory/backend';
import { resetMemoryDegradedForTest } from '../../memory/op-deadline';
import { IDENTITY_PACKAGE_RESOURCE } from '../../blueprint/package-memory-visibility';

const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

const ORGANIC = { id: 'organic', text: 'organic pack note', kind: 'project', scope: 'harness:papercup', score: 0.5,
  metadata: { kind: 'project', source: 'agent' } };
/** One pack item at an exact version; `resource` is the installed receipt key. */
const packRow = (version: string, score: number) => ({
  id: `pack-${version}`, text: `pack note ${version}`, kind: 'reference', scope: 'harness:papercup', score,
  metadata: { kind: 'reference', source: 'pack', pack_id: 'visibility-pack', pack_item_id: 'shared',
    pack_version: version, [IDENTITY_PACKAGE_RESOURCE]: `res-${version}` },
});

type Opts = { scope: string[]; archivedEligibility?: { key: string; values: string[] } };
const recallBackend = (rows: unknown[], semantic: 'ok' | 'saturated' = 'ok') => ({
  name: 'fake',
  scoreScale: 'rrf' as const,
  lexicalScoreScale: 'lexical' as const,
  available: vi.fn(async () => ({ ok: true })),
  search: vi.fn(async (_query: string, _opts: Opts) => (semantic === 'ok' ? rows : NEVER<unknown[]>())),
  searchLexical: vi.fn(async (_query: string, _opts: Opts) => rows),
  list: vi.fn(async () => [] as unknown[]),
  get: vi.fn(async () => null),
  remember: vi.fn(async () => ({ ids: [] })),
  update: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
});
const useBackend = (b: { name: string }): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
type Out = { ok: boolean; fallback?: string;
  results?: Array<{ id: string; memory: string; metadata?: Record<string, unknown> }> };
const parse = (res: unknown): Out => {
  const r = res as { data?: never; content?: Array<{ text: string }> };
  return r.data ?? JSON.parse(r.content![0].text);
};

beforeAll(() => {
  process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = '30';
});
afterAll(() => {
  delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
});
beforeEach(() => {
  resetMemoryDegradedForTest();
  wearer.ownerId = null;
  wearer.pins = null;
  wearer.calls = [];
});

describe('memory:search identity-package eligibility (P-007)', () => {
  it("routes the wearer's applied pins into the semantic leg and shapes the hits it returns", async () => {
    wearer.ownerId = 'wearer-a';
    wearer.pins = async () => new Set(['res-1.0.0']);
    // A promoted 2.0.0 copy of the same item is pool-wide; the wearer's pinned
    // 1.0.0 row must win the (pack_id, pack_item_id) dedupe despite scoring lower.
    const backend = recallBackend([ORGANIC, packRow('2.0.0', 0.9), packRow('1.0.0', 0.6)]);
    useBackend(backend);

    const out = parse(await search.handler({ query: 'pack note' }, ctx));

    expect(out.ok).toBe(true);
    expect(wearer.calls).toEqual([{ workspaceId: 'ws-test', ownerId: 'wearer-a' }]);
    expect(backend.search.mock.calls[0][1].archivedEligibility).toEqual({
      key: IDENTITY_PACKAGE_RESOURCE, values: ['res-1.0.0'] });
    expect(out.results?.map((r) => r.id)).toEqual(['pack-1.0.0', 'organic']);
    expect(out.results?.[0].metadata?.identity_package).toEqual({
      pack_id: 'visibility-pack', pack_version: '1.0.0', pack_item_id: 'shared', pinned: true });
    expect(out.results?.[1].metadata).not.toHaveProperty('identity_package');
  });

  it('carries the same eligibility into the lexical fallback when the semantic leg saturates', async () => {
    wearer.ownerId = 'wearer-a';
    wearer.pins = async () => new Set(['res-1.0.0']);
    const backend = recallBackend([ORGANIC, packRow('1.0.0', 0.6)], 'saturated');
    useBackend(backend);

    const out = parse(await search.handler({ query: 'pack note' }, ctx));

    expect(out.fallback).toBe('lexical');
    expect(backend.searchLexical.mock.calls[0][1].archivedEligibility).toEqual({
      key: IDENTITY_PACKAGE_RESOURCE, values: ['res-1.0.0'] });
    expect(out.results?.map((r) => r.id)).toEqual(['pack-1.0.0', 'organic']);
  });

  it('asks for no archived rows when the caller wears nothing', async () => {
    const backend = recallBackend([ORGANIC]);
    useBackend(backend);

    const out = parse(await search.handler({ query: 'pack note' }, ctx));

    expect(out.results?.map((r) => r.id)).toEqual(['organic']);
    expect(wearer.calls).toEqual([]);
    expect(backend.search.mock.calls[0][1]).not.toHaveProperty('archivedEligibility');
  });

  it('fails closed to no pack rows, never to no recall, when the pin resolver faults', async () => {
    wearer.ownerId = 'wearer-a';
    wearer.pins = async () => { throw new Error('org pg unreachable'); };
    const backend = recallBackend([ORGANIC]);
    useBackend(backend);

    const out = parse(await search.handler({ query: 'pack note' }, ctx));

    expect(out.ok).toBe(true);
    expect(out.results?.map((r) => r.id)).toEqual(['organic']);
    expect(backend.search.mock.calls[0][1]).not.toHaveProperty('archivedEligibility');
  });
});
