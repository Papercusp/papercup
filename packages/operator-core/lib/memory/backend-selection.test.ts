/**
 * Memory-backend selection (mem0-revive-or-retire / Brief 30) — the
 * persisted+live operator-wide choice behind getMemoryBackend()'s thunk.
 * The PG layer (@papercusp/db-org) is mocked with an in-memory key/value
 * store so the cache + env-fallback + persist logic is tested in isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@papercusp/db-org', () => {
  const sql = (_strings: TemplateStringsArray, ...vals: unknown[]) => {
    // writeSetting upsert: VALUES (key, value, description, updated_at)
    store.set(String(vals[0]), String(vals[1]));
    return Promise.resolve([]);
  };
  return {
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

  it('defaults to mem0 when nothing is set', () => {
    expect(currentMemoryBackendChoice()).toBe('mem0');
  });

  it('falls back to PAPERCUSP_MEMORY_BACKEND before a load/write', () => {
    process.env.PAPERCUSP_MEMORY_BACKEND = 'noop';
    expect(currentMemoryBackendChoice()).toBe('noop');
  });

  it('writeMemoryBackendChoice persists + applies live (cache wins over env)', async () => {
    process.env.PAPERCUSP_MEMORY_BACKEND = 'mem0';
    await writeMemoryBackendChoice('claude-file');
    expect(currentMemoryBackendChoice()).toBe('claude-file');
    expect(store.get('memory_backend')).toBe('claude-file');
  });

  it('initMemoryBackendSelection hydrates the cache from PG', async () => {
    store.set('memory_backend', 'claude-file');
    // not yet loaded → env/default
    expect(currentMemoryBackendChoice()).toBe('mem0');
    await initMemoryBackendSelection();
    expect(currentMemoryBackendChoice()).toBe('claude-file');
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
      await writeMemoryBackendChoice('hybrid');
      expect(currentMemoryBackendChoice()).toBe('hybrid');
      // A PEER process persists a different choice (writes PG behind our back).
      store.set('memory_backend', 'mem0');
      // Within the TTL the stale cache still serves (sync contract).
      expect(currentMemoryBackendChoice()).toBe('hybrid');
      // Past the TTL, a read kicks the background refresh…
      vi.advanceTimersByTime(16_000);
      expect(currentMemoryBackendChoice()).toBe('hybrid'); // kick happens async
      await vi.runAllTimersAsync(); // settle the background read
      // …and the peer's choice is now live here, no restart involved.
      expect(currentMemoryBackendChoice()).toBe('mem0');
    } finally {
      vi.useRealTimers();
    }
  });
});
