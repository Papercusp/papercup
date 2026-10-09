import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createResumeSmokeProfile, resumeSmokeChildEnv, verifyResumeSmokeContinuation,
  retainResumeSmokeWitness, resumeSmokeExitCode }
  from '../../../../../apps/operator/scripts/resume-spawn-live';

describe('maintained real-client resume smoke isolation', () => {
  it.each(['claude', 'codex', 'omp'] as const)('%s copies private auth and excludes user settings/hooks', (agent) => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'resume-smoke-auth-control-'));
    const relative = agent === 'claude' ? ['.claude', '.credentials.json']
      : agent === 'codex' ? ['.codex', 'auth.json'] : ['.omp', 'agent', 'auth.json'];
    const source = join(sourceHome, ...relative);
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, '{"fixture":"auth-before"}');
    writeFileSync(join(source, '..', 'settings.json'), '{"hooks":"must-not-load"}');
    const profile = createResumeSmokeProfile(agent, sourceHome);
    try {
      const copied = join(profile.home, ...relative);
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(lstatSync(copied).mode & 0o777).toBe(0o600);
      expect(lstatSync(profile.home).mode & 0o777).toBe(0o700);
      expect(readFileSync(copied, 'utf8')).toBe(readFileSync(source, 'utf8'));
      writeFileSync(copied, '{"fixture":"auth-refreshed"}');
      expect(readFileSync(source, 'utf8')).toBe('{"fixture":"auth-before"}');
      expect(() => readFileSync(join(profile.clientHome, 'settings.json'))).toThrow();
      if (agent === 'claude') {
        writeFileSync(join(profile.clientHome, '.credentials.json'), '{"fixture":"client-refresh"}');
        expect(readFileSync(source, 'utf8')).toBe('{"fixture":"auth-before"}');
      }
    } finally {
      profile.cleanup();
      rmSync(sourceHome, { recursive: true, force: true });
    }
  });

  it('does not leak the parent identity, control plane, or native homes into an acceptance child', () => {
    const parent = { PAPERCUSP_SID: 'parent-owner', PAPERCUSP_HARNESS_SLUG: 'parent-harness',
      PAPERCUSP_API_BEARER: 'fixture-parent-bearer', CODEX_HOME: '/parent-codex',
      CLAUDE_CONFIG_DIR: '/parent-claude', PI_CODING_AGENT_DIR: '/parent-omp', PATH: '/safe-bin' };
    const env = resumeSmokeChildEnv(parent, '/fixture-home', { CODEX_HOME: '/fixture-codex', PAPERCUSP_TURN_PROVENANCE_DIR: '/fixture-provenance' });
    expect(env).toMatchObject({ HOME: '/fixture-home', CODEX_HOME: '/fixture-codex', PAPERCUSP_SID: '', PATH: '/safe-bin' });
    expect(env.PAPERCUSP_HARNESS_SLUG).toBeUndefined();
    expect(env.PAPERCUSP_API_BEARER).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(parent.PAPERCUSP_SID).toBe('parent-owner');
  });

  it('requires an existing exact transcript prefix and a new wake record', () => {
    const before = '{"session":"exact"}\n{"text":"launch"}\n';
    const after = before + '{"text":"coord:send wake-rung ping"}\n';
    expect(verifyResumeSmokeContinuation(before, after, 'coord:send wake-rung ping')).toBe(true);
    expect(verifyResumeSmokeContinuation(before, before, 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation(before, '{"session":"wrong"}\n' + after, 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation(before, before + '{"text":"different turn"}\n', 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation('', after, 'coord:send wake-rung ping')).toBe(false);
    expect(verifyResumeSmokeContinuation(after, after + '{"text":"other"}\n', 'coord:send wake-rung ping')).toBe(false);
  });

  it('fails required acceptance for a skipped client or an empty selection', () => {
    expect(resumeSmokeExitCode([{ status: 'pass' }, { status: 'skip' }], true)).toBe(1);
    expect(resumeSmokeExitCode([], true)).toBe(1);
    expect(resumeSmokeExitCode([{ status: 'fail' }], false)).toBe(1);
    expect(resumeSmokeExitCode([{ status: 'pass' }], true)).toBe(0);
  });

  it('retains an exact private transcript pair and its wake witness independently of cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-smoke-witness-'));
    try {
      const before = '{"session":"exact"}\n';
      const after = before + '{"text":"unique-wake"}\n';
      const witness = retainResumeSmokeWitness(dir, 'codex', 'fixture-id', before, after, 'unique-wake');
      expect(witness.exactPrefixAndNewWake).toBe(true);
      expect(witness.beforeSha256).not.toBe(witness.afterSha256);
      expect(readFileSync(witness.beforePath, 'utf8')).toBe(before);
      expect(readFileSync(witness.afterPath, 'utf8')).toBe(after);
      expect(lstatSync(witness.afterPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
