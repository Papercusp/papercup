import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../../../scripts/tauri-surface-verify-dao-launch.sh');
function run(path: string, syntax = true) {
  const env = { ...process.env };
  delete env.VERIFY_TAURI_PID;
  delete env.VERIFY_TAURI_POLL;
  delete env.VERIFY_TAURI_LIVENESS_CHECK;
  delete env.VERIFY_TAURI_ISOLATED_DB;
  try {
    return execFileSync('bash', [path, ...(syntax ? ['--check-syntax'] : [])], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status, stderr: String(failure.stderr ?? '') };
  }
}

describe('maintained DAO native assertion syntax preflight', () => {
  it('parses every real eval/poll expression for both legal routes and themes without a native runtime', () => {
    const result = run(script);
    expect(result).toEqual(expect.stringContaining('DAO_SURFACE_SYNTAX_ONLY'));
    expect(result).not.toEqual(expect.stringContaining('P009_TAURI_SURFACE_VERIFY_OK'));
  });

  it('catches the escaped-quote defect before a desktop boot', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dao-surface-syntax-'));
    try {
      const path = resolve(dir, 'broken.sh');
      const source = readFileSync(script, 'utf8');
      const original = 'native eval \'window.__TSR_ROUTER__.navigate';
      if (!source.includes(original)) throw new Error('Navigation expression not found');
      writeFileSync(path, source.replace(original, 'native eval \'const broken=\\"quoted\\";window.__TSR_ROUTER__.navigate'));
      expect(run(path)).toMatchObject({ status: 1, stderr: expect.stringContaining('SyntaxError') });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('continues to refuse a real run without its owned runtime and isolated database', () => {
    expect(run(script, false)).toMatchObject({ status: 1, stderr: expect.stringContaining('VERIFY_TAURI_PID') });
  });
});
