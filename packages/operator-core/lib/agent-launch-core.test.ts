import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentLaunchCommand,
  composeModelSpec,
  foldMemberSpec,
  injectAccountArg,
  injectKickoffAfterResume,
  memberLaunchCommand,
  resolveResumeTarget,
  verifyResumeStarted,
  type FleetMemberDefaults,
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

  it('defaults every platform to the system account; auto requires an explicit selection', () => {
    expect(buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', platform: 'darwin' })).toContain(
      '--account=default',
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

  // P-002: the per-member launch fields the general door now composes (so a
  // capability:launch-agent `members[i]` can differ in model/effort/context/limit/…).
  it('folds effort into the model spec (psu has no --effort flag)', () => {
    const cmd = buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', model: 'opus', effort: 'high' });
    expect(cmd).toContain('--model=opus:high');
    expect(cmd).not.toContain('--effort');
  });

  it('quotes a model spec carrying characters outside the bare set (e.g. opus[1m])', () => {
    const cmd = buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', model: 'opus[1m]', effort: 'high' });
    expect(cmd).toContain("--model='opus[1m]:high'");
  });

  it('refuses effort with no model — psu would silently drop it', () => {
    expect(() => buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', effort: 'high' })).toThrow(
      /needs a model/,
    );
  });

  it('emits the full per-member launch flags (context/limit/role/feature/profile/brain/subagents/add-dir/launch-context)', () => {
    const cmd = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: 'claude',
      contextSize: 'trimmed',
      compactionLimit: 200_000,
      role: 'reviewer',
      feature: 'F-12',
      profile: 'lean',
      brain: true,
      allowSubagents: true,
      addDir: ['/tmp/a'],
      launchContext: '/tmp/brief one.md',
    });
    expect(cmd).toContain('--context-size=trimmed');
    expect(cmd).toContain('--compaction-limit=200000');
    expect(cmd).toContain('--role=reviewer');
    expect(cmd).toContain('--feature=F-12');
    expect(cmd).toContain('--profile=lean');
    expect(cmd).toContain('--brain');
    expect(cmd).toContain('--allow-subagents');
    expect(cmd).toContain('--add-dir=/tmp/a');
    // A path with a space is shell-quoted, not rejected.
    expect(cmd).toContain("--launch-context='/tmp/brief one.md'");
  });

  it('omits the new optional flags entirely when unset (no flag, not a zero/false)', () => {
    const cmd = buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude' });
    expect(cmd).toBe('psu --no-picker --account=default --agent=claude');
    for (const flag of ['--compaction-limit', '--context-size', '--role', '--feature', '--profile', '--brain', '--allow-subagents', '--add-dir', '--launch-context']) {
      expect(cmd).not.toContain(flag);
    }
  });
});

describe('foldMemberSpec (P-002: member field wins; unset falls through, never zeroes)', () => {
  const base: FleetMemberDefaults = {
    agent: 'claude',
    account: 'default',
    model: 'sonnet',
    headless: true,
    contextSize: 'full',
  };

  it('returns a copy of the base when no member spec is given', () => {
    expect(foldMemberSpec(base, undefined)).toEqual(base);
    expect(foldMemberSpec(base, undefined)).not.toBe(base);
  });

  it('a set member field overrides the fleet default for that member only', () => {
    const folded = foldMemberSpec(base, { model: 'opus', effort: 'high', account: 'pool-2' });
    expect(folded.model).toBe('opus');
    expect(folded.effort).toBe('high');
    expect(folded.account).toBe('pool-2');
  });

  it('an UNSET member field falls through to the fleet default (never a zeroing override)', () => {
    const folded = foldMemberSpec(base, { role: 'reviewer' });
    // role came from the member; everything else inherits the base.
    expect(folded.role).toBe('reviewer');
    expect(folded.model).toBe('sonnet');
    expect(folded.account).toBe('default');
    expect(folded.headless).toBe(true);
    expect(folded.contextSize).toBe('full');
    expect(folded.agent).toBe('claude');
  });

  it('an unset member agent inherits the fleet agent, never clears it', () => {
    expect(foldMemberSpec(base, { model: 'opus' }).agent).toBe('claude');
  });
});

