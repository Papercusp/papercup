/**
 * D-424 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, P-326): psu's PTY host runs its
 * agent child through `resolveAgentPtyTarget`. Without the hosted agent-identity spec (desktop,
 * dev) the child is exactly what psu asked for; with it, the pty runs the identity transport and
 * a staging refusal propagates — there is no silent fallback to the service user.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_IDENTITY_SPEC_ENV } from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';
import { resolveAgentPtyTarget } from '../scripts/psu-pty-host.mjs';

const target = {
  command: 'claude',
  args: ['--system-prompt-file', '/state/.papercusp/launch-context/s.md'],
  env: { PATH: '/usr/bin', PAPERCUSP_SID: 'su-x' } as Record<string, string | undefined>,
  cwd: '/workspace',
};

describe('psu PTY agent target (D-424)', () => {
  it('is the unchanged child when no identity spec is present', () => {
    const stage = vi.fn();
    const resolved = resolveAgentPtyTarget(target, { stage });
    expect(resolved).toEqual({ command: target.command, args: target.args, env: target.env });
    expect(stage).not.toHaveBeenCalled();
  });

  it('runs the identity transport the stage returns, with only its env', () => {
    const env = { ...target.env, [AGENT_IDENTITY_SPEC_ENV]: '{"v":1}' };
    const stage = vi.fn(() => ({
      command: '/usr/bin/ssh',
      args: ['-tt', '-l', 'papercusp-workspace', '127.0.0.1', 'exec node -e … /x/exec.json'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/state', TERM: 'xterm-256color' },
      execHeaderPath: '/x/exec.json',
      identity: 'papercusp-workspace@127.0.0.1',
    }));
    const resolved = resolveAgentPtyTarget({ ...target, env }, { stage });
    expect(stage).toHaveBeenCalledWith('{"v":1}', { command: 'claude', args: target.args, env, cwd: '/workspace' });
    expect(resolved.command).toBe('/usr/bin/ssh');
    expect(resolved.args).toContain('-tt');
    expect(resolved.env).not.toHaveProperty(AGENT_IDENTITY_SPEC_ENV);
    expect(resolved.env).not.toHaveProperty('PAPERCUSP_SID');
  });

  it('propagates a staging refusal instead of spawning as the service user', () => {
    const env = { ...target.env, [AGENT_IDENTITY_SPEC_ENV]: '{"v":1}' };
    const stage = vi.fn(() => {
      throw Object.assign(new Error('agent toolchain missing'), { code: 'agent_toolchain_missing' });
    });
    expect(() => resolveAgentPtyTarget({ ...target, env }, { stage })).toThrow('agent toolchain missing');
  });
});
