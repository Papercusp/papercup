/**
 * retryingImporter — the retry behind the autoCodeSplitting route-component
 * chunk loads (WI-2902). A transient chunk-fetch failure (first-boot operator
 * event-loop starvation) must be retried with a FRESH import()/fetch per
 * attempt, NOT dead-end at the fatal route error card; a genuine render/logic
 * bug in the module must re-throw immediately (never retried).
 *
 * Run with:
 *   node_modules/.bin/vitest run --config apps/operator-vite/vitest.config.ts \
 *     apps/operator-vite/src/lib/lazy-route-component-retry.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { retryingImporter } from './lazy-route-component-retry';

// The WebKitGTK phrasing the packaged Tauri desktop actually throws for a
// rejected dynamic import — the message that slipped the OLD webpack-only regex.
const chunkErr = () => new Error('Importing a module script failed.');

describe('retryingImporter', () => {
  it('retries a chunk-load failure with a fresh import per attempt, then resolves', async () => {
    let calls = 0;
    const importer = vi.fn(() => {
      calls += 1;
      // fail the first 2 loads (chunk error), succeed on the 3rd
      return calls < 3 ? Promise.reject(chunkErr()) : Promise.resolve({ default: 'ok' });
    });
    const wrapped = retryingImporter(importer, { retries: 5, intervalMs: 1, maxIntervalMs: 2 });
    await expect(wrapped()).resolves.toEqual({ default: 'ok' });
    expect(importer).toHaveBeenCalledTimes(3); // fresh import() each attempt
  });

  it('re-throws a NON-chunk error immediately (never retried)', async () => {
    const importer = vi.fn(() =>
      Promise.reject(new TypeError("Cannot read properties of undefined (reading 'map')")),
    );
    const wrapped = retryingImporter(importer, { retries: 5, intervalMs: 1 });
    await expect(wrapped()).rejects.toBeInstanceOf(TypeError);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('gives up after `retries` chunk failures and rejects (never an infinite spinner)', async () => {
    const importer = vi.fn(() => Promise.reject(chunkErr()));
    const wrapped = retryingImporter(importer, { retries: 3, intervalMs: 1, maxIntervalMs: 2 });
    await expect(wrapped()).rejects.toThrow('Importing a module script failed');
    // 1 initial attempt + 3 retries
    expect(importer).toHaveBeenCalledTimes(4);
  });

  it('resolves on the first try without waiting when the chunk loads cleanly', async () => {
    const importer = vi.fn(() => Promise.resolve({ default: 'C' }));
    const wrapped = retryingImporter(importer);
    await expect(wrapped()).resolves.toEqual({ default: 'C' });
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
