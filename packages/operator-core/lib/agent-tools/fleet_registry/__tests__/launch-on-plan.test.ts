/**
 * Unit tests for fleet:launch-on-plan (EI-5504). The handler spawns desktop
 * terminals (no pure unit surface), so we cover the pure command builder — the
 * load-bearing bit: every member command must carry `--no-picker` + `--plan`, the
 * exact pair that triggers the EI-5503 auto-kickoff so the member starts on boot.
 * Importing the module also validates its whole import chain compiles + loads (the
 * tool self-registers via defineTool on import).
 */
import { describe, it, expect } from 'vitest';
import tool, { memberLaunchCommand } from '../launch-on-plan';

describe('memberLaunchCommand', () => {
  it('builds the scripted psu launch that triggers the auto-kickoff', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' }),
    ).toBe('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan');
  });

  it('always carries --no-picker + --plan (the kickoff gate) for every backend', () => {
    for (const agent of ['claude', 'omp', 'codex']) {
      const cmd = memberLaunchCommand({ fleetSlug: 'f', agent, harness: 'h', plan: 'p' });
      expect(cmd).toContain('--no-picker');
      expect(cmd).toContain('--plan=p');
      expect(cmd).toContain(`--agent=${agent}`);
      expect(cmd).toContain('--fleet=f');
    }
  });

  it('threads the account pin + scalar psu flags as --flag=value (EI-5765)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan',
      account: 'aviynw6', workspace: 'ws1', role: 'su', model: 'opus:high', feature: 'F-3', profile: 'p',
    });
    expect(cmd).toContain('--account=aviynw6');
    expect(cmd).toContain('--workspace=ws1');
    expect(cmd).toContain('--role=su');
    expect(cmd).toContain('--model=opus:high'); // ':' is shell-safe → bare
    expect(cmd).toContain('--feature=F-3');
    expect(cmd).toContain('--profile=p');
    // the base tokens stay first + unchanged
    expect(
      cmd.startsWith('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan'),
    ).toBe(true);
  });

  it('emits --brain as a bare flag and --add-dir repeated', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', brain: true, addDir: ['/a', '/b'],
    });
    expect(cmd).toContain(' --brain');
    expect(cmd).toContain('--add-dir=/a');
    expect(cmd).toContain('--add-dir=/b');
  });

  it('shell-quotes a launch-context path with spaces (injection-safe)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', launchContext: '/home/x/brief one.md',
    });
    expect(cmd).toContain(`--launch-context='/home/x/brief one.md'`);
  });

  it('appends extraArgs verbatim, quoting only what needs it', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'f', agent: 'claude', harness: 'h', plan: 'p', extraArgs: ['--yes', '--add-dir=/x y'],
    });
    expect(cmd).toContain(' --yes');
    expect(cmd).toContain(`'--add-dir=/x y'`);
  });

  it('omits every optional flag when none are passed (base command unchanged)', () => {
    expect(
      memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp', plan: 'my-plan' }),
    ).toBe('psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan');
  });

  it('loads + self-registers the tool module without error', () => {
    expect(tool).toBeTruthy();
  });
});
