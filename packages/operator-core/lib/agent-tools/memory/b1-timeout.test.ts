/**
 * B1 (infra-fail-fast-build-integrity-2026-06-19) — memory tools must DEADLINE,
 * not hang. Regression net for the 2026-06-19 :3070 outage class: mem0 failed to
 * load (better-sqlite3 ABI mismatch) and every memory-touching handler hung
 * FOREVER behind a green health check. Each tool now bounds every backend call
 * with `withMemoryToolTimeout` and maps a hang to a `{ ok:false,
 * reason:'memory_timeout' }` envelope.
 *
 * A never-resolving backend simulates the wedge; PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS
 * is shrunk so the deadline fires in milliseconds instead of seconds.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
  // Real-shaped MemoryUnavailableError so remember.ts's `instanceof` branch is
  // distinct from the timeout branch (we never hit it here, but keep parity).
  MemoryUnavailableError: class MemoryUnavailableError extends Error {
    constructor(public readonly reason: string) {
      super(`memory backend unavailable: ${reason}`);
      this.name = 'MemoryUnavailableError';
    }
  },
}));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'papercup' }] })),
}));
// db-org is left REAL: the timeout path returns before any getOrgPg() call
// (anchor-persist / feedback-rerank are post-success), and mocking the module
// wholesale drops its `generated` export that transitive imports rely on.

import search from './search';
import list from './list';
import remember from './remember';
import update from './update';
import forget from './forget';
import { getMemoryBackend } from '../../memory/backend';
import {
  MemoryTimeoutError,
  isMemoryDegraded,
  memoryToolTimeoutMs,
  resetMemoryDegradedForTest,
  withMemoryTimeout,
  withMemoryToolTimeout,
} from '../../memory/op-deadline';

const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});

/** A backend whose every method hangs forever — the wedged-store simulation. */
const wedgedBackend = () => ({
  name: 'wedged',
  available: vi.fn(() => NEVER<{ ok: boolean }>()),
  search: vi.fn(() => NEVER<unknown[]>()),
  list: vi.fn(() => NEVER<unknown[]>()),
  get: vi.fn(() => NEVER<unknown>()),
  remember: vi.fn(() => NEVER<{ ids: string[] }>()),
  update: vi.fn(() => NEVER<void>()),
  forget: vi.fn(() => NEVER<void>()),
});

/** A backend whose FIRST remember hangs (a transient write-path stall) then
 *  succeeds — the EI-6684 recovery case. available()/search() are healthy (the
 *  incident: "reads worked fine"), so the retry lands on the write. */
const flakyWriteBackend = () => {
  let rememberCalls = 0;
  return {
    name: 'flaky-write',
    available: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async () => [] as unknown[]),
    list: vi.fn(async () => [] as unknown[]),
    get: vi.fn(async () => null),
    remember: vi.fn(() => {
      rememberCalls += 1;
      return rememberCalls === 1
        ? NEVER<{ ids: string[] }>()
        : Promise.resolve({ ids: ['m-new'], storedEvents: 1 });
    }),
    update: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
  };
};

const useBackend = (b: { name: string }): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

const ctx = { principal: { workspaceId: 'ws-test' } } as never;
const parse = (res: unknown): { ok: boolean; reason?: string; results?: unknown[] } => {
  const r = res as { data?: any; content?: Array<{ text: string }> };
  // Bulk tools return the canonical { data: envelope }; a top-level guard/error
  // path still returns a raw { content } ToolResult — read whichever is present.
  return r.data ?? JSON.parse(r.content![0].text);
};

// noteMemoryFailure() warns when it latches degraded, but that log line is
// NODE_ENV!=='test' guarded in op-deadline.ts (the latch still flips), so under
// vitest there is no console.warn for fail-on-console to trip on.
beforeAll(() => {
  // Shrink the deadline so the wedge trips in ~30ms, not 10s.
  process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = '30';
});
afterAll(() => {
  delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
});
beforeEach(() => {
  resetMemoryDegradedForTest();
});

