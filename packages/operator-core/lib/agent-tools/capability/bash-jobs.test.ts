/**
 * Unit tests for the bash capability core (P-010, B-05). Exercises the real
 * shell (no PG, no mocks): foreground run + output streaming, output-spill to a
 * log, wall-clock timeout, abort, and the background job lifecycle
 * (start → incremental read → completion / kill).
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_SANDBOX_TMPDIR,
  INLINE_OUTPUT_CAP,
  __resetBashJobs,
  getJob,
  killJob,
  readJobOutput,
  runForeground,
  startBackground,
} from './bash-jobs';

const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-'));
const never = new AbortController().signal;

afterEach(() => __resetBashJobs());

async function waitForStatus(id: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const j = getJob(id);
    if (j && j.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runForeground', () => {
  it('captures stdout + exit code and streams chunks', async () => {
    const chunks: string[] = [];
    const r = await runForeground(
      { command: 'echo hello-world', cwd: STATE, stateDir: STATE, onChunk: (c) => chunks.push(c) },
      never,
      10_000,
    );
    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hello-world');
    expect(chunks.join('')).toContain('hello-world');
  });

  it('captures stderr and a non-zero exit', async () => {
    const r = await runForeground(
      { command: 'echo oops >&2; exit 3', cwd: STATE, stateDir: STATE },
      never,
      10_000,
    );
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe('failed');
    expect(r.output).toContain('oops');
  });

  it('spills large output to a log file and trims the inline result', async () => {
    const r = await runForeground(
      { command: 'for i in $(seq 1 4000); do echo "line-$i padding padding padding padding"; done', cwd: STATE, stateDir: STATE },
      never,
      20_000,
    );
    expect(r.status).toBe('completed');
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(INLINE_OUTPUT_CAP + 200);
    expect(existsSync(r.logPath)).toBe(true);
    const full = readFileSync(r.logPath, 'utf8');
    expect(full.length).toBeGreaterThan(INLINE_OUTPUT_CAP);
    expect(full).toContain('line-4000');
  });

  it('enforces the wall-clock timeout', async () => {
    const r = await runForeground({ command: 'sleep 10', cwd: STATE, stateDir: STATE }, never, 300);
    expect(r.status).toBe('timed_out');
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await runForeground({ command: 'sleep 10', cwd: STATE, stateDir: STATE }, ac.signal, 30_000);
    expect(r.status).toBe('killed');
  });
});

describe('background jobs', () => {
  it('runs, exposes incremental output, and reaches a terminal status', async () => {
    const job = startBackground({ command: 'echo first; sleep 0.2; echo second', cwd: STATE, stateDir: STATE }, 10_000);
    expect(job.status).toBe('running');
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    const out = readJobOutput(final);
    expect(out).toContain('first');
    expect(out).toContain('second');
    // Cursor advanced — a second read returns nothing new.
    expect(readJobOutput(final)).toBe('');
  });

  it('kills a running job', async () => {
    const job = startBackground({ command: 'sleep 30', cwd: STATE, stateDir: STATE }, 60_000);
    expect(job.status).toBe('running');
    const r = killJob(job);
    expect(r.alreadyDone).toBe(false);
    expect(job.status).toBe('killed');
  });

  it('reports unknown ids as undefined', () => {
    expect(getJob('does-not-exist')).toBeUndefined();
  });
});

describe('TMPDIR is normalized to a sandbox-writable dir (EI-5912)', () => {
  it('overrides an inherited ephemeral TMPDIR so the child gets an existing temp dir', async () => {
    const prev = process.env.TMPDIR;
    // The ephemeral pattern the Claude harness sets — absent inside the fresh sandbox /tmp.
    process.env.TMPDIR = '/tmp/claude/nonexistent-run-xyz';
    try {
      const r = await runForeground(
        { command: 'printf "T=%s|X=%s|E=%s" "$TMPDIR" "$TMP" "$TEMP"', cwd: STATE, stateDir: STATE },
        never,
        10_000,
      );
      expect(r.output).toContain(`T=${CAPABILITY_SANDBOX_TMPDIR}`);
      expect(r.output).toContain(`X=${CAPABILITY_SANDBOX_TMPDIR}`);
      expect(r.output).toContain(`E=${CAPABILITY_SANDBOX_TMPDIR}`);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
  });

  it('a caller-supplied env.TMPDIR still wins (explicit override)', async () => {
    const r = await runForeground(
      { command: 'printf "%s" "$TMPDIR"', cwd: STATE, stateDir: STATE, env: { TMPDIR: STATE } },
      never,
      10_000,
    );
    expect(r.output).toContain(STATE);
  });
});

describe('process-group kill — no orphaned descendants (capability-bash-orphan-kill-2026-06-21)', () => {
  // A timed-out / aborted / killed command MUST take its descendants with it.
  // Before the detached-process-group fix, the kill hit only the `bash -c` parent;
  // its children (e.g. a runaway ugrep) orphaned to init and kept running at full
  // CPU — the 58-min search that starved the operator event loop → :3070 wedge.
  // Proof: a GRANDCHILD that would `touch` a marker AFTER the kill deadline must
  // never get the chance to create it.
  let markerSeq = 0;
  // `( sleep 3; touch <marker> ) &` is a subshell grandchild of the operator; the
  // outer `wait` keeps bash alive until the kill. With the group fix the grandchild
  // dies with the group; without it, it orphans, sleeps, and creates the marker.
  const grandchildCmd = (marker: string): string => `( sleep 3; touch ${marker} ) & echo started; wait`;
  async function expectNoOrphanMarker(run: (marker: string) => Promise<unknown>): Promise<void> {
    const marker = join(STATE, `orphan-${markerSeq++}.marker`);
    await run(marker);
    // Wait well past the grandchild's 3s delay; an orphan would have touched it.
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(marker)).toBe(false);
  }

  it('foreground timeout kills the grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const r = await runForeground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, never, 300);
      expect(r.status).toBe('timed_out');
    });
  }, 10_000);

  it('foreground abort kills the grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const r = await runForeground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, ac.signal, 30_000);
      expect(r.status).toBe('killed');
    });
  }, 10_000);

  it('killJob kills the background grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const job = startBackground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, 60_000);
      expect(job.status).toBe('running');
      killJob(job);
    });
  }, 10_000);
});
