import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The deterministic fake agent (fixtures/fake-agent.mjs) drives the gym smoke with
 * zero LLM spend. These assert the decision contract per role + that the worker makes
 * a real git commit (so the trace collector has a diff to capture).
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-agent.mjs');

function run(env: Record<string, string>): string {
  return execFileSync('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, EXTRAS_JSON: '["FEATURE_ID=F-GYM-AA"]', ...env },
  }).trim();
}

describe('fake-agent director', () => {
  it('sequences NEXT_WORKER → NEXT_VALIDATOR → DONE by turn', () => {
    expect(run({ ROLE: 'director', IDEMPOTENCY_KEY: 's:F:director:t0' })).toBe('NEXT_WORKER F-GYM-AA');
    expect(run({ ROLE: 'director', IDEMPOTENCY_KEY: 's:F:director:t1' })).toBe('NEXT_VALIDATOR F-GYM-AA');
    expect(run({ ROLE: 'director', IDEMPOTENCY_KEY: 's:F:director:t2' })).toBe('DONE');
  });
});

describe('fake-agent validator', () => {
  it('emits a PASS verdict', () => {
    expect(run({ ROLE: 'validator' })).toContain('[PASS]');
  });
});

describe('fake-agent worker', () => {
  it('makes a real git commit in PROJECT_DIR (a diff for the collector)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-fake-worker-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], { cwd: dir });
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      const out = run({ ROLE: 'worker', PROJECT_DIR: dir });
      expect(out).toContain('WORKER committed');

      const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      expect(after).not.toBe(before); // a new commit was made
      expect(existsSync(join(dir, 'GYM_FAKE_WORK_F-GYM-AA.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
