// watch-heartbeat.ts (EI-5202) — the pure path-resolution + payload-construction
// functions that back the dev-watch heartbeat plugin. A wedged-but-running
// `vite build --watch` used to give no signal at all (dist/index.html mtime
// hours/days behind HEAD, no error); this stamps a heartbeat file after every
// rebuild so a future health probe can detect staleness.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHeartbeatPath, buildHeartbeatPayload, watchHeartbeatPlugin } from './watch-heartbeat';

describe('resolveHeartbeatPath (EI-5202)', () => {
  it('defaults to the watch-singleton default lock path + ".heartbeat" when nothing is set', () => {
    expect(resolveHeartbeatPath({})).toBe('/tmp/papercup-operator-vite-watch.lock.heartbeat');
  });

  it('rides alongside a custom VITE_WATCH_LOCK (the singleton and the heartbeat agree on one location)', () => {
    expect(resolveHeartbeatPath({ VITE_WATCH_LOCK: '/tmp/custom.lock' })).toBe('/tmp/custom.lock.heartbeat');
  });

  it('VITE_WATCH_HEARTBEAT overrides outright, even when VITE_WATCH_LOCK is also set', () => {
    expect(
      resolveHeartbeatPath({ VITE_WATCH_LOCK: '/tmp/custom.lock', VITE_WATCH_HEARTBEAT: '/tmp/explicit.json' }),
    ).toBe('/tmp/explicit.json');
  });

  it('an empty-string override is treated as unset (falls through to the lock-derived default)', () => {
    expect(resolveHeartbeatPath({ VITE_WATCH_HEARTBEAT: '   ' })).toBe(
      '/tmp/papercup-operator-vite-watch.lock.heartbeat',
    );
  });
});

describe('buildHeartbeatPayload (EI-5202)', () => {
  it('carries the given instant as both an epoch-ms and an ISO string, plus the git SHA', () => {
    const nowMs = Date.parse('2026-07-04T00:00:00.000Z');
    const payload = buildHeartbeatPayload(nowMs, 'abc123');
    expect(payload).toEqual({
      builtAtMs: nowMs,
      builtAt: '2026-07-04T00:00:00.000Z',
      gitSha: 'abc123',
    });
  });

  it('a null git SHA (unresolvable, e.g. no .git in this checkout) is carried through, never fatal', () => {
    const payload = buildHeartbeatPayload(0, null);
    expect(payload.gitSha).toBeNull();
    expect(payload.builtAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('one-shot build progress (EI-28171117618903276)', () => {
  afterEach(() => vi.useRealTimers());

  function setup(watch = false) {
    const lines: string[] = [];
    const plugin = watchHeartbeatPlugin();
    (plugin.configResolved as (config: unknown) => void)({
      root: '/unused', build: { watch }, logger: { info: (line: string) => lines.push(line) },
    });
    const call = (name: 'buildStart' | 'buildEnd' | 'renderStart' | 'generateBundle'
      | 'writeBundle' | 'renderError' | 'closeBundle', error?: Error) => {
      const hook = plugin[name];
      const handler = (typeof hook === 'function' ? hook : hook!.handler) as (...args: unknown[]) => unknown;
      return handler(error);
    };
    const rows = () => lines.map(line => JSON.parse(line.slice('[vite-build-progress] '.length)));
    return { call, rows };
  }

  it('retains phase and CPU progress during a silent render, then stops after output closes', async () => {
    vi.useFakeTimers();
    const run = setup();
    run.call('buildStart');
    run.call('buildEnd');
    run.call('renderStart');
    vi.advanceTimersByTime(60_000);
    const progress = run.rows().filter(row => row.event === 'progress');
    expect(progress).toHaveLength(2);
    expect(progress.map(row => row.phase)).toEqual(['render-start', 'render-start']);
    expect(progress[1].phaseElapsedMs).toBe(60_000);
    expect(progress.every(row => row.pid === process.pid && row.cpuUserMs >= 0
      && row.cpuSystemMs >= 0)).toBe(true);
    run.call('generateBundle');
    await run.call('writeBundle');
    run.call('closeBundle');
    expect(run.rows().filter(row => row.event === 'phase').map(row => row.phase)).toEqual([
      'build-start', 'build-end', 'render-start', 'generate-end', 'write-end', 'close',
    ]);
    expect(vi.getTimerCount()).toBe(0);
    const count = run.rows().length;
    vi.advanceTimersByTime(60_000);
    expect(run.rows()).toHaveLength(count);
  });

  it.each(['buildEnd', 'renderError'] as const)('stops progress when %s fails', (hook) => {
    vi.useFakeTimers();
    const run = setup();
    run.call('buildStart');
    run.call(hook, new Error('fixture failure'));
    expect(run.rows().at(-1).phase).toBe(hook === 'buildEnd' ? 'build-error' : 'render-error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not add a progress timer or one-shot log to watch rebuilds', () => {
    vi.useFakeTimers();
    const run = setup(true);
    run.call('buildStart');
    run.call('buildEnd');
    run.call('renderStart');
    run.call('closeBundle');
    expect(run.rows()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports real Vite build boundaries even when output is kept in memory', async () => {
    const { build, createLogger } = await import('vite');
    const root = mkdtempSync(join(tmpdir(), 'vite-build-progress-'));
    const lines: string[] = [];
    const logger = createLogger('silent');
    logger.info = line => { lines.push(line); };
    try {
      writeFileSync(join(root, 'main.js'), 'console.log("fixture");');
      await build({ configFile: false, root, publicDir: false, customLogger: logger,
        plugins: [watchHeartbeatPlugin()], build: { write: false,
          rollupOptions: { input: join(root, 'main.js') } } });
      const rows = lines.filter(line => line.startsWith('[vite-build-progress] '))
        .map(line => JSON.parse(line.slice('[vite-build-progress] '.length)));
      expect(rows.map(row => row.phase)).toEqual([
        'build-start', 'build-end', 'render-start', 'generate-end', 'close',
      ]);
      expect(rows.every(row => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
