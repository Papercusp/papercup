import { describe, expect, it } from 'vitest';
import { defaultExec, EXEC_STDIO_CLOSE_GRACE_MS } from './admission-fix-precheck';

/** Is a pid still alive (signal 0 probe)? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// WI-10004928 part 5: a grandchild that inherited stdout (a dependency-generation `cp`) kept
// 'close' from firing, so the pre-check held its single slot far past the setup budget.
describe('admission pre-check defaultExec subtree handling', () => {
  it('resolves on the direct child exit when a backgrounded grandchild still holds stdout, and kills it', async () => {
    const r = await defaultExec(
      ['bash', '-c', '( sleep 30 & echo $! ) ; echo done'],
      { cwd: process.cwd(), timeoutMs: 20_000 },
    );
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeLessThan(EXEC_STDIO_CLOSE_GRACE_MS + 5_000);
    const holder = Number(r.output.split('\n')[0]);
    expect(Number.isInteger(holder) && holder > 0).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(holder)).toBe(false);
  }, 15_000);

  it('a timeout kills the whole process group, not just the direct child', async () => {
    const r = await defaultExec(
      ['bash', '-c', 'sleep 30 & echo $!; wait'],
      { cwd: process.cwd(), timeoutMs: 500 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(EXEC_STDIO_CLOSE_GRACE_MS + 5_000);
    const grandchild = Number(r.output.split('\n')[0]);
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(grandchild)).toBe(false);
  }, 15_000);

  it('calibration: an ordinary command still resolves with its exit code and output', async () => {
    const r = await defaultExec(['bash', '-c', 'echo hi; exit 3'], { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(r.output).toContain('hi');
  });
});