describe('op-deadline primitive', () => {
  it('withMemoryTimeout resolves a fast promise', async () => {
    await expect(withMemoryTimeout(Promise.resolve('ok'), 'fast', 1000)).resolves.toBe('ok');
  });

  it('withMemoryTimeout rejects a slow promise with MemoryTimeoutError', async () => {
    await expect(withMemoryTimeout(NEVER<string>(), 'slow', 20)).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
  });

  it('withMemoryToolTimeout flips the process degraded latch on timeout', async () => {
    expect(isMemoryDegraded()).toBe(false);
    await expect(withMemoryToolTimeout(NEVER<string>(), 'slow')).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(isMemoryDegraded()).toBe(true);
  });

  it('withMemoryToolTimeout does NOT latch on a fast success', async () => {
    await expect(withMemoryToolTimeout(Promise.resolve(42), 'fast')).resolves.toBe(42);
    expect(isMemoryDegraded()).toBe(false);
  });

  it('memoryToolTimeoutMs reads the env override, falls back to 10s', () => {
    expect(memoryToolTimeoutMs()).toBe(30); // set in beforeAll
    const prev = process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    expect(memoryToolTimeoutMs()).toBe(10_000);
    process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = prev;
  });
});

describe('memory tools return memory_timeout on a wedged backend (no infinite hang)', () => {
  it('memory:search → { ok:false, reason:"memory_timeout", results:[] }', async () => {
    useBackend(wedgedBackend());
    expect(parse(await search.handler({ query: 'q' }, ctx))).toEqual({
      ok: false,
      reason: 'memory_timeout',
      results: [],
    });
  });

  it('memory:list → { ok:false, reason:"memory_timeout", results:[] }', async () => {
    useBackend(wedgedBackend());
    expect(parse(await list.handler({}, ctx))).toEqual({
      ok: false,
      reason: 'memory_timeout',
      results: [],
    });
  });

  it('memory:remember → { ok:false, reason:"memory_timeout" }', async () => {
    useBackend(wedgedBackend());
    expect(parse(await remember.handler({ content: 'a fact', kind: 'user' }, ctx))).toEqual({
      ok: false,
      reason: 'memory_timeout',
    });
  });

  it('memory:update → { ok:false, reason:"memory_timeout" }', async () => {
    useBackend(wedgedBackend());
    const res = await update.handler(
      {
        id: '00000000-0000-4000-8000-000000000000',
        content: 'fixed',
      },
      ctx,
    );
    expect(parse(res)).toEqual({ ok: false, reason: 'memory_timeout' });
  });

  it('memory:forget → { ok:false, reason:"memory_timeout" }', async () => {
    useBackend(wedgedBackend());
    expect(parse(await forget.handler({ id: 'm1' }, ctx))).toEqual({
      ok: false,
      reason: 'memory_timeout',
    });
  });
});

describe('memory:remember recovers a TRANSIENT write timeout instead of dropping the fact (EI-6684)', () => {
  beforeEach(() => {
    // No backoff between attempts so the retry is instant in the test.
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '0';
  });
  afterAll(() => {
    delete process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS;
  });

  it('a first-attempt write timeout is RETRIED and the second attempt succeeds → { ok:true, ids }', async () => {
    const backend = flakyWriteBackend();
    useBackend(backend);
    // The reported incident was two consecutive memory_timeouts silently dropping
    // a ~700-char project fact; here the write path is only TRANSIENTLY wedged, so
    // the bounded retry must recover it rather than return memory_timeout.
    expect(parse(await remember.handler({ content: 'a durable fact', kind: 'project' }, ctx))).toEqual({
      ok: true,
      ids: ['m-new'],
    });
    expect(backend.remember).toHaveBeenCalledTimes(2); // 1 timed-out + 1 recovered
  });
});
