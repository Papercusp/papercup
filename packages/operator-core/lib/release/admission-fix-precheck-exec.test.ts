import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHeadTailCapture,
  defaultExec,
  EXEC_OUTPUT_HEAD_CHARS,
  EXEC_OUTPUT_TAIL_CHARS,
  EXEC_STDIO_CLOSE_GRACE_MS,
} from './admission-fix-precheck';

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
  it.each(['stdout', 'stderr'] as const)('notifies on %s activity while the child is still running', async (stream) => {
    let notified!: () => void;
    const output = new Promise<void>((resolve) => { notified = resolve; });
    let finished = false;
    const pending = defaultExec(
      [process.execPath, '-e', `process.${stream}.write('setup progress'); setTimeout(() => {}, 200);`],
      { cwd: process.cwd(), timeoutMs: 5_000, onOutput: notified },
    ).then((result) => { finished = true; return result; });
    await output;
    expect(finished).toBe(false);
    expect(await pending).toMatchObject({ exitCode: 0, output: 'setup progress', timedOut: false });
  });

  it('does not emit output progress for a silent child or change the verdict when an observer throws', async () => {
    let notifications = 0;
    const silent = await defaultExec([process.execPath, '-e', ''], {
      cwd: process.cwd(), timeoutMs: 5_000, onOutput: () => { notifications += 1; },
    });
    expect(silent.exitCode).toBe(0);
    expect(notifications).toBe(0);
    const observed = await defaultExec([process.execPath, '-e', "console.log('progress'); process.exitCode = 3;"], {
      cwd: process.cwd(), timeoutMs: 5_000, onOutput: () => { throw new Error('observer unavailable'); },
    });
    expect(observed).toMatchObject({ exitCode: 3, timedOut: false });
    expect(observed.output).toContain('progress');
  });

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

// WI-10006014: the pre-check setup died on a 20-min wall-clock budget while still progressing,
// and its failure detail quoted the end of the first 256 KB instead of the real last lines.
describe('admission pre-check defaultExec output, idle watchdog and durable log (WI-10006014)', () => {
  it('keeps the REAL tail past the capture cap, so output.slice(-600) is the last thing printed', async () => {
    // ~400 KB of filler (well past head+tail = 256 KB), then a final marker line.
    const r = await defaultExec(
      ['bash', '-c', 'for i in $(seq 1 8000); do printf "filler-line-%05d-xxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n" $i; done; echo LAST-LINE-MARKER'],
      { cwd: process.cwd(), timeoutMs: 20_000 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output.slice(-600)).toContain('LAST-LINE-MARKER');
    expect(r.output).toContain('filler-line-00001'); // the head is kept too
    expect(r.output).toMatch(/chars elided/);
    expect(r.output.length).toBeLessThan(EXEC_OUTPUT_HEAD_CHARS + EXEC_OUTPUT_TAIL_CHARS + 200);
  }, 15_000);

  it('the idle watchdog kills a child that stops printing, and says so', async () => {
    const r = await defaultExec(['bash', '-c', 'echo started; sleep 30'], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
      // idle-window-ok: this case WANTS the idle window to fire; a slow child boot only makes it fire sooner.
      idleTimeoutMs: 500,
    });
    expect(r.timedOut).toBe(true);
    expect(r.idleTimedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(EXEC_STDIO_CLOSE_GRACE_MS + 6_000);
  }, 15_000);

  it('a child that keeps printing outlives the idle window (progress resets it)', async () => {
    // 12 lines 250 ms apart = ~3 s total, well past the idle window. The window is at the
    // 1000 ms floor (lint:test-timing-budgets): the idle clock is armed at spawn, so a slow
    // child boot under gate load must not be charged against a shorter first window.
    const PROGRESS_IDLE_WINDOW_MS = 1_000;
    const r = await defaultExec(['bash', '-c', 'for i in $(seq 1 12); do echo tick-$i; sleep 0.25; done'], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
      idleTimeoutMs: PROGRESS_IDLE_WINDOW_MS,
    });
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.durationMs).toBeGreaterThan(PROGRESS_IDLE_WINDOW_MS); // it really outlived one window
    expect(r.idleTimedOut).toBeUndefined();
    expect(r.output).toContain('tick-8');
  }, 15_000);

  it('appends the full output and an exit trailer to the durable log', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'precheck-exec-log-'));
    try {
      const logFile = path.join(dir, 'nested', 'run.log');
      const r = await defaultExec(['bash', '-c', 'echo to-stdout; echo to-stderr >&2; exit 4'], {
        cwd: process.cwd(),
        timeoutMs: 10_000,
        logFile,
      });
      expect(r.exitCode).toBe(4);
      await new Promise((res) => setTimeout(res, 100)); // let the stream flush its end()
      const text = readFileSync(logFile, 'utf8');
      expect(text).toContain('to-stdout');
      expect(text).toContain('to-stderr');
      expect(text).toMatch(/\[admission-precheck-exec\] exit=4 /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createHeadTailCapture: short output is returned whole; long output keeps head and tail', () => {
    const short = createHeadTailCapture(10, 20);
    short.push('abc');
    short.push('def');
    expect(short.text()).toBe('abcdef');

    const long = createHeadTailCapture(5, 10);
    for (let i = 0; i < 100; i += 1) long.push(`<${i}>`);
    const t = long.text();
    expect(t.startsWith('<0><1')).toBe(true);
    expect(t.endsWith('<98><99>')).toBe(true);
    expect(t).toMatch(/chars elided/);
  });
});
