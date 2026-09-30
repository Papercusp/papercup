import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PUI_EXIT_REAP_MARGIN_MS, PUI_MAIN_RS, puiQuitBounds, rustDurationConstMs } from './pui-quit-bounds';

describe('pui quit bounds (WI-10004247 run 8b teardown race)', () => {
  test('reads the real SIGNAL_QUIT_DEADLINE from pui main.rs', () => {
    const source = readFileSync(PUI_MAIN_RS, 'utf8');
    // Positive control: the constant is really declared there, so a parse
    // failure cannot be mistaken for a missing file.
    expect(source).toMatch(/const SIGNAL_QUIT_DEADLINE: Duration/);
    const bounds = puiQuitBounds(source);
    expect(bounds.signalQuitDeadlineMs).toBeGreaterThan(0);
    expect(bounds.signalQuitDeadlineMs).toBe(rustDurationConstMs(source, 'SIGNAL_QUIT_DEADLINE'));
  });

  test('the after-kill wait is strictly longer than pui\'s own deadline', () => {
    const bounds = puiQuitBounds();
    expect(bounds.afterKillWaitMs).toBeGreaterThan(bounds.signalQuitDeadlineMs);
    expect(bounds.afterKillWaitMs - bounds.signalQuitDeadlineMs).toBe(PUI_EXIT_REAP_MARGIN_MS);
  });

  test('parses seconds and milliseconds and refuses anything else', () => {
    expect(rustDurationConstMs('const A: Duration = Duration::from_secs(5);', 'A')).toBe(5_000);
    expect(rustDurationConstMs('const B: Duration = Duration::from_millis(250);', 'B')).toBe(250);
    expect(() => rustDurationConstMs('const C: u64 = 5;', 'C')).toThrow(/not a Duration/);
    expect(() => rustDurationConstMs('const A: Duration = Duration::from_secs(5);', 'MISSING')).toThrow();
  });

  test('a harness that waits exactly the deadline is the tie this guards against', () => {
    const tied = { signalQuitDeadlineMs: 5_000, afterKillWaitMs: 5_000 };
    expect(tied.afterKillWaitMs > tied.signalQuitDeadlineMs).toBe(false);
    const derived = puiQuitBounds('const SIGNAL_QUIT_DEADLINE: Duration = Duration::from_secs(5);');
    expect(derived.afterKillWaitMs > derived.signalQuitDeadlineMs).toBe(true);
  });
});
