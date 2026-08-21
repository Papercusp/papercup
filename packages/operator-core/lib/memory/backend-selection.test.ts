/**
 * Memory-backend selection (mem0-revive-or-retire / Brief 30) — the
 * persisted+live operator-wide choice behind getMemoryBackend()'s thunk.
 * The PG layer (@papercusp/db-org) is mocked with an in-memory key/value
 * store so the cache + env-fallback + persist logic is tested in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@papercusp/db-org', async (orig) => {
  const sql = Object.assign(
    (_strings: TemplateStringsArray, ...vals: unknown[]) => {
      // writeSetting upsert: VALUES (key, value, description, updated_at)
      store.set(String(vals[0]), String(vals[1]));
      return Promise.resolve([]);
    },
    { begin: vi.fn() },
  );
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({
      sql,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve(
                  store.has('memory_backend')
                    ? [{ value: store.get('memory_backend') }]
                    : [],
                ),
            }),
          }),
        }),
      },
    }),
    generated: { operatorSettingsInHarnessShared: { key: 'key', value: 'value' } },
  };
});

import {
  currentMemoryBackendChoice,
  initMemoryBackendSelection,
  readMemoryBackendChoice,
  writeMemoryBackendChoice,
  __resetMemoryBackendSelectionForTest,
} from './backend-selection';

describe('memory backend selection', () => {
  const priorEnv = process.env.PAPERCUSP_MEMORY_BACKEND;

  beforeEach(() => {
    store.clear();
    delete process.env.PAPERCUSP_MEMORY_BACKEND;
    __resetMemoryBackendSelectionForTest();
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.PAPERCUSP_MEMORY_BACKEND;
    else process.env.PAPERCUSP_MEMORY_BACKEND = priorEnv;
    __resetMemoryBackendSelectionForTest();
  });

  it('defaults to hybrid-pg when nothing is set', () => {
    // memory-declaude-and-defaults-2026-07-28 D-002 — was 'mem0' until the live
    // A/B put hybrid-pg at 98% recall@10 against mem0's 53%.
    expect(currentMemoryBackendChoice()).toBe('hybrid-pg');
  });

  it('falls back to PAPERCUSP_MEMORY_BACKEND before a load/write', () => {
    process.env.PAPERCUSP_MEMORY_BACKEND = 'noop';
    expect(currentMemoryBackendChoice()).toBe('noop');
  });

  it('writeMemoryBackendChoice persists + applies live (cache wins over env)', async () => {
    process.env.PAPERCUSP_MEMORY_BACKEND = 'mem0';
    await writeMemoryBackendChoice('noop');
    expect(currentMemoryBackendChoice()).toBe('noop');
    expect(store.get('memory_backend')).toBe('noop');
  });

  it('initMemoryBackendSelection hydrates the cache from PG', async () => {
    store.set('memory_backend', 'noop');
    // not yet loaded → env/default
    expect(currentMemoryBackendChoice()).toBe('hybrid-pg');
    await initMemoryBackendSelection();
    expect(currentMemoryBackendChoice()).toBe('noop');
  });

  it('readMemoryBackendChoice reads PG independent of the cache', async () => {
    store.set('memory_backend', 'noop');
    expect(await readMemoryBackendChoice()).toBe('noop');
    store.clear();
    process.env.PAPERCUSP_MEMORY_BACKEND = 'mem0';
    expect(await readMemoryBackendChoice()).toBe('mem0');
  });

  // WI-4484 recurrence guard: multi-process convergence. A flip persisted by a
  // PEER process (simulated as a direct PG-store write) must reach THIS
  // process's sync thunk within the stale-while-revalidate TTL — the boot-once
  // cache that never re-read PG is exactly the drift this pins.
  it('a peer process flip converges via the TTL background re-read (no restart)', async () => {
    vi.useFakeTimers();
    try {
      await initMemoryBackendSelection();
      await writeMemoryBackendChoice('hybrid-pg');
      expect(currentMemoryBackendChoice()).toBe('hybrid-pg');
      // A PEER process persists a different choice (writes PG behind our back).
      store.set('memory_backend', 'mem0');
      // Within the TTL the stale cache still serves (sync contract).
      expect(currentMemoryBackendChoice()).toBe('hybrid-pg');
      // Past the TTL, a read kicks the background refresh…
      vi.advanceTimersByTime(16_000);
      expect(currentMemoryBackendChoice()).toBe('hybrid-pg'); // kick happens async
      await vi.runAllTimersAsync(); // settle the background read
      // …and the peer's choice is now live here, no restart involved.
      expect(currentMemoryBackendChoice()).toBe('mem0');
    } finally {
      vi.useRealTimers();
    }
  });

  // memory-declaude-and-defaults-2026-07-28 P-004: `claude-file` and `hybrid`
  // are no longer REGISTERED, but their names can still be sitting in a live
  // operator_settings row or an env var. getMemoryBackend() throws loud on an
  // unknown name, so without coercion an install that legitimately chose one of
  // them before the retirement would throw on EVERY memory call after upgrading.
  describe('retired backends degrade to the default instead of throwing', () => {
    // The coercion deliberately warns, so the operator log shows a stale
    // setting rather than silently overriding the user's stored choice.
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    for (const retired of ['claude-file', 'hybrid']) {
      it(`coerces a persisted '${retired}' to the default`, async () => {
        store.set('memory_backend', retired);
        await initMemoryBackendSelection();
        expect(currentMemoryBackendChoice()).toBe('hybrid-pg');
        expect(await readMemoryBackendChoice()).toBe('hybrid-pg');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`'${retired}' is retired`));
      });

      it(`coerces PAPERCUSP_MEMORY_BACKEND='${retired}' to the default`, () => {
        process.env.PAPERCUSP_MEMORY_BACKEND = retired;
        expect(currentMemoryBackendChoice()).toBe('hybrid-pg');
      });
    }

    it('warns only ONCE per retired name, not on every memory call', () => {
      process.env.PAPERCUSP_MEMORY_BACKEND = 'hybrid';
      currentMemoryBackendChoice();
      currentMemoryBackendChoice();
      currentMemoryBackendChoice();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does NOT swallow an unknown-but-not-retired name — that is the typo guard', () => {
      // A typo'd env var must still reach getMemoryBackend() and throw there,
      // rather than silently resolving to the default and presenting as
      // "memory is just empty". Only names we actually retired are coerced.
      process.env.PAPERCUSP_MEMORY_BACKEND = 'hybrd-pg';
      expect(currentMemoryBackendChoice()).toBe('hybrd-pg');
    });
  });
});
