import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSpawnDetached, resolveResumeSpawnBin } from './wake-executor';
import { classifyResumeTurnExit, type ResumeTurnExitRaw } from './resume-turn-outcome';

/** Exact PATH values from the two systemd hosts that run wake-executor. */
const SERVICE_PATHS = [
  {
    service: 'papercup-dev-api',
    value: '/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/marsh-office/.cargo/bin:/home/marsh-office/.local/bin:/home/marsh-office/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },
  {
    service: 'papercup-bg-host',
    value: '/home/marsh-office/.cargo/bin:/home/linuxbrew/.linuxbrew/bin:/home/marsh-office/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },
] as const;

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

  it.each(SERVICE_PATHS)('$service resolves codex from the node prefix omitted by its service PATH', async ({ value }) => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resolve-codex-'));
    const nodeBin = join(root, 'node25', 'bin');
    const codexBin = join(nodeBin, 'codex');
    const previousExecPath = process.execPath;
    const previousPath = process.env.PATH;
    mkdirSync(nodeBin, { recursive: true });
    writeFileSync(
      codexBin,
      String.raw`#!/bin/sh
printf '%s\n' '{"type":"turn.completed"}'
`,
      { mode: 0o755 },
    );
    // The real services run node from ~/.local/node25/bin while their PATHs omit
    // that directory. Point the derived resolver at an equivalent staged prefix
    // so this test proves both service-PATH variants without relying on the host's
    // current symlinks or installed CLI version.
    process.execPath = join(nodeBin, 'node');
    process.env.PATH = value;
    try {
      expect(resolveResumeSpawnBin('codex')).toBe(codexBin);
      const exit = await new Promise<ResumeTurnExitRaw>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('resolved codex spawn did not exit')), 10_000);
        const pid = defaultSpawnDetached('codex', [], { cwd: root, env: { PATH: value } }, (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
        if (!pid) {
          clearTimeout(timer);
          reject(new Error('codex spawn returned no pid under service PATH'));
        }
      });
      expect(exit.exitCode).toBe(0);
      expect(exit.stdoutTail).toContain('turn.completed');
    } finally {
      process.execPath = previousExecPath;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
