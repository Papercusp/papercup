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
