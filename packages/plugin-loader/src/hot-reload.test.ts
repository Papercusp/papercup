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
    await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }), 'utf8');

    // WI-38201: this test coalesces ONLY while every inter-event gap stays inside the
    // debounce window (scheduleChange restarts a plain setTimeout per fs event). It used a
    // 100ms window with `await setTimeout(10)` between writes, so ONE event-loop stall on a
    // loaded green-checkpoint host pushed a gap past 100ms, fired the debounce mid-burst and
    // landed 2 reloads ("expected 2 to be 1", gate candidate 1d0c4208). The artificial sleeps
    // bought nothing — awaited writes are already sequential — and were the stall amplifier.
    // Dropping them and widening the window takes the margin from ~2x to ~100x.
    const debounceMs = 1000;
    hr = new HotReloader(dir, { debounceMs });
    const reloaded: unknown[] = [];
    hr.on('reloaded', (e) => reloaded.push(e));
    await hr.start();

    const burstStart = Date.now();
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify({ name: 'demo', version: `0.${i}.0` }), 'utf8');
    }
    const burstMs = Date.now() - burstStart;

    await waitFor(() => reloaded.length > 0, 5000);
    // A straggler event would start a fresh window, so wait one full window for a 2nd reload.
    await new Promise((r) => setTimeout(r, debounceMs));

    // Assert the PRECONDITION separately: coalescing is only defined when the burst fit in one
    // window. If the host stalled past it, this fails as "the host stalled" instead of
    // masquerading as a broken debouncer — and it is an assertion, not a skip, so a stalled
    // run can never pass vacuously.
    expect(burstMs).toBeLessThan(debounceMs);
    expect(reloaded.length).toBe(1);
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
