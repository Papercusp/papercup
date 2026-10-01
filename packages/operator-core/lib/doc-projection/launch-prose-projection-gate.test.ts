import { describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// ⚠ ONE LINE, deliberately. `@ts-expect-error` suppresses the NEXT LINE only, and on a
// multi-line import the TS7016 lands on the module-specifier line at the bottom — so the
// directive goes unused (TS2578) AND the real error still fires (EI-19389216343173748).
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import { rollBackWrittenFiles, runLaunchProseProjectionGate } from '../../../../scripts/project-doc-parts.mjs';

/**
 * WI-10004682 — project-doc-parts' post-write launch-prose gate.
 *
 * The lint ceilings are measured on the WRITTEN files, so the gate runs after the write and
 * an OVER reading rolls the write back. Two properties carry the whole feature and each is
 * checked in BOTH directions below:
 *
 *   1. the exit-status → verdict mapping — above all that a FAILED instrument (exit 2, spawn
 *      error, signal) is 'unchecked' and never 'ok'. A gate that reads "could not measure" as
 *      "within budget" is exactly the false green this change exists to remove.
 *   2. rollback restores the prior state exactly: bytes, a retired symlink, or absence.
 *
 * NOTHING HERE touches the real tree or runs the real lint — the spawner is injected and the
 * files live in a fresh tmp dir.
 */

describe('runLaunchProseProjectionGate — exit status → verdict', () => {
  const run = (res: Record<string, unknown>) => {
    const spawn = vi.fn(() => res);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const verdict = runLaunchProseProjectionGate({ spawn, root: '/nonexistent' });
      // Read the messages BEFORE mockRestore() — restoring clears the recorded calls.
      return { verdict, spawn, stderr: err.mock.calls.map((c) => String(c[0])).join('\n') };
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  };

  it('exit 0 is ok', () => {
    expect(run({ status: 0 }).verdict).toBe('ok');
  });

  it('exit 1 is over — the only verdict that rolls a projection back', () => {
    expect(run({ status: 1 }).verdict).toBe('over');
  });

  it('exit 2 (instrument failed) is unchecked, never ok', () => {
    expect(run({ status: 2 }).verdict).toBe('unchecked');
  });

  it('a spawn error / timeout / signal (no numeric status) is unchecked, never ok', () => {
    expect(run({ status: null, error: new Error('ETIMEDOUT') }).verdict).toBe('unchecked');
    expect(run({ status: null, signal: 'SIGKILL' }).verdict).toBe('unchecked');
  });

  it('runs the --projection-gate mode of the existing lint, with inherited stdio (no second measurement)', () => {
    const { spawn } = run({ status: 0 });
    const [, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], { stdio: string; cwd: string }];
    expect(args).toEqual(['--import', 'tsx', 'scripts/check-launch-prose-budget.ts', '--projection-gate']);
    expect(opts.stdio).toBe('inherit');
    expect(opts.cwd).toBe('/nonexistent');
  });

  it('names the instrument failure loudly when unchecked', () => {
    expect(run({ status: 2 }).stderr).toContain('NOT checked');
    // ...and an OK / OVER reading must not print the instrument-failure warning.
    expect(run({ status: 0 }).stderr).not.toContain('NOT checked');
  });
});

describe('rollBackWrittenFiles — restores the prior state exactly', () => {
  const withTmp = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'prose-gate-rollback-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('puts a regular file back to its prior bytes', () => {
    withTmp((dir) => {
      const path = join(dir, 'CLAUDE.md');
      writeFileSync(path, 'NEW BIGGER TEXT', 'utf8');
      rollBackWrittenFiles([{ path, file: 'CLAUDE.md', prevText: 'old', prevSymlinkTarget: null }]);
      expect(readFileSync(path, 'utf8')).toBe('old');
    });
  });

  it('re-creates a symlink the write retired', () => {
    withTmp((dir) => {
      const path = join(dir, 'AGENTS.md');
      writeFileSync(join(dir, 'CLAUDE.md'), 'target', 'utf8');
      writeFileSync(path, 'written over the retired symlink', 'utf8');
      rollBackWrittenFiles([{ path, file: 'AGENTS.md', prevText: null, prevSymlinkTarget: 'CLAUDE.md' }]);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path)).toBe('CLAUDE.md');
    });
  });

  it('removes a file that did not exist before the write', () => {
    withTmp((dir) => {
      const path = join(dir, 'AGENTS.md');
      writeFileSync(path, 'brand new', 'utf8');
      rollBackWrittenFiles([{ path, file: 'AGENTS.md', prevText: null, prevSymlinkTarget: null }]);
      expect(() => lstatSync(path)).toThrow();
    });
  });

  it('is idempotent when the file is already gone, and still restores the rest', () => {
    withTmp((dir) => {
      const gone = join(dir, 'gone.md');
      const kept = join(dir, 'kept.md');
      writeFileSync(kept, 'changed', 'utf8');
      rollBackWrittenFiles([
        { path: gone, file: 'gone.md', prevText: null, prevSymlinkTarget: null },
        { path: kept, file: 'kept.md', prevText: 'orig', prevSymlinkTarget: null },
      ]);
      expect(readFileSync(kept, 'utf8')).toBe('orig');
    });
  });
});
