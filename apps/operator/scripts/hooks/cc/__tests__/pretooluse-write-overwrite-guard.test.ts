/**
 * pretooluse-write-overwrite-guard.mjs — advisory guard against
 * EI-19966323166806405 (Write silently overwrote a 350-line un-Read file,
 * clobbering another plan's module and crash-looping shared staging).
 *
 * Drives the hook exactly as Claude Code does — a PreToolUse JSON on stdin
 * (tool_name: 'Write', tool_input: {file_path, content}, cwd,
 * transcript_path, tool_use_id) — against real files on disk and a real
 * JSONL transcript fixture, then asserts:
 *   - it warns (additionalContext, exit 0 — NEVER a `deny`) exactly when the
 *     target already exists AND no prior Read/Edit/MultiEdit/Write of that
 *     same path appears in the transcript;
 *   - it stays silent (no stdout) for a brand-new file, a file the
 *     transcript shows was Read first, a non-Write tool, and a missing/
 *     unparseable transcript (fail-open) — the false-positive-noise floor
 *     this hook's advisory-only design depends on.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pretooluse-write-overwrite-guard.mjs');

function runHook(payload: unknown): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'write-overwrite-guard-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pretooluse-write-overwrite-guard.mjs', () => {
  it('warns when Write targets an existing file with no prior Read in the transcript', () =>
    withTmpDir((dir) => {
      const target = join(dir, 'existing-module.ts');
      writeFileSync(target, 'export const x = 1;\n'.repeat(20));
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(
        transcript,
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_unrelated', name: 'Read', input: { file_path: '/some/other/file.ts' } }],
          },
        }) + '\n',
      );

      const out = runHook({
        tool_name: 'Write',
        tool_input: { file_path: target, content: 'clobbered\n' },
        cwd: dir,
        transcript_path: transcript,
        tool_use_id: 'toolu_current',
      });

      expect(out.status).toBe(0);
      const parsed = JSON.parse(out.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined(); // advisory, never a deny
      expect(parsed.hookSpecificOutput.additionalContext).toContain('EI-19966323166806405');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('existing-module.ts');
    }));

  it('stays silent for a brand-new file (no collision to protect)', () =>
    withTmpDir((dir) => {
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(transcript, '');
      const out = runHook({
        tool_name: 'Write',
        tool_input: { file_path: join(dir, 'new-file.ts'), content: 'hi\n' },
        cwd: dir,
        transcript_path: transcript,
        tool_use_id: 'toolu_current',
      });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('');
    }));

  it('stays silent when the transcript shows a prior Read of the exact path', () =>
    withTmpDir((dir) => {
      const target = join(dir, 'existing-module.ts');
      writeFileSync(target, 'export const x = 1;\n'.repeat(20));
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(
        transcript,
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: target } }],
          },
        }) + '\n',
      );

      const out = runHook({
        tool_name: 'Write',
        tool_input: { file_path: target, content: 'intentional rewrite\n' },
        cwd: dir,
        transcript_path: transcript,
        tool_use_id: 'toolu_current',
      });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('');
    }));

  it('stays silent when the transcript shows a prior Edit of the exact path', () =>
    withTmpDir((dir) => {
      const target = join(dir, 'existing-module.ts');
      writeFileSync(target, 'export const x = 1;\n'.repeat(20));
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(
        transcript,
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: { file_path: target } }],
          },
        }) + '\n',
      );

      const out = runHook({
        tool_name: 'Write',
        tool_input: { file_path: target, content: 'full rewrite after an edit\n' },
        cwd: dir,
        transcript_path: transcript,
        tool_use_id: 'toolu_current',
      });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('');
    }));

  it('ignores non-Write tools entirely', () =>
    withTmpDir((dir) => {
      const target = join(dir, 'existing-module.ts');
      writeFileSync(target, 'export const x = 1;\n');
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(transcript, '');
      const out = runHook({ tool_name: 'Edit', tool_input: { file_path: target }, cwd: dir, transcript_path: transcript });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('');
    }));

  it('fails open (silent) when the transcript path is missing', () =>
    withTmpDir((dir) => {
      const target = join(dir, 'existing-module.ts');
      writeFileSync(target, 'export const x = 1;\n'.repeat(20));
      const out = runHook({
        tool_name: 'Write',
        tool_input: { file_path: target, content: 'x' },
        cwd: dir,
        transcript_path: join(dir, 'does-not-exist.jsonl'),
      });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('');
    }));

  it('fails open (silent) on malformed stdin JSON', () => {
    const out = runHook('{ not valid json');
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });

  it('never denies — the advisory contract has no permissionDecision:"deny" path', () =>
    withTmpDir((dir) => {
      const target = join(dir, 'existing-module.ts');
      writeFileSync(target, 'export const x = 1;\n'.repeat(20));
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(transcript, '');
      const out = runHook({
        tool_name: 'Write',
        tool_input: { file_path: target, content: 'clobbered\n' },
        cwd: dir,
        transcript_path: transcript,
        tool_use_id: 'toolu_current',
      });
      expect(out.status).toBe(0);
      expect(out.stdout).not.toContain('"deny"');
    }));

  it('embedded --self-test passes', () => {
    const r = spawnSync('node', [SCRIPT, '--self-test'], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(0);
  });
});