describe('memberLaunchCommand', () => {
  it('builds the fleet auto-kickoff command with quoted free-form values', () => {
    expect(
      memberLaunchCommand({
        fleetSlug: 'ops',
        agent: 'claude',
        harness: 'papercusp',
        plan: 'my-plan',
        account: 'auto',
        launchContext: '/tmp/brief one.md',
        extraArgs: ['--add-dir=/tmp/work tree'],
      }),
    ).toBe(
      "psu --no-picker --fleet=ops --agent=claude --harness=papercusp --plan=my-plan --account=auto --launch-context='/tmp/brief one.md' '--add-dir=/tmp/work tree'",
    );
  });

  it('rejects shell metacharacters in fleet identity values', () => {
    expect(() =>
      memberLaunchCommand({ fleetSlug: 'ops; touch /tmp/pwned', agent: 'claude', harness: 'h', plan: 'p' }),
    ).toThrow(/fleet with shell metacharacters/);
  });

  // D-001: psu has NO --effort flag, and warn-and-drops unknown flags — so an
  // effort emitted separately is a SILENT no-op. It must ride the model spec.
  it('folds effort into the model spec instead of emitting a --effort psu never reads', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      model: 'opus[1m]',
      effort: 'high',
    });
    // `[1m]` is outside quoteLaunchValue's bare-token set, so the composed spec is quoted.
    expect(cmd).toContain("--model='opus[1m]:high'");
    expect(cmd).not.toContain('--effort');
  });

  // P-005: the flag psu now parses + records onto launch_argv, which the compaction
  // watchdog reads back. Emitting it is what makes MemberSpec.compactionLimit real.
  it('emits --compaction-limit so the per-member limit reaches the seeding pass', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      compactionLimit: 200_000,
    });
    expect(cmd).toContain('--compaction-limit=200000');
  });

  it('omits --compaction-limit entirely when unset (no flag, not a zero)', () => {
    const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'h', plan: 'p' });
    expect(cmd).not.toContain('--compaction-limit');
  });

  // goal-mode-hardening P-009 / D-013: fleet:launch-on-plan { leader:'spawn' } must write
  // the fleet row naming its leader BEFORE that leader exists, so the leader's coord
  // identity is minted by the caller and pinned onto the launch. Without this flag reaching
  // psu, the pre-pin silently does nothing: the spawned agent mints its OWN id at boot, the
  // fleet row points at an identity that never appears, and the fleet is permanently
  // leaderless while every write involved reported success.
  it('emits --owner-id so a pre-pinned coord identity actually reaches the launched agent', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      ownerId: 'su-11111111-2222-3333-4444-555555555555',
    });
    expect(cmd).toContain('--owner-id=su-11111111-2222-3333-4444-555555555555');
  });

  // The slot matters, not just the presence: buildAgentLaunchCommand emits --owner-id in
  // exactly this position (after --agent, before --harness) and its doc states the reason —
  // a GUI launch and a tool launch stay argv-comparable, which is what lets the two be
  // diffed when one of them misbehaves. A drifting slot silently costs that property.
  it('emits --owner-id in the same argv slot buildAgentLaunchCommand uses (after --agent, before --harness)', () => {
    const cmd = memberLaunchCommand({
      fleetSlug: 'ops',
      agent: 'claude',
      harness: 'h',
      plan: 'p',
      ownerId: 'su-abc',
    });
    expect(cmd.indexOf('--agent=')).toBeLessThan(cmd.indexOf('--owner-id='));
    expect(cmd.indexOf('--owner-id=')).toBeLessThan(cmd.indexOf('--harness='));
  });

  it('omits --owner-id entirely when unset (an ordinary member mints its own identity)', () => {
    const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'h', plan: 'p' });
    expect(cmd).not.toContain('--owner-id');
  });

  // The composed command lands inside a terminal greeting one-liner, so an identity-shaped
  // value is VALIDATED rather than quoted — same treatment as fleet/agent/harness. A minted
  // ownerId can never contain metacharacters, so a value that does is a bug or an injection
  // and must be loud rather than shell-escaped into silent acceptance.
  it('refuses an ownerId carrying shell metacharacters instead of quoting it', () => {
    expect(() =>
      memberLaunchCommand({
        fleetSlug: 'ops',
        agent: 'claude',
        harness: 'h',
        plan: 'p',
        ownerId: 'su-abc; touch /tmp/pwned',
      }),
    ).toThrow(/refusing ownerId/);
  });

  // P-003: `plan` is optional — a pure claim-spec fleet launches with no plan, so the
  // member command omits --plan entirely (members self-pull via the fleet claim spec).
  it('omits --plan when no plan is given (pure claim-spec fleet)', () => {
    const cmd = memberLaunchCommand({ fleetSlug: 'ops', agent: 'claude', harness: 'papercusp' });
    expect(cmd).not.toContain('--plan');
    expect(cmd).toBe('psu --no-picker --fleet=ops --agent=claude --harness=papercusp');
  });
});

