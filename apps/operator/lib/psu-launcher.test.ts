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
  resumeEnvFor,
  addDirArgs,
  forkBootstrapBody,
  forkSeedPaths,
  findUntrackedSession,
  claudeStoreHasSession,
  sessionHasTranscript,
  reportSessionEnded,
  roleLaunchArgs,
  suLaunchArgs,
  agentInvalidForRole,
  suWrapperExtraArgs,
  usePtyHost,
  PTY_DEFAULT_ON,
  AGENTS,
  NO_PLAN,
  NATIVE_SCHEDULER_DENY_FLAG,
  fetchWithResilience,
} from '../scripts/psu-launcher.mjs';
import { nativeSchedulerDenyFlag } from '@papercusp/orchestrator/native-scheduler-deny';

describe('psu-launcher arg parsing', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      picker: true,
      resume: false,
      resumeId: null,
      fork: false,
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
      account: null,
      addDir: [],
      passthrough: [],
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
      fork: false,
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
      account: null,
      addDir: [],
      passthrough: [],
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

  it('parses --account (psu-account-chooser; both = and space forms; default null)', () => {
    expect(parseArgs([]).account).toBeNull();
    expect(parseArgs(['--account=aviynw6']).account).toBe('aviynw6');
    expect(parseArgs(['--account', 'aviynw6']).account).toBe('aviynw6');
    // Composable with the other launch flags + the `--` passthrough is untouched.
    const a = parseArgs(['--no-picker', '--agent=claude', '--account', 'avi-storewolf', '--', '--verbose']);
    expect(a.account).toBe('avi-storewolf');
    expect(a.agent).toBe('claude');
    expect(a.passthrough).toEqual(['--verbose']);
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

  it('parses --add-dir (space + = forms, repeatable); defaults to []', () => {
    expect(parseArgs([]).addDir).toEqual([]);
    expect(parseArgs(['--add-dir', '/tmp/a']).addDir).toEqual(['/tmp/a']);
    expect(parseArgs(['--add-dir=/tmp/b']).addDir).toEqual(['/tmp/b']);
    // Repeatable, both forms intermixed.
    expect(parseArgs(['--add-dir', '/x', '--add-dir=/y', '--add-dir', '/z']).addDir).toEqual(['/x', '/y', '/z']);
    // An empty `--add-dir=` contributes nothing.
    expect(parseArgs(['--add-dir=']).addDir).toEqual([]);
  });

  it('a value after --add-dir is taken verbatim, not parsed as a psu flag', () => {
    // The space-form value is consumed as the dir even if it looks flag-ish.
    const a = parseArgs(['--add-dir', '--no-plan']);
    expect(a.addDir).toEqual(['--no-plan']);
    expect(a.noPlan).toBe(false);
  });

  it('--add-dir before `--` is psu-parsed; after `--` it is verbatim passthrough', () => {
    const a = parseArgs(['--add-dir', '/early', '--', '--add-dir', '/late']);
    expect(a.addDir).toEqual(['/early']);
    expect(a.passthrough).toEqual(['--add-dir', '/late']);
  });

  it('parses --fork / --fork-session (resume-time branch); defaults false', () => {
    expect(parseArgs(['--resume=42', '--fork']).fork).toBe(true);
    expect(parseArgs(['--resume=42', '--fork-session']).fork).toBe(true);
    expect(parseArgs(['--resume=42']).fork).toBe(false);
  });

  it('collects everything after a literal `--` as verbatim passthrough', () => {
    const a = parseArgs(['--resume=42', '--', '--add-dir', '/tmp', '--foo=bar']);
    expect(a.resume).toBe(true);
    expect(a.resumeId).toBe('42');
    expect(a.passthrough).toEqual(['--add-dir', '/tmp', '--foo=bar']);
  });

  it('does NOT parse psu flags that appear after `--` — they are forwarded', () => {
    // `--no-picker` past the `--` is the backend CLI's to interpret, not psu's.
    const a = parseArgs(['--resume=42', '--', '--no-picker']);
    expect(a.picker).toBe(true);
    expect(a.passthrough).toEqual(['--no-picker']);
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

  it('resumeArgsFor appends --fork-session for a claude fork (branch, leave the original)', () => {
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'uuid-1' }, { fork: true }).args).toEqual([
      '--resume', 'uuid-1', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--fork-session',
    ]);
    // Fork also composes with the most-recent (--continue) resume.
    expect(resumeArgsFor({ agent: 'claude' }, { fork: true }).args).toEqual([
      '--continue', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--fork-session',
    ]);
  });

  it('resumeArgsFor refuses --fork for non-claude agents (omp/codex have no fork-session)', () => {
    expect(() => resumeArgsFor({ agent: 'omp', ompThreadId: 't' }, { fork: true })).toThrow(/fork/i);
    expect(() => resumeArgsFor({ agent: 'codex', sessionId: 'u' }, { fork: true })).toThrow(/fork/i);
  });

  it('resumeArgsFor forces the fork id via --session-id ONLY alongside --fork-session (tracked fork)', () => {
    // The plain --session-id/--resume conflict is lifted by --fork-session, so the
    // trio is valid — this is how launchTrackedFork pins the fork to a psu-minted id.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'orig' }, { fork: true, forkSessionId: 'forked' }).args).toEqual([
      '--resume', 'orig', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--fork-session', '--session-id', 'forked',
    ]);
    // forkSessionId WITHOUT fork is ignored (no --fork-session ⇒ --session-id would conflict with --resume).
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'orig' }, { forkSessionId: 'forked' }).args).toEqual([
      '--resume', 'orig', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    ]);
  });

  it('addDirArgs maps to each backend native flag (claude/codex), [] for omp; uses the greed-safe = form', () => {
    expect(addDirArgs('claude', ['/a', '/b'])).toEqual(['--add-dir=/a', '--add-dir=/b']);
    expect(addDirArgs('codex', ['/a'])).toEqual(['--add-dir=/a']);
    expect(addDirArgs('omp', ['/a'])).toEqual([]); // omp has no --add-dir
    expect(addDirArgs('claude', [])).toEqual([]);
    expect(addDirArgs('gemini', ['/a'])).toEqual([]); // unknown backend
  });

  it('resumeArgsFor threads --add-dir into each backend at the right position', () => {
    // claude: appended after the resume/permission flags.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'u' }, { addDir: ['/d'] }).args).toEqual([
      '--resume', 'u', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--add-dir=/d',
    ]);
    // claude fork: --add-dir comes after the fork flags.
    expect(resumeArgsFor({ agent: 'claude', sessionId: 'orig' }, { fork: true, forkSessionId: 'f', addDir: ['/d'] }).args).toEqual([
      '--resume', 'orig', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--fork-session', '--session-id', 'f', '--add-dir=/d',
    ]);
    // codex: --add-dir is a TOP-LEVEL option, so it must precede the `resume` subcommand.
    expect(resumeArgsFor({ agent: 'codex', sessionId: 'u' }, { addDir: ['/d'] }).args).toEqual([
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '--add-dir=/d', 'resume', 'u',
    ]);
  });

  it('forkBootstrapBody carries the original workspace/plan + cwd, harness null, agent claude', () => {
    expect(
      forkBootstrapBody({ agent: 'claude', sessionId: 'orig', coordOwnerId: 'su-1', id: 7, workspaceId: 'ws9', planSlug: 'my-plan', cwd: '/repo' }),
    ).toEqual({ agent: 'claude', workspace: 'ws9', harness_slug: null, plan_slug: 'my-plan', cwd: '/repo' });
    // Missing optional fields collapse to null.
    expect(forkBootstrapBody({ agent: 'claude', cwd: '/repo' })).toEqual({
      agent: 'claude', workspace: null, harness_slug: null, plan_slug: null, cwd: '/repo',
    });
  });

  it('forkSeedPaths points at the projects/ subtree of each config dir', () => {
    expect(forkSeedPaths('/orig/cfg', '/fork/cfg')).toEqual({
      src: '/orig/cfg/projects',
      dst: '/fork/cfg/projects',
    });
  });

  it('resumeEnvFor: identity + workspace scope SURVIVE a tracked resume (psu-workspace-scoping fix)', () => {
    // coordOwnerId is re-exported as PAPERCUSP_SID (wake-executor semantics —
    // a fresh SID orphaned the old one's locks/awaits and detached the adv
    // row); workspaceId rides out as PAPERCUSP_WORKSPACE so the MCP url/header
    // carriers re-scope the resumed session.
    expect(
      resumeEnvFor({ agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' }),
    ).toEqual({
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_SID: 'su-abc',
      PAPERCUSP_WORKSPACE: 'ws1',
      PAPERCUSP_ADV_SESSION_ID: '7',
    });
  });

  it('resumeEnvFor: untracked sessions (no adv row) mint a fresh SID and omit absent fields', () => {
    expect(resumeEnvFor({ agent: 'omp' }, { mintSid: () => 'su-fresh' })).toEqual({
      PAPERCUSP_AGENT: 'omp',
      PAPERCUSP_SID: 'su-fresh',
    });
  });

  it('resumeEnvFor: a FORK takes a fresh coord identity + no adv-row link (concurrent-safe)', () => {
    // Even though the source IS a tracked row (coordOwnerId + id present), the fork
    // must NOT inherit its SID or adv id — otherwise it would collide on the still-
    // live original's locks/presence/wakes. Workspace scope still carries over.
    expect(
      resumeEnvFor(
        { agent: 'claude', id: 7, coordOwnerId: 'su-abc', workspaceId: 'ws1' },
        { mintSid: () => 'su-fork', fork: true },
      ),
    ).toEqual({
      PAPERCUSP_AGENT: 'claude',
      PAPERCUSP_SID: 'su-fork',
      PAPERCUSP_WORKSPACE: 'ws1',
    });
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

  it('claude: raw claude, role prompt, strict role-scoped MCP, skip perms, scheduler lockout', () => {
    const { bin, args } = roleLaunchArgs('claude', files);
    expect(bin).toBe('claude');
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', '/lc/session-7.md',
      '--mcp-config', '/proj/.mcp.json',
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      NATIVE_SCHEDULER_DENY_FLAG,
    ]);
  });

  it('the scheduler lockout literal stays in LOCKSTEP with the canonical TS module (native-scheduler-lockout P-005)', () => {
    // psu-launcher.mjs is a plain-node script that can't import TS, so it
    // duplicates the rendered flag; this pins the copy to the source of truth.
    expect(NATIVE_SCHEDULER_DENY_FLAG).toBe(nativeSchedulerDenyFlag());
  });

  it('the scheduler lockout is one `=` token (the variadic space form would eat following args)', () => {
    expect(NATIVE_SCHEDULER_DENY_FLAG.startsWith('--disallowedTools=')).toBe(true);
    expect(/\s/.test(NATIVE_SCHEDULER_DENY_FLAG)).toBe(false);
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

  // domain-generic-agent-personas-2026-06-17 P-014: REPLACE_CLAUDE_BASE (default-off) — coherent
  // with suLaunchArgs so flipping the flag replaces the base for interactive role sessions too.
  it('replaceClaudeBase OFF (default): claude/omp append (byte-identical to today)', () => {
    expect(roleLaunchArgs('claude', files).args).toContain('--append-system-prompt-file');
    expect(roleLaunchArgs('claude', files).args).not.toContain('--system-prompt-file');
    expect(roleLaunchArgs('omp', files).args).toContain('--append-system-prompt');
    expect(roleLaunchArgs('omp', files).args).not.toContain('--system-prompt');
  });

  it('replaceClaudeBase ON: claude REPLACES the base (--system-prompt-file + --exclude-dynamic), MCP + lockout intact', () => {
    const { args } = roleLaunchArgs('claude', { ...files, replaceClaudeBase: true });
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--system-prompt-file', '/lc/session-7.md',
      '--exclude-dynamic-system-prompt-sections',
      '--mcp-config', '/proj/.mcp.json',
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      NATIVE_SCHEDULER_DENY_FLAG,
    ]);
    expect(args).not.toContain('--append-system-prompt-file');
  });

  it('replaceClaudeBase ON: omp uses --system-prompt (replace) instead of --append', () => {
    const { args } = roleLaunchArgs('omp', { ...files, coordExtPath: '/h/coord.ts', replaceClaudeBase: true });
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--system-prompt', '/lc/session-7.md',
      '-e', '/h/coord.ts',
    ]);
  });

  it('replaceClaudeBase ON: codex is a no-op (CODEX_HOME AGENTS.md is already the whole prompt)', () => {
    expect(roleLaunchArgs('codex', { ...files, replaceClaudeBase: true }).args).toEqual([
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
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

  it('claude su: the HUMAN session keeps native schedulers — NO lockout flag (native-scheduler-lockout D-003)', () => {
    const { args } = suLaunchArgs('claude', files);
    expect(args.some((a) => a.startsWith('--disallowedTools'))).toBe(false);
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

  // domain-generic-agent-personas-2026-06-17 P-014: REPLACE_CLAUDE_BASE (default-off).
  it('replaceClaudeBase OFF (default): claude/omp append (byte-identical to today)', () => {
    expect(suLaunchArgs('claude', files).args).toContain('--append-system-prompt-file');
    expect(suLaunchArgs('claude', files).args).not.toContain('--system-prompt-file');
    expect(suLaunchArgs('claude', files).args).not.toContain('--exclude-dynamic-system-prompt-sections');
    expect(suLaunchArgs('omp', files).args).toContain('--append-system-prompt');
    expect(suLaunchArgs('omp', files).args).not.toContain('--system-prompt');
  });

  it('replaceClaudeBase ON: claude REPLACES the base (--system-prompt-file + --exclude-dynamic)', () => {
    const { args } = suLaunchArgs('claude', { ...files, replaceClaudeBase: true });
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--system-prompt-file', '/lc/session-9.md',
      '--exclude-dynamic-system-prompt-sections',
      '--permission-mode', 'bypassPermissions',
    ]);
    expect(args).not.toContain('--append-system-prompt-file');
  });

  it('replaceClaudeBase ON: omp uses --system-prompt (replace) instead of --append', () => {
    const { args } = suLaunchArgs('omp', { ...files, replaceClaudeBase: true });
    expect(args).toEqual([
      '--approval-mode', 'yolo',
      '--system-prompt', '/lc/session-9.md',
      '-e', '/home/u/.papercusp/papercusp-coord.ts',
    ]);
    expect(args).not.toContain('--append-system-prompt');
  });

  it('replaceClaudeBase ON: codex is a no-op (AGENTS.md is already the whole prompt — no Claude base)', () => {
    expect(suLaunchArgs('codex', { ...files, replaceClaudeBase: true }).args).toEqual([
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('replaceClaudeBase ON: claude still forces --session-id when given', () => {
    const { args } = suLaunchArgs('claude', { promptFile: '/lc/s.md', nativeSessionId: 'uuid-9', replaceClaudeBase: true });
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--system-prompt-file', '/lc/s.md',
      '--exclude-dynamic-system-prompt-sections',
      '--session-id', 'uuid-9',
      '--permission-mode', 'bypassPermissions',
    ]);
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

  it('EI-155: finds an isolated-config-dir claude session + carries its configDir for the resume', () => {
    // No shared ~/.claude/projects copy — the transcript lives ONLY under the
    // per-session isolated dir (<home>/.papercusp/session-claude/<owner>/projects).
    const owner = 'su-owner-1';
    const configDir = join(home, '.papercusp', 'session-claude', owner);
    const projDir = join(configDir, 'projects', '-iso-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/home/me/iso-repo"}\n`);
    expect(findUntrackedSession(UUID, { home })).toEqual({
      agent: 'claude', sessionId: UUID, cwd: '/home/me/iso-repo', untracked: true, configDir,
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

describe('claudeStoreHasSession (check if claude can resume a specific session)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-stores-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('returns true when Claude store has the session file', () => {
    const projDir = join(home, '.claude', 'projects', '-some-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('returns true even if the session file is empty', () => {
    const projDir = join(home, '.claude', 'projects', 'my-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), '');
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('searches across multiple project directories', () => {
    // Create session in a different project dir
    const projDir = join(home, '.claude', 'projects', '-other-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('returns false when the session file does not exist', () => {
    mkdirSync(join(home, '.claude', 'projects', 'my-proj'), { recursive: true });
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it('returns false for null or undefined ids', () => {
    mkdirSync(join(home, '.claude', 'projects', 'my-proj'), { recursive: true });
    expect(claudeStoreHasSession(null, { home })).toBe(false);
    expect(claudeStoreHasSession(undefined, { home })).toBe(false);
    expect(claudeStoreHasSession('', { home })).toBe(false);
  });

  it('returns false when .claude/projects does not exist', () => {
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it('EI-155: finds the transcript in the isolated configDir (not the shared store)', () => {
    // The transcript exists ONLY in the per-session isolated config dir.
    const configDir = join(home, '.papercusp', 'session-claude', 'su-owner-2');
    const projDir = join(configDir, 'projects', '-iso');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
    // Without the configDir hint, the shared store has nothing → false…
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
    // …with it, the brain transcript-check finds the isolated session → true.
    expect(claudeStoreHasSession(UUID, { home, configDir })).toBe(true);
  });
});

describe('claudeStoreHasSession (a tracked adv row alone does not prove resumability)', () => {
  const UUID = '0c0f59c1-1706-4244-aefc-3d6f0aee2361';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-brain-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  it('true when the transcript exists in any project dir', () => {
    const projDir = join(home, '.claude', 'projects', '-some-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}","cwd":"/x"}\n`);
    expect(claudeStoreHasSession(UUID, { home })).toBe(true);
  });

  it('false when no transcript exists — the brain-pane wedge case: a pinned + adv-tracked session whose launch died before its first turn', () => {
    mkdirSync(join(home, '.claude', 'projects', '-some-dir'), { recursive: true });
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
  });

  it('false for a missing store dir or empty id', () => {
    expect(claudeStoreHasSession(UUID, { home })).toBe(false);
    expect(claudeStoreHasSession('', { home })).toBe(false);
  });
});

describe('usePtyHost — managed-pty rollout gate (turn-lifecycle-control Phase 3)', () => {
  const tty = { isTTY: true };
  const notTty = { isTTY: false };

  it('is ON by default for an interactive TTY (managed-pty IS the launch path, D-006)', () => {
    // Flipped 2026-06-08 after the feel-check (P-012/P-015). A bare interactive
    // launch now goes through the managed pty.
    expect(PTY_DEFAULT_ON).toBe(true);
    expect(usePtyHost({ env: {}, stdin: tty, stdout: tty })).toBe(true);
  });

  it('still needs a real TTY on BOTH ends — a non-TTY launch keeps the plain spawn', () => {
    // brain dock pane / --no-picker scripts have no terminal to bridge.
    expect(usePtyHost({ env: {}, stdin: notTty, stdout: tty })).toBe(false);
    expect(usePtyHost({ env: {}, stdin: tty, stdout: notTty })).toBe(false);
  });

  it('PAPERCUSP_PSU_NO_PTY=1 is an always-wins kill switch', () => {
    expect(usePtyHost({ env: { PAPERCUSP_PSU_NO_PTY: '1' }, stdin: tty, stdout: tty })).toBe(false);
  });

  it('PAPERCUSP_PSU_PTY=0 opts a single launch out of the default', () => {
    expect(usePtyHost({ env: { PAPERCUSP_PSU_PTY: '0' }, stdin: tty, stdout: tty })).toBe(false);
  });

  it('PAPERCUSP_PSU_PTY=1 is still honored as an explicit enable', () => {
    expect(usePtyHost({ env: { PAPERCUSP_PSU_PTY: '1' }, stdin: tty, stdout: tty })).toBe(true);
  });
});

describe('sessionHasTranscript (ghost rows — adv-tracked launches that never persisted a turn)', () => {
  const UUID = '0123abcd-1234-5678-9abc-def012345678';
  let home = '';
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'psu-ghosts-')); });
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

  const writeClaudeTranscript = (configDir) => {
    const projDir = join(configDir, 'projects', '-some-dir');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${UUID}.jsonl`), `{"sessionId":"${UUID}"}\n`);
  };

  it('claude: TRUE when the transcript lives in the EI-155 isolated config dir (derived from coordOwnerId)', () => {
    const owner = 'su-owner-9';
    writeClaudeTranscript(join(home, '.papercusp', 'session-claude', owner));
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, coordOwnerId: owner }, { home })).toBe(true);
  });

  it('claude: TRUE when the transcript lives in the shared ~/.claude store (pre-EI-155 sessions)', () => {
    writeClaudeTranscript(join(home, '.claude'));
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, coordOwnerId: 'su-other' }, { home })).toBe(true);
  });

  it('claude: FALSE for a ghost — known sessionId, no transcript anywhere (the "No conversation found" row)', () => {
    // The launch materialized the config dir but died before its first turn.
    mkdirSync(join(home, '.papercusp', 'session-claude', 'su-ghost', 'projects'), { recursive: true });
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, coordOwnerId: 'su-ghost' }, { home })).toBe(false);
  });

  it('claude: KEEPS a pre-native-id row (no sessionId — resume falls back to --continue, unverifiable)', () => {
    expect(sessionHasTranscript({ agent: 'claude', sessionId: null, coordOwnerId: 'su-legacy' }, { home })).toBe(true);
  });

  it('claude: an explicit session.configDir (untracked isolated hit) wins over the owner derivation', () => {
    const configDir = join(home, 'elsewhere', 'iso-dir');
    writeClaudeTranscript(configDir);
    expect(sessionHasTranscript({ agent: 'claude', sessionId: UUID, configDir }, { home })).toBe(true);
  });

  it('codex: TRUE when the per-session CODEX_HOME holds the rollout; FALSE when it does not', () => {
    const dir = join(home, '.papercusp', 'su-codex-homes', 'session-42', 'sessions', '2026', '06', '12');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-06-12T09-00-00-${UUID}.jsonl`), `{"type":"meta"}\n`);
    expect(sessionHasTranscript({ agent: 'codex', id: 42, sessionId: UUID }, { home })).toBe(true);
    expect(sessionHasTranscript({ agent: 'codex', id: 43, sessionId: UUID }, { home })).toBe(false);
  });

  it('codex: KEEPS rows it cannot verify (no sessionId → `resume --last`; no row id → no home to check)', () => {
    expect(sessionHasTranscript({ agent: 'codex', id: 42, sessionId: null }, { home })).toBe(true);
    expect(sessionHasTranscript({ agent: 'codex', id: null, sessionId: UUID }, { home })).toBe(true);
  });

  it('omp: always kept (the thread store is not path-indexed here)', () => {
    expect(sessionHasTranscript({ agent: 'omp', ompThreadId: 't-1' }, { home })).toBe(true);
  });
});

describe('reportSessionEnded (stamp adv ended_at on child exit — best-effort, never rejects)', () => {
  it('POSTs the row id + exit code to bootstrap-su/session-ended with the bearer', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    await reportSessionEnded('17', 0, { fetchImpl, operatorUrl: 'http://op:1', token: 'tok-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://op:1/api/agent-mcp/console/bootstrap-su/session-ended');
    expect(calls[0].opts.headers.authorization).toBe('Bearer tok-1');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ advSessionId: 17, exitCode: 0 });
  });

  it('maps a null/undefined exit code to null (signal exits)', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
    await reportSessionEnded(17, undefined, { fetchImpl, operatorUrl: 'http://op:1', token: 't' });
    expect(JSON.parse(calls[0].opts.body)).toEqual({ advSessionId: 17, exitCode: null });
  });

  it('no adv row id → no request (untracked sessions have nothing to stamp)', async () => {
    const calls = [];
    const fetchImpl = async (...a) => { calls.push(a); return { ok: true }; };
    await reportSessionEnded(null, 0, { fetchImpl, operatorUrl: 'http://op:1', token: 't' });
    expect(calls).toHaveLength(0);
  });

  it('swallows transport failures — psu is about to exit; end-stamping must never hold the terminal', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await expect(
      reportSessionEnded(17, 1, { fetchImpl, operatorUrl: 'http://op:1', token: 't' }),
    ).resolves.toBeUndefined();
  });
});

describe('fetchWithResilience (psu connection-retry hardening)', () => {
  // A fake clock advanced by the injected sleep makes retry timing deterministic
  // without real timers or sockets.
  function fakeClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }
  const connFail = () => { throw new TypeError('fetch failed'); };
  const timeoutErr = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };

  it('rides through a recycle: retries a connection failure on a backoff and returns once the host is back', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; if (n < 3) connFail(); return { ok: true, id: 'live' } as unknown as Response; };
    const res = await fetchWithResilience('http://op/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 30_000,
    });
    expect((res as unknown as { id: string }).id).toBe('live');
    expect(n).toBe(3); // two dead-window failures ridden through, third succeeds
  });

  it('exhausts the connect budget then throws "could not reach … after Ns"', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; connFail(); return undefined as unknown as Response; };
    await expect(
      fetchWithResilience('http://op/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 5_000,
      }),
    ).rejects.toThrow(/could not reach the operator .* after \d+s/);
    expect(n).toBeGreaterThan(1); // it retried within the budget, not a single shot
  });

  it('announces the connection retry exactly once, not per attempt', async () => {
    const clock = fakeClock();
    const notices: string[] = [];
    const fetchImpl = async () => { connFail(); return undefined as unknown as Response; };
    await fetchWithResilience('http://op/x', {}, {
      fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: (m) => notices.push(m), connectBudgetMs: 6_000,
    }).catch(() => {});
    expect(notices.filter((m) => /unreachable .* retrying for up to/.test(m))).toHaveLength(1);
  });

  it('caps timeout retries (reachable-but-slow) and throws "did not respond within"', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; timeoutErr(); return undefined as unknown as Response; };
    await expect(
      fetchWithResilience('http://op/x', {}, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, timeoutRetries: 1,
      }),
    ).rejects.toThrow(/did not respond within \d+ms/);
    expect(n).toBe(2); // initial attempt + 1 capped retry, then give up
  });

  it('a caller-supplied AbortSignal disables retry (caller owns the lifetime)', async () => {
    const clock = fakeClock();
    let n = 0;
    const fetchImpl = async () => { n += 1; connFail(); return undefined as unknown as Response; };
    const ac = new AbortController();
    await expect(
      fetchWithResilience('http://op/x', { signal: ac.signal }, {
        fetchImpl, now: clock.now, sleep: clock.sleep, onNotice: () => {}, connectBudgetMs: 30_000,
      }),
    ).rejects.toThrow(/could not reach/);
    expect(n).toBe(1); // single attempt — no retry when the caller owns the signal
  });
});
