/**
 * Tests for HotReloader (backs `papercusp plugin watch`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HotReloader } from './hot-reload.ts';

const ROOT = join(tmpdir(), `papercusp-hot-reload-test-${process.pid}`);

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('HotReloader', () => {
  let dir: string;
  let hr: HotReloader | null = null;

  beforeEach(async () => {
    dir = join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(() => {
    hr?.stop();
    hr = null;
  });

  it('emits "changed" then "reloaded" when a valid papercusp.json is written', async () => {
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8');

    hr = new HotReloader(dir, { debounceMs: 30 });
    const changed: Array<{ changedAt: Date }> = [];
    const reloaded: Array<{ plugin: { name: string; version: string } }> = [];
    hr.on('changed', (e) => changed.push(e));
    hr.on('reloaded', (e) => reloaded.push(e));
    await hr.start();

    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.2.0' }), 'utf8');

    await waitFor(() => reloaded.length > 0);
    expect(changed.length).toBeGreaterThan(0);
    expect(reloaded[0].plugin).toEqual({ name: 'demo', version: '0.2.0' });
  });

  it('emits "error" when the manifest is missing required fields after a change', async () => {
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8');

    hr = new HotReloader(dir, { debounceMs: 30 });
    const errors: Array<{ error: Error }> = [];
    hr.on('error', (e) => errors.push(e));
    await hr.start();

    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo' }), 'utf8');

    await waitFor(() => errors.length > 0);
    expect(errors[0].error.message).toMatch(/missing "name" or "version"/);
  });

  it('debounces a burst of changes into a single reload', async () => {
    // Coalescing is DEFINED only while every inter-event gap stays inside the debounce window
    // (scheduleChange restarts a plain setTimeout per fs event), so this test has to establish
    // that precondition rather than assume it. Two prior rounds of a FIXED window both lost the
    // same bet on host speed:
    //   - 100ms + `await setTimeout(10)` between writes: one event-loop stall fired the debounce
    //     mid-burst and landed 2 reloads ("expected 2 to be 1", gate candidate 1d0c4208).
    //   - WI-38201 dropped the artificial sleeps and widened to 1000ms (~100x margin), and made a
    //     stall report honestly as a stall instead of masquerading as a broken debouncer. But a
    //     loaded green-checkpoint host still blew straight through it — a 5-write burst took
    //     3126ms on candidate 79745446 — and a HOST STALL IS NOT A DEFECT IN HotReloader, so that
    //     red froze the whole release gate on something this code cannot cause.
    // No fixed number survives a box running ~76 agents. So stop betting and CALIBRATE: if the
    // burst did not fit, widen the window to the speed the host just demonstrated and retry.
    // The coalescing assertion itself is never skipped, softened, or made conditional — a
    // genuinely broken debouncer emits >1 reload and fails on every attempt — so this cannot
    // pass vacuously; only the precondition adapts.
    const MAX_ATTEMPTS = 3;
    const stalls: string[] = [];
    let debounceMs = 1000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8');

      hr = new HotReloader(dir, { debounceMs });
      const reloaded: unknown[] = [];
      hr.on('reloaded', (e) => reloaded.push(e));
      await hr.start();

      const burstStart = Date.now();
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: `0.${i}.0` }), 'utf8');
      }
      const burstMs = Date.now() - burstStart;

      await waitFor(() => reloaded.length > 0, debounceMs + 5000);
      // A straggler event would start a fresh window, so wait one full window for a 2nd reload.
      await new Promise((r) => setTimeout(r, debounceMs));

      if (burstMs < debounceMs) {
        expect(reloaded.length).toBe(1);
        return;
      }

      stalls.push(`attempt ${attempt}: a 5-write burst took ${burstMs}ms, past the ${debounceMs}ms window`);
      hr.stop();
      hr = null;
      // Re-aim at the speed actually observed, capped so a pathological host cannot stretch the
      // suite without bound.
      debounceMs = Math.min(burstMs * 4, 30_000);
    }

    throw new Error(
      `host too stalled to define debounce coalescing after ${MAX_ATTEMPTS} attempts — ` +
        `this is a host-capacity signal, NOT a HotReloader defect: ${stalls.join('; ')}`,
    );
  });

  it('stop() closes the watcher so no further events fire', async () => {
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8');

    hr = new HotReloader(dir, { debounceMs: 30 });
    const changed: unknown[] = [];
    hr.on('changed', (e) => changed.push(e));
    await hr.start();
    hr.stop();

    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.9.0' }), 'utf8');
    await new Promise((r) => setTimeout(r, 200));
    expect(changed.length).toBe(0);
  });
});