describe('composeModelSpec (D-001: effort rides the model spec)', () => {
  it('passes the model through untouched when no effort is set', () => {
    expect(composeModelSpec('opus[1m]', undefined)).toBe('opus[1m]');
    expect(composeModelSpec(undefined, undefined)).toBeUndefined();
  });

  it('replaces an effort tail already on the spec (member effort must win)', () => {
    expect(composeModelSpec('opus[1m]:low', 'xhigh')).toBe('opus[1m]:xhigh');
  });

  it('leaves a non-effort colon segment alone (bedrock ids end in :0)', () => {
    expect(composeModelSpec('anthropic.claude-v2:0', 'high')).toBe('anthropic.claude-v2:0:high');
  });

  it('refuses an effort with no model — psu would drop it', () => {
    expect(() => composeModelSpec(undefined, 'high')).toThrow(/needs a model/);
  });

  it('refuses an unrecognized effort', () => {
    expect(() => composeModelSpec('opus[1m]', 'turbo')).toThrow(/unrecognized effort/);
  });
});

describe('resolveResumeTarget', () => {
  it('rejects a ref with neither agentId nor sessionId (no DB round-trip)', async () => {
    const r = await resolveResumeTarget({});
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: 'not_found' });
  });

  it('falls back from an indexed native id to the session_turns owner when adv_sessions.session_id is null', () => {
    const source = readFileSync(new URL('./agent-launch-core.ts', import.meta.url), 'utf8');
    expect(source).toContain('FROM harness_shared.session_turns');
    expect(source).toContain('coord_owner_id = (SELECT owner FROM indexed_owner)');
    expect(source).toContain('sessionId: row.sessionId ?? sessionId!');
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

describe('verifyResumeStarted (EI-11524: a resume that leaves no live agent must not report success)', () => {
  it('confirms started once a live psu-pty host appears for the resumed identity', async () => {
    const findHost = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue({ ownerId: OWNER, pid: 42, sock: `/run/psu-pty/${OWNER}.sock` } as never);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const r = await verifyResumeStarted(OWNER, { findHost, sleep, pollMs: 10, timeoutMs: 1000 });

    expect(r.started).toBe(true);
    expect(findHost).toHaveBeenCalledWith(OWNER);
    // Returned as soon as the host appeared — a healthy resume does not pay the full window.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  // THE REGRESSION: an archived/no-op resume spawns a window but boots no agent, so
  // no live host EVER registers. Before EI-11524 this reported phantom success; now
  // it must be detectable as started:false so the tool can fail loudly.
  it('reports started:false when no live host ever appears (the silent no-op case)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const r = await verifyResumeStarted(OWNER, {
      findHost: () => null,
      sleep,
      pollMs: 10,
      timeoutMs: 35,
    });

    expect(r.started).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(0);
  });
});
