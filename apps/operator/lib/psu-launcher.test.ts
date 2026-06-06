import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  planValue,
  selectionsFromArgs,
  presetsFromArgs,
  resumeArgsFor,
  findUntrackedSession,
  roleLaunchArgs,
  suLaunchArgs,
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
      resumeId: null,
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
      profile: null,
      yes: false,
      brain: false,
    });
  });

  it('parses --brain (D-013 canonical-brain resume; defaults false)', () => {
    expect(parseArgs(['--brain']).brain).toBe(true);
    expect(parseArgs([]).brain).toBe(false);
    // Composable with a model override (the dock may pin a model).
    const both = parseArgs(['--brain', '--model=opus']);
    expect(both.brain).toBe(true);
    expect(both.model).toBe('opus');
  });

  it('parses the scripting-escape flags', () => {
    expect(
      parseArgs(['--no-picker', '--agent=claude', '--workspace=ws1', '--harness=papercup', '--plan=my-plan']),
    ).toEqual({
      picker: false,
      resume: false,
      resumeId: null,
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
      profile: null,
      yes: false,
      brain: false,
    });
  });

  it('parses --resume (picker mode — no id)', () => {
    const a = parseArgs(['--resume']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBeNull();
  });

  it('parses --resume=<id> (direct, skip picker)', () => {
    const a = parseArgs(['--resume=42']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe('42');
  });

  it('parses a bare positional id after --resume', () => {
    const a = parseArgs(['--resume', '57']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe('57');
  });

  it('parses --no-plan', () => {
    expect(parseArgs(['--no-picker', '--agent=omp', '--harness=x', '--no-plan']).noPlan).toBe(true);
  });

  it('parses --profile (P-023); defaults to null', () => {
    expect(parseArgs(['--profile=power']).profile).toBe('power');
    expect(parseArgs(['--agent=claude']).profile).toBeNull();
  });

  it('parses --yes / -y (untracked-resume confirm bypass); defaults false', () => {
    expect(parseArgs(['--resume=x', '--yes']).yes).toBe(true);
    expect(parseArgs(['--resume=x', '-y']).yes).toBe(true);
    expect(parseArgs(['--resume=x']).yes).toBe(false);
  });

  it('resumeArgsFor maps each agent to its RAW CLI + resume args (P-042, no wrapper)', () => {
    expect(resumeArgsFor({ agent: 'claude', cwd: '/x' })).toEqual({
      bin: 'claude',
      args: ['--continue', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'],
    });
    // omp: thread target (or -c) + yolo; -e only when a coordExtPath is supplied.
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: 'thr-1' })).toEqual({
      bin: 'omp',
      args: ['-r', 'thr-1', '--approval-mode', 'yolo'],
    });
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: null }, { coordExtPath: '/h/.papercusp/papercusp-coord.ts' })).toEqual({
      bin: 'omp',
      args: ['-c', '--approval-mode', 'yolo', '-e', '/h/.papercusp/papercusp-coord.ts'],
    });
    expect(resumeArgsFor({ agent: 'codex', cwd: '/x' })).toEqual({
      bin: 'codex',
      args: ['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'resume', '--last'],
    });
    expect(() => resumeArgsFor({ agent: 'gemini', cwd: '/x' })).toThrow();
  });

  it('resumeArgsFor uses precise resume-by-id when a native sessionId is known', () => {
    // Store-found (untracked) sessions carry the agent's native id → resume EXACTLY it.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'uuid-1' }).args).toEqual([
      '--resume', 'uuid-1', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    ]);
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'uuid-2' }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'resume', 'uuid-2',
    ]);
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

  it('omp: loads the coordination extension (-e) when a coordExtPath is supplied (lock + activity bridge)', () => {
    const { args } = roleLaunchArgs('omp', { ...files, coordExtPath: '/h/.papercusp/papercusp-coord.ts' });
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--append-system-prompt', '/lc/session-7.md',
      '-e', '/h/.papercusp/papercusp-coord.ts',
    ]);
  });

  it('omp: omits -e when no coordExtPath is supplied', () => {
    const { args } = roleLaunchArgs('omp', files);
    expect(args).not.toContain('-e');
  });

  it('codex: raw codex, hook-trust + approvals/sandbox bypass (CODEX_HOME via envelopeEnv)', () => {
    const { bin, args } = roleLaunchArgs('codex', files);
    expect(bin).toBe('codex');
    expect(args).toEqual(['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox']);
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

describe('suLaunchArgs (P-020 raw-CLI su launch, mirrors roleLaunchArgs)', () => {
  const files = { promptFile: '/lc/session-9.md', coordExtPath: '/home/u/.papercusp/papercusp-coord.ts' };

  it('claude: playbook prompt + skip-perms, NO --mcp-config (papercusp-su is user-level)', () => {
    const { bin, args } = suLaunchArgs('claude', files);
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/session-9.md',
      '--permission-mode', 'bypassPermissions',
    ]);
    // su relies on the user-level papercusp-su MCP (no per-launch --mcp-config),
    // so the user's full toolkit loads (D-005) and the server isn't doubled.
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('omp: yolo + playbook prompt + coordination extension (-e, P-021)', () => {
    const { bin, args } = suLaunchArgs('omp', files);
    expect(bin).toBe('omp');
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--append-system-prompt', '/lc/session-9.md',
      '-e', '/home/u/.papercusp/papercusp-coord.ts',
    ]);
  });

  it('omp: omits -e when no coordExtPath is supplied', () => {
    const { args } = suLaunchArgs('omp', { promptFile: '/lc/s.md' });
    expect(args).toEqual(['--approval-mode', 'yolo', '--append-system-prompt', '/lc/s.md']);
    expect(args).not.toContain('-e');
  });

  it('codex: hook-trust + approvals/sandbox bypass (CODEX_HOME minted server-side, P-030)', () => {
    const { bin, args } = suLaunchArgs('codex', files);
    expect(bin).toBe('codex');
    expect(args).toEqual(['--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox']);
  });

  it('claude: forces --session-id when a nativeSessionId is supplied (resume-by-uuid correlation)', () => {
    const { args } = suLaunchArgs('claude', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9' });
    // --session-id sits between the appended prompt and the permission mode; it
    // makes `psu --resume uuid-9` match the tracked adv row + resume the EXACT session.
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/s.md',
      '--session-id', 'uuid-9',
      '--permission-mode', 'bypassPermissions',
    ]);
  });

  it('claude: omits --session-id when no nativeSessionId is given', () => {
    expect(suLaunchArgs('claude', { promptFile: '/lc/s.md' }).args).not.toContain('--session-id');
  });

  it('omp/codex: ignore nativeSessionId (no forced session id on those backends)', () => {
    expect(suLaunchArgs('omp', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9' }).args).not.toContain('--session-id');
    expect(suLaunchArgs('codex', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9' }).args).not.toContain('--session-id');
  });

  it('unknown backend: throws', () => {
    expect(() => suLaunchArgs('gemini', files)).toThrow();
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

describe('findUntrackedSession (resume a non-psu session by searching the agent stores)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-stores-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('finds a CLAUDE session by id + recovers cwd from the jsonl (not the dir name)', () => {
    const projDir = join(home, '.claude', 'projects', '-some-dashed-dir');
    mkdirSync(projDir, { recursive: true });
    // The real cwd contains a dash — dir-name decoding would be wrong; the
    // jsonl's "cwd" is authoritative.
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/home/me/my-repo"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'claude', sessionId: UUID, cwd: '/home/me/my-repo', untracked: true,
    });
  });

  it('finds a CODEX session by id under sessions/YYYY/MM/DD + recovers cwd', () => {
    const dir = join(home, '.codex', 'sessions', '2026', '05', '31');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-05-31T09-00-00-${UUID}.jsonl`), `{"type":"meta","cwd":"/home/me/proj"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'codex', sessionId: UUID, cwd: '/home/me/proj', untracked: true,
    });
  });

  it('a non-UUID id → an omp thread name, resumed in the current dir', () => {
    expect(findUntrackedSession('my-thread', { home, cwd: '/here' })).toEqual({
      agent: 'omp', ompThreadId: 'my-thread', cwd: '/here', untracked: true,
    });
  });

  it('returns null for an unknown UUID with no matching file', () => {
    expect(findUntrackedSession(UUID, { home })).toBeNull();
  });
});
