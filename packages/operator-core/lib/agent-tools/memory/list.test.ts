/**
 * memory:list — invariant coverage (task #36, memory public-release hardening).
 *
 * memory:list was the one memory READ tool with no direct test of its own — its
 * timeout branch is exercised in b1-timeout.test.ts, but its SCOPE construction,
 * its two other degrade branches, and its temporal passthrough were unguarded.
 * This file covers the invariants that matter for a public release:
 *
 *  1. SCOPE ISOLATION (no cross-tenant bleed): the pools passed to backend.list are
 *     EXACTLY the caller's own user id plus the harness/hive pools they explicitly
 *     asked for — never another user, never an unscoped wildcard. This is the
 *     invariant that, if broken, leaks one user's memories into another's list.
 *  2. DEGRADED-NEVER-SILENT: a store problem yields the { ok:false, reason,
 *     results:[] } envelope, NEVER a thrown 500 and NEVER a silent empty { ok:true }.
 *     Covers the down-store probe AND a mid-flight MemoryUnavailableError (the branch
 *     memory:list was missing — the store going down between available() and list()).
 *  3. TEMPORAL passthrough: as_of / include_superseded reach backend.list unchanged.
 *  4. RESPONSE CONTRACT: happy path is { ok:true, results:[{id,memory,metadata}] }.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/memory/list.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (def: unknown) => def }));
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

import list from './list';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import type { MemoryEntry } from '../../memory/backend';

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
const parse = (res: unknown): { ok: boolean; reason?: string; results?: unknown[] } => {
  const r = res as { data?: unknown; content?: Array<{ text: string }> };
  return (r.data ?? JSON.parse(r.content![0].text)) as { ok: boolean; reason?: string; results?: unknown[] };
};

type ListArg = { scope: string[]; kind?: string; asOf?: string; includeSuperseded?: boolean };
const okBackend = (entries: MemoryEntry[] = []) => {
  const listSpy = vi.fn(async (_: ListArg) => entries);
  return {
    backend: {
      name: 'fake',
      available: vi.fn(async () => ({ ok: true })),
      list: listSpy,
    },
    listSpy,
  };
};
const useBackend = (b: unknown): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as ReturnType<typeof getMemoryBackend>);
};
const lastScope = (spy: ReturnType<typeof vi.fn>): string[] => spy.mock.calls.at(-1)![0].scope;

beforeEach(() => vi.clearAllMocks());

describe('memory:list — scope isolation (no cross-tenant bleed)', () => {
  it('default list is scoped to ONLY the caller\'s own user id', async () => {
    const { backend, listSpy } = okBackend();
    useBackend(backend);
    await list.handler({}, ctx);
    expect(lastScope(listSpy)).toEqual(['user-1']);
  });

  it('never includes another user\'s pool or a wildcard, regardless of args', async () => {
    const { backend, listSpy } = okBackend();
    useBackend(backend);
    await list.handler({ harness_slug: 'papercup', hive_slug: 'team-x', kind: 'user' }, ctx);
    const scope = lastScope(listSpy);
    // Every pool is either the caller's own id or a namespaced pool they named.
    expect(scope).toEqual(['user-1', 'harness:papercup', 'hive:team-x']);
    expect(scope).not.toContain('*');
    expect(scope.some((s) => /^user-(?!1$)/.test(s))).toBe(false); // no other user-N
  });

  it('adds the harness pool only when harness_slug is given', async () => {
    const { backend, listSpy } = okBackend();
    useBackend(backend);
    await list.handler({ harness_slug: 'papercup' }, ctx);
    expect(lastScope(listSpy)).toEqual(['user-1', 'harness:papercup']);
  });

  it('adds the hive pool only when hive_slug is given', async () => {
    const { backend, listSpy } = okBackend();
    useBackend(backend);
    await list.handler({ hive_slug: 'learners' }, ctx);
    expect(lastScope(listSpy)).toEqual(['user-1', 'hive:learners']);
  });
});

describe('memory:list — degraded-never-silent (every read failure is an envelope, never a throw/empty-ok)', () => {
  it('a DOWN store (available:false) returns { ok:false, reason, results:[] } — not a silent empty ok', async () => {
    const backend = {
      name: 'down',
      available: vi.fn(async () => ({ ok: false, reason: 'mem0_unavailable' })),
      list: vi.fn(async () => []),
    };
    useBackend(backend);
    const out = parse(await list.handler({}, ctx));
    expect(out).toEqual({ ok: false, reason: 'mem0_unavailable', results: [] });
    // The store was never queried once the probe said down.
    expect(backend.list).not.toHaveBeenCalled();
  });

  it('a mid-flight MemoryUnavailableError degrades to an envelope (regression: this branch was missing)', async () => {
    const backend = {
      name: 'races-down',
      // Probe passes, then the store drops before/during list() — the exact race
      // memory:search already handled but memory:list did not.
      available: vi.fn(async () => ({ ok: true })),
      list: vi.fn(async () => {
        throw new MemoryUnavailableError('mem0_unavailable');
      }),
    };
    useBackend(backend);
    const out = parse(await list.handler({}, ctx));
    expect(out).toEqual({ ok: false, reason: 'mem0_unavailable', results: [] });
  });

  it('an UNEXPECTED error (not a memory failure) still propagates — we degrade store problems, not bugs', async () => {
    const backend = {
      name: 'buggy',
      available: vi.fn(async () => ({ ok: true })),
      list: vi.fn(async () => {
        throw new TypeError('genuine programming error');
      }),
    };
    useBackend(backend);
    await expect(list.handler({}, ctx)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('memory:list — temporal passthrough + response contract', () => {
  it('as_of and include_superseded ride into backend.list unchanged', async () => {
    const { backend, listSpy } = okBackend();
    useBackend(backend);
    await list.handler({ as_of: '2026-06-15T00:00:00Z', include_superseded: true }, ctx);
    const arg = listSpy.mock.calls.at(-1)![0];
    expect(arg.asOf).toBe('2026-06-15T00:00:00Z');
    expect(arg.includeSuperseded).toBe(true);
  });

  it('omits temporal keys entirely when not requested (default read stays trivial)', async () => {
    const { backend, listSpy } = okBackend();
    useBackend(backend);
    await list.handler({}, ctx);
    const arg = listSpy.mock.calls.at(-1)![0];
    expect('asOf' in arg).toBe(false);
    expect('includeSuperseded' in arg).toBe(false);
  });

  it('happy path returns { ok:true, results:[{id,memory,metadata}] } via toWireRow', async () => {
    const { backend } = okBackend([
      { id: 'm1', text: 'the user prefers nuqs', scope: 'user-1', kind: 'preference' } as MemoryEntry,
    ]);
    useBackend(backend);
    const out = parse(await list.handler({}, ctx));
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([{ id: 'm1', memory: 'the user prefers nuqs', metadata: { kind: 'preference' } }]);
  });
});
