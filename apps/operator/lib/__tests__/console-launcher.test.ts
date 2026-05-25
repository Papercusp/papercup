/**
 * Unit coverage for the P-023 / D-023 additions to console-launcher.
 *
 * `shellSafeId` is load-bearing — it stops anything outside
 * `[0-9a-f-]` from reaching a shell oneliner. Session ids are minted
 * as `crypto.randomUUID()`, so the regex is strict by design.
 */
import { describe, expect, it } from 'vitest';
import { buildEngineerOmpLaunchCommand, shellSafeId, shellSafeOmpModel } from '@/lib/console-launcher';

describe('shellSafeId', () => {
  it('accepts a real crypto.randomUUID() value', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(shellSafeId(id)).toBe(id);
  });

  it('accepts mixed-case hex (some uuid generators upper-case)', () => {
    const id = '550E8400-E29B-41D4-A716-446655440000';
    expect(shellSafeId(id)).toBe(id);
  });

  it('rejects a leading shell metachar', () => {
    expect(() => shellSafeId('; rm -rf /')).toThrow(/unsafe session id/i);
  });

  it('rejects backticks', () => {
    expect(() => shellSafeId('`evil`')).toThrow(/unsafe session id/i);
  });

  it('rejects a dollar substitution', () => {
    expect(() => shellSafeId('$(touch /tmp/pwn)')).toThrow(/unsafe session id/i);
  });

  it('rejects a space-separated payload', () => {
    expect(() => shellSafeId('abc 123')).toThrow(/unsafe session id/i);
  });

  it('rejects empty string', () => {
    expect(() => shellSafeId('')).toThrow(/unsafe session id/i);
  });

  it('rejects non-hex letters', () => {
    expect(() => shellSafeId('z'.repeat(36))).toThrow(/unsafe session id/i);
  });

  it('truncates the leaked id in the error message', () => {
    const long = '!'.repeat(100);
    expect(() => shellSafeId(long)).toThrow(/refusing to embed unsafe session id/);
  });
});

describe('shellSafeOmpModel', () => {
  it('accepts common OMP fuzzy model patterns', () => {
    expect(shellSafeOmpModel('opus')).toBe('opus');
    expect(shellSafeOmpModel('gpt-5.2')).toBe('gpt-5.2');
    expect(shellSafeOmpModel('openai/gpt-5.2')).toBe('openai/gpt-5.2');
  });

  it('trims harmless surrounding whitespace', () => {
    expect(shellSafeOmpModel(' sonnet ')).toBe('sonnet');
  });

  it('rejects shell metacharacters and spaces', () => {
    expect(() => shellSafeOmpModel('opus; rm -rf /')).toThrow(/unsafe OMP model/i);
    expect(() => shellSafeOmpModel('claude opus')).toThrow(/unsafe OMP model/i);
  });
});

describe('buildEngineerOmpLaunchCommand', () => {
  it('always targets the engineer playbook directly instead of the ambient omp-su wrapper', () => {
    const cmd = buildEngineerOmpLaunchCommand({});
    expect(cmd).toContain('omp --append-system-prompt "$HOME/.papercusp/engineer-collaborator.md"');
    expect(cmd).toContain('-e "$HOME/.papercusp/papercusp-coord.ts"');
    expect(cmd).not.toContain('omp-su');
  });

  it('appends model and resume args safely', () => {
    const cmd = buildEngineerOmpLaunchCommand({
      ompModel: 'openai/gpt-5.2',
      resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(cmd).toContain('--model openai/gpt-5.2');
    expect(cmd).toContain('-r 550e8400-e29b-41d4-a716-446655440000');
  });

  it('appends a kickoff brief after the engineer-collaborator brief', () => {
    const cmd = buildEngineerOmpLaunchCommand({
      extraSystemPromptPaths: ['/dev/shm/papercusp-kickoff-xyz/new-plan.md'],
    });
    const engineerIdx = cmd.indexOf('"$HOME/.papercusp/engineer-collaborator.md"');
    const kickoffIdx = cmd.indexOf('--append-system-prompt="/dev/shm/papercusp-kickoff-xyz/new-plan.md"');
    expect(engineerIdx).toBeGreaterThan(-1);
    expect(kickoffIdx).toBeGreaterThan(engineerIdx);
  });

  it('preserves order of multiple extra system-prompt paths', () => {
    const cmd = buildEngineerOmpLaunchCommand({
      extraSystemPromptPaths: ['/dev/shm/a.md', '/dev/shm/b.md', '/dev/shm/c.md'],
    });
    const a = cmd.indexOf('"/dev/shm/a.md"');
    const b = cmd.indexOf('"/dev/shm/b.md"');
    const c = cmd.indexOf('"/dev/shm/c.md"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('rejects a non-absolute prompt path', () => {
    expect(() =>
      buildEngineerOmpLaunchCommand({ extraSystemPromptPaths: ['relative/path.md'] }),
    ).toThrow(/must be absolute/i);
  });

  it('rejects a prompt path with quote/control chars', () => {
    expect(() =>
      buildEngineerOmpLaunchCommand({ extraSystemPromptPaths: ['/tmp/"evil".md'] }),
    ).toThrow(/quote\/control/i);
    expect(() =>
      buildEngineerOmpLaunchCommand({ extraSystemPromptPaths: ['/tmp/a\nb.md'] }),
    ).toThrow(/quote\/control/i);
  });

  it('rejects an empty prompt path', () => {
    expect(() =>
      buildEngineerOmpLaunchCommand({ extraSystemPromptPaths: [''] }),
    ).toThrow(/non-empty/i);
  });
});
