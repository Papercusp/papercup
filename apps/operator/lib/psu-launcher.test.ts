import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planValue,
  selectionsFromArgs,
  presetsFromArgs,
  resumeArgsFor,
  roleLaunchArgs,
  agentInvalidForRole,
  suWrapperExtraArgs,
  AGENTS,
  NO_PLAN,
} from '../scripts/psu-launcher.mjs';

describe('psu-launcher arg parsing', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      picker: true,
      resume: false,
      agent: null,
      role: null,
      feature: null,
      workspace: null,
      harness: null,
      plan: null,
      noPlan: false,
      model: null,
      resumeSession: null,
      launchContext: null,
    });
  });

  it('parses the scripting-escape flags', () => {
    expect(
      parseArgs(['--no-picker', '--agent=claude', '--workspace=ws1', '--harness=papercup', '--plan=my-plan']),
    ).toEqual({
      picker: false,
      resume: false,
      agent: 'claude',
      role: null,
      feature: null,
      workspace: 'ws1',
      harness: 'papercup',
      plan: 'my-plan',
      noPlan: false,
      model: null,
      resumeSession: null,
      launchContext: null,
    });
  });

  it('parses --resume', () => {
    expect(parseArgs(['--resume']).resume).toBe(true);
  });

  it('parses --no-plan', () => {
    expect(parseArgs(['--no-picker', '--agent=omp', '--harness=x', '--no-plan']).noPlan).toBe(true);
  });

  it('resumeArgsFor maps each agent to its wrapper + resume args', () => {
    expect(resumeArgsFor({ agent: 'claude', cwd: '/x' })).toEqual({
      wrapperBin: 'claude-su',
      args: ['--continue'],
    });
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: 'thr-1' })).toEqual({
      wrapperBin: 'omp-su',
      args: ['-r', 'thr-1'],
    });
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: null })).toEqual({
      wrapperBin: 'omp-su',
      args: ['-c'],
    });
    expect(resumeArgsFor({ agent: 'codex', cwd: '/x' })).toEqual({
      wrapperBin: 'codex-su',
      args: ['resume', '--last'],
    });
    expect(() => resumeArgsFor({ agent: 'gemini', cwd: '/x' })).toThrow();
  });

  it('planValue maps the NO_PLAN sentinel + empties to null', () => {
    expect(planValue(NO_PLAN)).toBeNull();
    expect(planValue('')).toBeNull();
    expect(planValue(null)).toBeNull();
    expect(planValue('real-plan')).toBe('real-plan');
  });

  it('selectionsFromArgs resolves --no-plan to a null plan + passes workspace', () => {
    expect(
      selectionsFromArgs({ agent: 'omp', workspace: 'ws1', harness: 'papercup', plan: null, noPlan: true }),
    ).toEqual({
      agent: 'omp',
      workspace: 'ws1',
      harness: 'papercup',
      plan: null,
    });
  });

  it('selectionsFromArgs keeps --plan when --no-plan is absent; null workspace when omitted', () => {
    expect(selectionsFromArgs({ agent: 'codex', workspace: null, harness: null, plan: 'p', noPlan: false })).toEqual({
      agent: 'codex',
      workspace: null,
      harness: null,
      plan: 'p',
    });
  });

  it('selectionsFromArgs rejects an unknown agent', () => {
    expect(() => selectionsFromArgs({ agent: 'gemini', harness: 'x', plan: null, noPlan: false })).toThrow();
  });

  it('AGENTS lists exactly the three kinds', () => {
    expect(AGENTS).toEqual(['claude', 'omp', 'codex']);
  });

  it('presetsFromArgs: all flags preselect everything (no prompts needed)', () => {
    const p = presetsFromArgs(parseArgs(['--agent=claude', '--workspace=ws2', '--harness=papercup', '--plan=p']));
    expect(p).toMatchObject({
      agent: 'claude',
      workspace: 'ws2',
      harness: 'papercup',
      plan: 'p',
      needAgent: false,
      needWorkspace: false,
      needHarness: false,
      needPlan: false,
    });
  });

  it('presetsFromArgs: no flags → everything needs a prompt', () => {
    const p = presetsFromArgs(parseArgs([]));
    expect(p).toMatchObject({
      agent: null,
      workspace: null,
      harness: null,
      plan: null,
      needAgent: true,
      needWorkspace: true,
      needHarness: true,
      needPlan: true,
    });
  });

  it('presetsFromArgs: partial preselect (agent + workspace) prompts only for harness + plan', () => {
    const p = presetsFromArgs(parseArgs(['--agent=omp', '--workspace=ws2']));
    expect(p.agent).toBe('omp');
    expect(p.workspace).toBe('ws2');
    expect(p.needAgent).toBe(false);
    expect(p.needWorkspace).toBe(false);
    expect(p.needHarness).toBe(true);
    expect(p.needPlan).toBe(true);
  });

  it('presetsFromArgs: --no-plan preselects "no plan" (no plan prompt)', () => {
    const p = presetsFromArgs(parseArgs(['--agent=claude', '--no-plan']));
    expect(p.plan).toBeNull();
    expect(p.needPlan).toBe(false);
  });

  it('presetsFromArgs: rejects a bad --agent', () => {
    expect(() => presetsFromArgs(parseArgs(['--agent=gemini']))).toThrow();
  });

  it('parses --role and --feature', () => {
    const a = parseArgs(['--role=worker', '--feature=F-001', '--harness=papercup', '--agent=claude']);
    expect(a.role).toBe('worker');
    expect(a.feature).toBe('F-001');
  });
});

