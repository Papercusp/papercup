import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentLaunchCommand,
  injectAccountArg,
  injectKickoffAfterResume,
  resolveResumeTarget,
} from './agent-launch-core';

const OWNER = 'su-b0fbfa98-0594-4a46-909f-3ca16622101d';

describe('injectAccountArg (P-012: a scripted psu launch must never sit on the account picker)', () => {
  it('injects --account=default into a psu command that lacks one', () => {
    const r = injectAccountArg('psu --no-picker --resume=abc', 'default');
    expect(r.injected).toBe(true);
    expect(r.command).toBe('psu --account=default --no-picker --resume=abc');
  });

  it('honors an explicit account', () => {
    const r = injectAccountArg('psu --resume=abc', 'pool-2');
    expect(r.command).toBe('psu --account=pool-2 --resume=abc');
  });

  it('leaves a command that already pins an account alone (=, space, and bare forms)', () => {
    for (const cmd of ['psu --account=auto --resume=x', 'psu --account auto --resume=x']) {
      const r = injectAccountArg(cmd, 'default');
      expect(r.injected).toBe(false);
      expect(r.command).toBe(cmd);
    }
  });

  it('leaves non-psu commands alone', () => {
    const r = injectAccountArg('npm run dev', 'default');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('npm run dev');
  });

  it('matches psu after a shell separator, not inside another word', () => {
    expect(injectAccountArg('cd /repo && psu --resume=x', 'default').command).toBe(
      'cd /repo && psu --account=default --resume=x',
    );
    expect(injectAccountArg('mypsu --resume=x', 'default').injected).toBe(false);
  });

  it('refuses a non-identity-shaped account (shell-injection guard)', () => {
    const r = injectAccountArg('psu --resume=x', 'a; rm -rf /');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('psu --resume=x');
  });
});

describe('buildAgentLaunchCommand', () => {
  it('composes a fresh ad-hoc launch: no-picker + account-pinned', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude' })).toBe(
      'psu --no-picker --account=default --agent=claude',
    );
  });

  // Caught by the P-016 live-verify, NOT by the unit tests above — every one of them
  // passed `agent` explicitly, so the omitted-agent path never ran. psu rejects it at
  // boot (`--agent must be one of claude|omp|codex (got null)`) and the agent dies on a
  // dead prompt. A fresh launch must ALWAYS carry an agent.
  it('defaults the agent on a fresh launch — psu hard-fails without --agent', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh' })).toContain('--agent=claude');
    expect(buildAgentLaunchCommand({ mode: 'fresh', plan: 'p' })).toContain('--agent=claude');
  });

  it('does NOT pass --agent on a resume/fork (the recorded session already carries the kind)', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1' })).not.toContain('--agent');
    expect(buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid-1' })).not.toContain('--agent');
  });

  it('composes a plan launch', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', plan: 'my-plan' })).toBe(
      'psu --no-picker --account=default --agent=claude --plan=my-plan',
    );
  });

  it('composes a resume and a fork of the same session', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1' })).toBe(
      'psu --no-picker --account=default --resume=sid-1',
    );
    expect(buildAgentLaunchCommand({ mode: 'fork', sessionId: 'sid-1' })).toBe(
      'psu --no-picker --account=default --resume=sid-1 --fork',
    );
  });

  it('honors an explicit account', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', sessionId: 'sid-1', account: 'auto' })).toContain(
      '--account=auto',
    );
  });

  it('requires a sessionId in resume/fork mode', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'resume' })).toThrow(/requires sessionId/);
    expect(() => buildAgentLaunchCommand({ mode: 'fork' })).toThrow(/requires sessionId/);
  });

  it('adds --headless (which is what keeps a windowless agent injectable at all)', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', headless: true })).toContain('--headless');
  });

  it('binds a plan to its harness', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', plan: 'my-plan', harness: 'papercusp' })).toContain(
      '--harness=papercusp --plan=my-plan',
    );
  });

  it('defaults macOS to the gateway account (a per-session config dir cannot reach the Keychain login)', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', platform: 'darwin' })).toContain(
      '--account=auto',
    );
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', platform: 'linux' })).toContain(
      '--account=default',
    );
  });

  it('refuses shell metacharacters in ANY value, not just extraArgs', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'resume', sessionId: 'x; rm -rf /' })).toThrow(
      /sessionId with shell metacharacters/,
    );
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', plan: '$(whoami)' })).toThrow(
      /plan with shell metacharacters/,
    );
  });

  it('passes extraArgs through verbatim but refuses shell metacharacters', () => {
    expect(
      buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', extraArgs: ['--model=opus', '--brain'] }),
    ).toBe('psu --no-picker --account=default --agent=claude --model=opus --brain');
    expect(() =>
      buildAgentLaunchCommand({ mode: 'fresh', extraArgs: ['--x=$(rm -rf /)'] }),
    ).toThrow(/shell metacharacters/);
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', extraArgs: ['a; b'] })).toThrow(
      /shell metacharacters/,
    );
  });
});

describe('resolveResumeTarget', () => {
  it('rejects a ref with neither agentId nor sessionId (no DB round-trip)', async () => {
    const r = await resolveResumeTarget({});
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: 'not_found' });
  });
});

describe('injectKickoffAfterResume (D-008: the pty-socket is the only path to a resumed session)', () => {
  it('injects the kickoff as a turn once the pty host appears', async () => {
    const inject = vi.fn().mockResolvedValue(true);
    const findHost = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue({ ownerId: OWNER, pid: 42, sock: `/run/psu-pty/${OWNER}.sock` } as never);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await injectKickoffAfterResume(OWNER, 'pick up where you left off', {
      findHost,
      inject,
      sleep,
      pollMs: 10,
      timeoutMs: 1000,
    });

    expect(r.delivered).toBe(true);
    expect(inject).toHaveBeenCalledWith(`/run/psu-pty/${OWNER}.sock`, {
      mode: 'turn',
      data: 'pick up where you left off',
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reports a loud, actionable failure when the host never appears', async () => {
    const inject = vi.fn();
    const r = await injectKickoffAfterResume(OWNER, 'hi', {
      findHost: () => null,
      inject,
      sleep: vi.fn().mockResolvedValue(undefined),
      pollMs: 10,
      timeoutMs: 30,
    });

    expect(r.delivered).toBe(false);
    expect(inject).not.toHaveBeenCalled();
    expect(r.error).toMatch(/no live pty host appeared/);
  });

  it('reports a failed socket write instead of claiming delivery', async () => {
    const r = await injectKickoffAfterResume(OWNER, 'hi', {
      findHost: () => ({ ownerId: OWNER, pid: 7, sock: '/run/x.sock' }) as never,
      inject: vi.fn().mockResolvedValue(false),
      sleep: vi.fn().mockResolvedValue(undefined),
      pollMs: 10,
      timeoutMs: 1000,
    });

    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/socket write failed/);
  });
});
