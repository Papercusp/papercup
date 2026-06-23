import { describe, it, expect } from 'vitest';
import { defaultSpawnDetached } from './wake-executor';
import { classifyResumeTurnExit, type ResumeTurnExitRaw } from './resume-turn-outcome';

/**
 * P0a deadlock-safety + end-to-end exit observation against a REAL subprocess.
 *
 * The dangerous part of capturing a detached turn's output is pipe backpressure: an
 * undrained stdout pipe DEADLOCKS the child once the OS buffer (~64KB) fills — which
 * would freeze EVERY resume turn fleet-wide, far worse than the bug being fixed. These
 * tests spawn a real `node -e` child that writes a quarter-megabyte before exiting, so
 * a draining bug surfaces as a hang (test timeout), not a silent pass.
 */
describe('defaultSpawnDetached — real-subprocess exit observation (P0a integration)', () => {
  const run = (script: string, timeoutMs = 10_000) =>
    new Promise<ResumeTurnExitRaw>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('onExit never fired — possible pipe-backpressure deadlock')), timeoutMs);
      const pid = defaultSpawnDetached(process.execPath, ['-e', script], { cwd: process.cwd(), env: {} }, (exit) => {
        clearTimeout(t);
        resolve(exit);
      });
      expect(pid).toBeGreaterThan(0); // delivered on spawn, before the turn finishes
    });

  it('observes a 429 DEATH after a >250KB stdout flood (no backpressure deadlock) and classifies rate_limited', async () => {
    const script =
      "process.stdout.write('x'.repeat(250000) + '\\nAPI Error: 429 Too Many Requests \\u00b7 Rate limited\\n', () => process.exit(1));";
    const exit = await run(script);
    expect(exit.exitCode).toBe(1);
    // Only the bounded tail is retained — but the error line (written last) is in it.
    expect(exit.stdoutTail).toContain('Rate limited');
    expect(exit.stdoutTail.length).toBeLessThanOrEqual(8192 + 16);
    const outcome = classifyResumeTurnExit(exit);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.class).toBe('rate_limited');
  });

  it('observes a CLEAN exit (0) after a large stdout as a SURVIVED turn', async () => {
    const script = "process.stdout.write('y'.repeat(120000), () => process.exit(0));";
    const exit = await run(script);
    expect(exit.exitCode).toBe(0);
    expect(classifyResumeTurnExit(exit).ok).toBe(true);
  });

  it('observes a signal kill as a death', async () => {
    // The child sends itself SIGKILL.
    const script = "process.kill(process.pid, 'SIGKILL');";
    const exit = await run(script);
    expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    expect(classifyResumeTurnExit(exit).ok).toBe(false);
  });
});
