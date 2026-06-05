/**
 * Coverage for log-events: the JSONL path helper, best-effort append
 * (async + sync), util.format-style console arg formatting, the
 * AsyncLocalStorage plugin-exec context (preserved across awaits), and the
 * idempotent console interceptor that attributes in-scope console.* to the
 * plugin's run.log.jsonl. The interceptor test fully restores global console.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  jsonlPathForStateDir,
  appendLogEvent,
  appendLogEventSync,
  formatConsoleArgs,
  runWithPluginExecCtx,
  currentPluginExecCtx,
  installConsoleInterceptor,
  type LogEvent,
} from './log-events';

const tmp = mkdtempSync(join(tmpdir(), 'logev-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const evt = (over: Partial<LogEvent> = {}): LogEvent => ({
  ts: '2026-05-31T00:00:00.000Z',
  source: 'harness',
  level: 'info',
  msg: 'hello',
  ...over,
});
const readLines = (p: string) => readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);

describe('jsonlPathForStateDir', () => {
  it('joins logs/run.log.jsonl under the state dir', () => {
    expect(jsonlPathForStateDir('/proj/.papercusp')).toBe('/proj/.papercusp/logs/run.log.jsonl');
  });
});

describe('appendLogEvent (async)', () => {
  it('creates the dir + appends one JSON line per call', async () => {
    const p = join(tmp, 'a', 'logs', 'run.log.jsonl');
    await appendLogEvent(p, evt({ msg: 'one' }));
    await appendLogEvent(p, evt({ msg: 'two' }));
    const lines = readLines(p);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).msg).toBe('one');
    expect(JSON.parse(lines[1]).msg).toBe('two');
  });

  it('swallows a serialization failure (best-effort)', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const p = join(tmp, 'circ', 'run.log.jsonl');
    await expect(appendLogEvent(p, circular as unknown as LogEvent)).resolves.toBeUndefined();
    expect(existsSync(p)).toBe(false);
  });
});

describe('appendLogEventSync', () => {
  it('creates the dir + appends synchronously', () => {
    const p = join(tmp, 'sync', 'logs', 'run.log.jsonl');
    appendLogEventSync(p, evt({ msg: 'sync-line' }));
    expect(JSON.parse(readLines(p)[0]).msg).toBe('sync-line');
  });
});

describe('formatConsoleArgs', () => {
  it('joins primitives with spaces', () => {
    expect(formatConsoleArgs(['a', 42, true])).toBe('a 42 true');
  });
  it('inspects objects', () => {
    const out = formatConsoleArgs([{ a: 1 }, 'tail']);
    expect(out).toContain('a: 1');
    expect(out).toContain('tail');
  });
});

describe('plugin-exec context (AsyncLocalStorage)', () => {
  it('is undefined outside a run scope', () => {
    expect(currentPluginExecCtx()).toBeUndefined();
  });

  it('is visible inside the scope and survives an await', async () => {
    const ctx = { pluginSlug: 'p', harnessSlug: 'h', jsonlPath: '/x' };
    const seen = await runWithPluginExecCtx(ctx, async () => {
      await Promise.resolve();
      return currentPluginExecCtx();
    });
    expect(seen).toBe(ctx);
    expect(currentPluginExecCtx()).toBeUndefined(); // restored after
  });
});

describe('installConsoleInterceptor', () => {
  afterEach(() => {
    // Fully restore global console + clear the install flag so the wrap
    // never leaks to other test files sharing this worker.
    /* eslint-disable no-console */
    // (console methods are restored inside the test's finally below.)
    delete (console as unknown as Record<symbol, unknown>)[Symbol.for('papercusp.console.intercepted')];
  });

  it('attributes in-scope console.log to the plugin jsonl, passes through outside', () => {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const p = join(tmp, 'intercept', 'logs', 'run.log.jsonl');
    try {
      installConsoleInterceptor();
      runWithPluginExecCtx({ pluginSlug: 'cool', harnessSlug: 'h', jsonlPath: p, corrId: 'c1' }, () => {
        console.log('inside', { n: 1 });
      });
      console.log('outside'); // no exec ctx → just passes through, no extra line
      const lines = readLines(p);
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]);
      expect(row).toMatchObject({ source: 'plugin:cool', level: 'info', corrId: 'c1' });
      expect(row.msg).toContain('inside');
      expect(row.msg).toContain('n: 1');
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
  });

  it('is idempotent (second install is a no-op)', () => {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    try {
      installConsoleInterceptor();
      const afterFirst = console.log;
      installConsoleInterceptor();
      expect(console.log).toBe(afterFirst); // not re-wrapped
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
  });
});
