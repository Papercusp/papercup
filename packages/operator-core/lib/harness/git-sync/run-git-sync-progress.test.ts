import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ script: '', onOutput: () => {} }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Exercise the real local runner and OS pipes without contacting a remote.
    spawn: (_command: string, _args: string[], options: SpawnOptions) => {
      const child = actual.spawn(process.execPath, ['-e', fixture.script], options);
      child.stderr?.on('data', () => fixture.onOutput());
      return child;
    },
  };
});
vi.mock('../../fleet/git-via-sidecar', () => ({ gitSidecarEnabled: () => false }));

import { runGitBounded } from './run-git-sync';

beforeEach(() => { fixture.onOutput = () => {}; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('local Git output-idle guard', () => {
  it('reads queued child progress before expiring an idle timer after a parent-loop stall', async () => {
    fixture.script = [
      "const send = phase => process.stderr.write(JSON.stringify({ phase, at: Date.now() }) + '\\n');",
      "send('ready'); let n = 0; const timer = setInterval(() => { send('progress'); if (++n === 10) clearInterval(timer); }, 40);",
    ].join(' ');
    let queued = false;
    let blockedFrom = 0;
    let blockedUntil = 0;
    fixture.onOutput = () => {
      if (queued) return;
      queued = true;
      setImmediate(() => {
        blockedFrom = Date.now();
        while (Date.now() - blockedFrom < 450) { /* deliberately stall the CHECK phase */ }
        blockedUntil = Date.now();
      });
    };
    vi.stubEnv('PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS', '3000');
    const result = await runGitBounded(['fetch'], tmpdir(), 150);
    const writes = result.stderr.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    expect(writes.filter((entry) => entry.phase === 'progress' && entry.at > blockedFrom && entry.at < blockedUntil).length).toBeGreaterThanOrEqual(3);
    expect(result.stderr).not.toContain('no output progress');
    expect(result.code, result.stderr).toBe(0);
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