describe('roleLaunchArgs (interactive role session)', () => {
  const files = { promptFile: '/lc/session-7.md', mcpJsonPath: '/proj/.mcp.json' };

  it('claude: raw claude, role prompt, strict role-scoped MCP, skip perms', () => {
    const { bin, args } = roleLaunchArgs('claude', files);
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/session-7.md',
      '--mcp-config', '/proj/.mcp.json',
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
    ]);
  });

  it('omp: raw omp, role prompt file, yolo approvals (path-discovers .mcp.json)', () => {
    const { bin, args } = roleLaunchArgs('omp', files);
    expect(bin).toBe('omp');
    expect(args).toEqual(['--approval-mode', 'yolo', '--append-system-prompt', '/lc/session-7.md']);
  });

  it('codex: raw codex, approvals/sandbox bypass (CODEX_HOME via envelopeEnv)', () => {
    const { bin, args } = roleLaunchArgs('codex', files);
    expect(bin).toBe('codex');
    expect(args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('unknown backend: throws', () => {
    expect(() => roleLaunchArgs('gemini', files)).toThrow();
  });

  it('agentInvalidForRole accepts claude/omp/codex', () => {
    expect(agentInvalidForRole('claude')).toBe(false);
    expect(agentInvalidForRole('omp')).toBe(false);
    expect(agentInvalidForRole('codex')).toBe(false);
    expect(agentInvalidForRole(null)).toBe(true);
    expect(agentInvalidForRole('gemini')).toBe(true);
  });
});

describe('suWrapperExtraArgs (P-032 omp-parity passthrough)', () => {
  it('parses the new omp-convergence flags', () => {
    const a = parseArgs(['--no-picker', '--agent=omp', '--model=opus', '--resume-session=s-7', '--launch-context=/dev/shm/k.md']);
    expect(a.model).toBe('opus');
    expect(a.resumeSession).toBe('s-7');
    expect(a.launchContext).toBe('/dev/shm/k.md');
  });

  it('omp/claude: --model + -r; codex: -m + resume', () => {
    expect(suWrapperExtraArgs('omp', { model: 'opus', resumeSession: 's-1' })).toEqual(['--model', 'opus', '-r', 's-1']);
    expect(suWrapperExtraArgs('claude', { model: 'sonnet', resumeSession: 's-2' })).toEqual(['--model', 'sonnet', '-r', 's-2']);
    expect(suWrapperExtraArgs('codex', { model: 'gpt-5.5', resumeSession: 's-3' })).toEqual(['-m', 'gpt-5.5', 'resume', 's-3']);
  });

  it('emits nothing when neither model nor resume is set', () => {
    expect(suWrapperExtraArgs('omp', {})).toEqual([]);
    expect(suWrapperExtraArgs('omp')).toEqual([]);
  });
});
