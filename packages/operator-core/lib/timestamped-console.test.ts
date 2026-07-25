/**
 * Coverage for timestamped-console (WI-5778 / P-422): the prefix format
 * and the idempotent, additive install onto console.*.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTimestampedConsole, timestampPrefix } from './timestamped-console';

describe('timestampPrefix', () => {
  it('formats as bracketed ISO-8601 with millisecond precision', () => {
    const d = new Date('2026-07-25T21:30:00.123Z');
    expect(timestampPrefix(d)).toBe('[2026-07-25T21:30:00.123Z]');
  });

  it('defaults to now when no date is passed', () => {
    const before = Date.now();
    const prefix = timestampPrefix();
    const after = Date.now();
    const parsed = Date.parse(prefix.slice(1, -1));
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe('installTimestampedConsole', () => {
  afterEach(() => {
    // Fully restore global console + clear the install flag so the wrap
    // never leaks to other test files sharing this worker (mirrors
    // installConsoleInterceptor's test in ./log-events.test.ts).
    delete (console as unknown as Record<symbol, unknown>)[
      Symbol.for('papercusp.timestampedConsole.installed')
    ];
  });

  it('prepends a timestamp to console.log/.warn/.error/.info/.debug calls', () => {
    const orig = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };
    try {
      const spy = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      console.log = spy.log;
      console.warn = spy.warn;
      console.error = spy.error;
      console.info = spy.info;
      console.debug = spy.debug;

      installTimestampedConsole();
      console.log('hello', 1);
      console.warn('careful');
      console.error('boom', { a: 1 });
      console.info('fyi');
      console.debug('trace-ish');

      for (const fn of Object.values(spy)) {
        expect(fn).toHaveBeenCalledTimes(1);
        const [prefix] = fn.mock.calls[0] as unknown[];
        expect(typeof prefix).toBe('string');
        expect(prefix as string).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]$/);
      }
      expect(spy.log.mock.calls[0].slice(1)).toEqual(['hello', 1]);
      expect(spy.error.mock.calls[0].slice(1)).toEqual(['boom', { a: 1 }]);
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
      console.info = orig.info;
      console.debug = orig.debug;
    }
  });

  it('is idempotent — a second install does not double-prefix', () => {
    const orig = console.log;
    try {
      const spy = vi.fn();
      console.log = spy;
      installTimestampedConsole();
      installTimestampedConsole();
      console.log('once');
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0] as unknown[];
      // exactly one timestamp arg + the original args, not two.
      expect(args).toHaveLength(2);
      expect(args[1]).toBe('once');
    } finally {
      console.log = orig;
    }
  });

  it('composes with whatever is already on console.* (wraps, does not replace)', () => {
    const orig = console.log;
    try {
      const inner = vi.fn();
      console.log = inner;
      installTimestampedConsole();
      console.log('via-existing-wrapper');
      expect(inner).toHaveBeenCalledTimes(1);
    } finally {
      console.log = orig;
    }
  });
});
