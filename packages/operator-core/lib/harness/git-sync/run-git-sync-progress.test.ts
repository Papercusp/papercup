import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ script: '', output: '', onOutput: () => {}, child: null as ChildProcess | null }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { createTextCollector } = await import('../../child-output');
  return {
    ...actual,
    // Exercise the real local runner and OS pipes without contacting a remote.
    spawn: (_command: string, _args: string[], options: SpawnOptions) => {
      // The fetch guard resolves its write filesystem before running the timed
      // fixture. That read is independent of the fake transfer's output stream.
      if (_args.includes('--git-path')) {
        return actual.spawn(process.execPath, ['-e', "process.stdout.write(require('node:os').tmpdir())"], options);
      }
      const child = actual.spawn(process.execPath, ['-e', fixture.script], options);
      fixture.child = child;
      const output = createTextCollector(child.stderr);
      child.stderr?.on('data', () => { fixture.output = output.peek(); fixture.onOutput(); });
      return child;
    },
  };
});
vi.mock('../../fleet/git-via-sidecar', () => ({ gitSidecarEnabled: () => false }));

import { runGitBounded } from './run-git-sync';

beforeEach(() => { fixture.onOutput = () => {}; fixture.child = null; fixture.output = ''; });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('local Git cancellation lifetime', () => {
  it.skipIf(process.platform === 'win32')('preserves a silent external termination signal in the Git result', async () => {
    fixture.script = "process.kill(process.pid, 'SIGTERM');";
    const result = await runGitBounded(['diff'], tmpdir(), 5000);
    expect(result).toMatchObject({ code: -1, stdout: '' });
    expect(result.stderr).toContain('git terminated by signal SIGTERM');
  });

  it('does not spawn when cancellation precedes the command', async () => {
    fixture.script = "process.stderr.write('should not run');";
    const controller = new AbortController();
    controller.abort();
    const result = await runGitBounded(['commit'], tmpdir(), 5000, { signal: controller.signal });
    expect(result.code).toBe(-1);
    expect(fixture.child).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('waits for an ignored-stdio helper and cancels the whole command group', async () => {
    const helper = "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);";
    fixture.script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio:['ignore','ignore','ignore','ipc']}); child.on('message', pid => { process.stderr.write(String(pid)); child.disconnect(); }); setInterval(() => {}, 1000);`;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    fixture.onOutput = ready;
    const controller = new AbortController();
    const result = runGitBounded(['commit'], tmpdir(), 30_000, { signal: controller.signal });
    let helperPid = 0;
    try {
      await started;
      const parent = fixture.child!;
      helperPid = Number(fixture.output);
      expect(helperPid).toBeGreaterThan(0);
      expect(alive(helperPid)).toBe(true);
      controller.abort();
      const returned = await result;
      expect(returned.code).toBe(-1);
      expect(alive(parent.pid!)).toBe(false);
      expect(alive(helperPid)).toBe(false);
    } finally {
      controller.abort();
      if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL');
      await result;
      if (helperPid) await vi.waitFor(() => expect(alive(helperPid)).toBe(false));
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('keeps successful parent completion pending until its helper exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-git-helper-'));
    const release = join(dir, 'release');
    const helper = `process.send(process.pid); setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 5);`;
    fixture.script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio:['ignore','ignore','ignore','ipc']}); child.on('message', pid => { process.stderr.write(String(pid)); child.disconnect(); process.exit(0); });`;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    fixture.onOutput = ready;
    let settled = false;
    const result = runGitBounded(['commit'], tmpdir(), 5000).then((value) => { settled = true; return value; });
    let helperPid = 0;
    try {
      await started;
      helperPid = Number(fixture.output);
      await vi.waitFor(() => expect(alive(fixture.child!.pid!)).toBe(false));
      expect(alive(helperPid)).toBe(true);
      expect(settled).toBe(false);
      await writeFile(release, 'done');
      expect((await result).code).toBe(0);
      expect(alive(helperPid)).toBe(false);
    } finally {
      await writeFile(release, 'done');
      if (helperPid && alive(helperPid)) process.kill(helperPid, 'SIGKILL');
      await result;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('local Git output-idle guard', () => {
  it('reads queued child progress before expiring an idle timer after a parent-loop stall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-git-progress-'));
    const release = join(dir, 'release');
    fixture.script = [
      "const send = phase => process.stderr.write(JSON.stringify({ phase, at: Date.now() }) + '\\n');",
      // End only after the parent has read the progress written during its stall.
      // A fixed burst also tests an unrelated silent interval before child exit.
      `send('ready'); const timer = setInterval(() => { send('progress'); if (require('node:fs').existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.stderr.write(JSON.stringify({ phase: 'ack', at: Date.now() }) + '\\n', () => process.exit(0)); } }, 40);`,
    ].join(' ');
    let queued = false;
    let blockedFrom = 0;
    let blockedUntil = 0;
    fixture.onOutput = () => {
      if (queued) {
        if (blockedUntil === 0) return;
        const writes = fixture.output.split('\n').slice(0, -1).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
        if (writes.filter((entry) => entry.phase === 'progress' && entry.at > blockedFrom && entry.at < blockedUntil).length >= 3) {
          writeFileSync(release, 'done');
        }
        return;
      }
      queued = true;
      setImmediate(() => {
        blockedFrom = Date.now();
        while (Date.now() - blockedFrom < 450) { /* deliberately stall the CHECK phase */ }
        blockedUntil = Date.now();
      });
    };
    vi.stubEnv('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', '3000');
    const controller = new AbortController();
    const pending = runGitBounded(['fetch'], tmpdir(), 150, { signal: controller.signal });
    try {
      const result = await pending;
      const writes = result.stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
      expect(writes.filter((entry) => entry.phase === 'progress' && entry.at > blockedFrom && entry.at < blockedUntil).length).toBeGreaterThanOrEqual(3);
      expect(writes.some((entry) => entry.phase === 'ack')).toBe(true);
      expect(result.stderr).not.toContain('no output progress');
      expect(result.code, result.stderr).toBe(0);
    } finally {
      writeFileSync(release, 'done');
      controller.abort();
      await pending;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expires a resident child when a finite progress burst ends', async () => {
    fixture.script = "process.stderr.write('ready\\n'); let n = 0; const timer = setInterval(() => { process.stderr.write('progress\\n'); if (++n === 3) { clearInterval(timer); setInterval(() => {}, 1000); } }, 40);";
    vi.stubEnv('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', '3000');
    const result = await runGitBounded(['fetch'], tmpdir(), 150);
    expect(result.stderr.match(/progress\n/g)).toHaveLength(3);
    expect(result.stderr).toContain('made no output progress for 150ms');
    expect(result.stderr).not.toContain('hard ceiling');
    expect(result.code).toBe(-1);
  });

  it('still enforces the hard deadline despite continuous output', async () => {
    fixture.script = "process.stderr.write('ready\\n'); setInterval(() => process.stderr.write('progress\\n'), 20);";
    vi.stubEnv('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', '800');
    const result = await runGitBounded(['fetch'], tmpdir(), 500);
    expect(result.stderr).toContain('progress');
    expect(result.stderr).toContain('exceeded the 800ms hard ceiling despite output progress');
    expect(result.code).toBe(-1);
  });
});
