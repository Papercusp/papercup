import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchCoreSql = vi.hoisted(() =>
  vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as unknown[]),
);
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: launchCoreSql }),
}));

import {
  AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS,
  AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS,
  buildAgentLaunchCommand,
  claimAgentLaunch,
  composeModelSpec,
  foldMemberSpec,
  injectAccountArg,
  injectKickoffAfterResume,
  memberLaunchCommand,
  nativeSessionIdFromHost,
  probeFreshLaunchSessions,
  resolvedNativeSessionId,
  isStaleHeadlessAgentHost,
  restoreVisibleMayShutdown,
  resolveResumeTarget,
  verifyResumeStarted,
  waitForPtyHostGone,
  type FleetMemberDefaults,
} from './agent-launch-core';

const OWNER = 'su-b0fbfa98-0594-4a46-909f-3ca16622101d';

beforeEach(() => {
  launchCoreSql.mockReset();
  launchCoreSql.mockResolvedValue([] as unknown[]);
});

describe('claimAgentLaunch crash recovery', () => {
  it('atomically lets an honest retry win after an empty in-progress claim outlives its lease', async () => {
    const firstNow = 1_800_000_000_000;
    const retryNow = firstNow + AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS + 1;
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'crash-window' }])
      // Simulate the winning process disappearing before record/release. The
      // next call reaches the same UPSERT after the lease threshold.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'crash-window' }]);

    const first = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'crash-window',
      launchedBy: 'su-first',
      now: firstNow,
    });
    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'crash-window',
      launchedBy: 'su-retry',
      now: retryNow,
    });

    expect(first.won).toBe(true);
    expect(retry.won).toBe(true);
    const retryUpsert = launchCoreSql.mock.calls[3];
    const query = String(retryUpsert?.[0]?.join(' '));
    expect(query).toContain('ON CONFLICT (workspace_id, idempotency_key) DO UPDATE');
    expect(query).toContain("existing.summary = '{}'::jsonb");
    expect(retryUpsert?.slice(1)).toContain(retryNow - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS);
  });

  it('keeps a recent empty claim fail-closed so an ordinary retry cannot duplicate a launch', async () => {
    const now = 1_800_000_000_000;
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ summary: {}, launched_at: now - 1_000, launched_by: 'su-first' }]);

    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'still-running',
      launchedBy: 'su-retry',
      now,
    });

    expect(retry).toEqual({
      won: false,
      priorSummary: {},
      priorLaunchedAt: now - 1_000,
      priorLaunchedBy: 'su-first',
    });
  });

  it('never leases over a completed launch summary, even when the row is old', async () => {
    const now = 1_800_000_000_000;
    const summary = { opened: 1, mode: 'fresh' };
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        summary,
        launched_at: now - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS - 1,
        launched_by: 'su-first',
      }]);

    const replay = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'completed-launch',
      launchedBy: 'su-retry',
      now,
    });

    expect(replay.won).toBe(false);
    expect(replay.priorSummary).toEqual(summary);
  });

  it('reclaims an old explicit agentStarted:null receipt so a stalled launch can be replaced', async () => {
    const now = 1_800_000_000_000;
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ idempotency_key: 'stalled-launch' }]);

    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'stalled-launch',
      launchedBy: 'su-retry',
      now,
    });

    expect(retry.won).toBe(true);
    const query = String(launchCoreSql.mock.calls[1]?.[0]?.join(' '));
    expect(query).toContain("existing.summary -> 'agentStarted' = 'null'::jsonb");
    expect(launchCoreSql.mock.calls[1]?.slice(1)).toContain(
      now - AGENT_LAUNCH_UNCONFIRMED_CLAIM_LEASE_MS,
    );
  });

  it('keeps a recent agentStarted:null receipt fail-closed', async () => {
    const now = 1_800_000_000_000;
    const summary = { opened: 1, agentStarted: null, mode: 'fresh' };
    launchCoreSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        summary,
        launched_at: now - 1_000,
        launched_by: 'su-first',
      }]);

    const retry = await claimAgentLaunch({
      workspaceId: 'ws-test',
      idempotencyKey: 'still-starting',
      launchedBy: 'su-retry',
      now,
    });

    expect(retry).toEqual({
      won: false,
      priorSummary: summary,
      priorLaunchedAt: now - 1_000,
      priorLaunchedBy: 'su-first',
    });
  });
});

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

  it('accepts a tracked resume selector when native sessionId is unavailable', () => {
    expect(buildAgentLaunchCommand({ mode: 'resume', resumeId: '22661' })).toContain('--resume=22661');
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

  it('shell-quotes extraArgs so structured JSON reaches psu as one argv value', () => {
    expect(
      buildAgentLaunchCommand({ mode: 'fresh', agent: 'claude', extraArgs: ['--model=opus', '--brain'] }),
    ).toBe('psu --no-picker --account=default --agent=claude --model=opus --brain');

    const offenderList = JSON.stringify({
      files: [
        {
          scope: 'superproject',
          file: 'apps/operator-docs/src/content/docs/example.mdx',
          detector: 'mdx',
          error: "unexpected ';' and $(touch /tmp/pwned)",
        },
      ],
    });
    const command = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: 'claude',
      extraArgs: ['--git-sync-content-error', offenderList],
    });

    expect(command).toContain('--git-sync-content-error');
    // The command runs in a shell greeting. Replacing psu with printf verifies
    // that shell metacharacters remain literal and the JSON survives as one
    // argument, rather than becoming command syntax.
    const output = execFileSync(
      'bash',
      ['-lc', command.replace(/^psu /, "printf '%s\\n' ")],
      { encoding: 'utf8' },
    );
    expect(output.trimEnd().split('\n').at(-1)).toBe(offenderList);
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
    contextSize: 'trimmed',
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
    expect(folded.contextSize).toBe('trimmed');
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

  it('uses session_turns only to recover the owner; an exact native UUID never rewinds to the owner row UUID', () => {
    expect(resolvedNativeSessionId('later-rollout-uuid', 'older-root-uuid')).toBe('later-rollout-uuid');
    expect(resolvedNativeSessionId('later-rollout-uuid', null)).toBe('later-rollout-uuid');
    expect(resolvedNativeSessionId(null, 'owner-latest-uuid')).toBe('owner-latest-uuid');

    const source = readFileSync(new URL('./agent-launch-core.ts', import.meta.url), 'utf8');
    expect(source).toContain('FROM harness_shared.session_turns t');
    expect(source).toContain('candidate_session_id');
    expect(source).toContain('t.ingested_at DESC');
    expect(source).toContain('coord_owner_id = (SELECT owner FROM indexed_owner)');
  });

  // WI-555403. A carry-respawn REWRITES the owner's adv_sessions row in place
  // (same row id, new session_id), so every EARLIER native session in the chain
  // has no adv_sessions row at all. Seeding the candidate CTE from adv_sessions
  // left indexed_owner NULL for exactly those sessions and they resolved as
  // not_found, even though session_turns still holds them under the same owner.
  const candidateFragmentOf = (calls: { 0?: TemplateStringsArray }[]): string | undefined =>
    calls.map((c) => String(c[0]?.join('?'))).find((q) => q.includes('candidate_session_id'));

  it('pins an exact native session as its own candidate, so an earlier session in a respawn chain still resolves', async () => {
    // The requested uuid is NOT in adv_sessions; the row that comes back is the
    // owner's CURRENT one, recovered via session_turns.
    launchCoreSql.mockResolvedValue([{
      id: 20807,
      workspace_id: 'ws-carry',
      coord_owner_id: OWNER,
      session_id: 'current-native-uuid',
      agent: 'claude',
      cwd: '/repo',
      started_at: '2026-08-29T00:04:31.000Z',
      binding_started_at: '2026-08-29 00:04:31.000123+00',
      ended_at: null,
      exit_code: null,
      ended_by: null,
    }] as unknown[]);

    const r = await resolveResumeTarget({ sessionId: 'earlier-native-uuid' });

    // The pin survives: we resume the transcript that was ASKED for, while the
    // owner/advSessionId metadata comes from the row that is current now.
    expect(r).toMatchObject({
      ok: true,
      sessionId: 'earlier-native-uuid',
      resumeId: 'earlier-native-uuid',
      ownerId: OWNER,
      advSessionId: 20807,
      binding: {
        coordOwnerId: OWNER,
        sessionId: 'current-native-uuid',
        startedAt: '2026-08-29 00:04:31.000123+00',
      },
    });

    const fragment = candidateFragmentOf(launchCoreSql.mock.calls as unknown as { 0?: TemplateStringsArray }[]);
    expect(fragment).toBeDefined();
    expect(fragment).not.toContain('harness_shared.adv_sessions');
  });

  it('uses a tracked Codex adv-session id when the row has no native session uuid', async () => {
    launchCoreSql.mockResolvedValue([{
      id: 22661,
      workspace_id: 'ws-codex',
      coord_owner_id: OWNER,
      session_id: null,
      agent: 'codex',
      cwd: '/repo',
      started_at: '2026-09-05T23:16:36.945Z',
      binding_started_at: '2026-09-05 23:16:36.945123+00',
      ended_at: null,
      exit_code: null,
      ended_by: null,
    }] as unknown[]);

    await expect(resolveResumeTarget({ agentId: OWNER })).resolves.toMatchObject({
      ok: true,
      sessionId: null,
      resumeId: '22661',
      ownerId: OWNER,
      advSessionId: 22661,
    });
  });

  it('CONTROL: an agentId lookup still seeds its candidate from adv_sessions', async () => {
    launchCoreSql.mockResolvedValue([] as unknown[]);

    await resolveResumeTarget({ agentId: OWNER });

    const fragment = candidateFragmentOf(launchCoreSql.mock.calls as unknown as { 0?: TemplateStringsArray }[]);
    expect(fragment).toBeDefined();
    expect(fragment).toContain('harness_shared.adv_sessions');
  });
});

describe('probeFreshLaunchSessions', () => {
  it('executes the probe and maps the nullable native session id from adv_sessions', async () => {
    launchCoreSql.mockResolvedValueOnce([{
      id: 123,
      session_id: 'native-session-123',
      coord_owner_id: 'su-probed',
      successful_calls: 1,
      scheduler_calls: 0,
      successful_scheduler_calls: 0,
      ms_since_last_signal: 25,
      has_presence: true,
      scheduler_disposition: null,
      claimed_work_item_id: null,
      launch_spec: {},
      launch_argv: ['psu', '--headless'],
    }]);

    const sessions = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
    });

    expect(sessions).toMatchObject([{
      advSessionId: 123,
      sessionId: 'native-session-123',
      ownerId: 'su-probed',
    }]);
    const query = launchCoreSql.mock.calls
      .map((call) => String(call[0]?.join(' ')))
      .find((candidate) => candidate.includes('s.session_id'));
    expect(query).toContain('s.session_id');
  });

  it('uses the authoritative self-wake oracle when session_briefs has stale `none`', async () => {
    launchCoreSql
      .mockResolvedValueOnce([{
        id: 125,
        session_id: 'native-session-125',
        coord_owner_id: 'su-probed',
        successful_calls: 1,
        scheduler_calls: 0,
        successful_scheduler_calls: 0,
        ms_since_last_signal: 25,
        has_presence: true,
        // This is the stale launch snapshot that caused EI-225344. The probe
        // must not consume it as the live wake truth.
        wake_source: 'none',
        scheduler_disposition: null,
        claimed_work_item_id: null,
        launch_spec: {},
        launch_argv: ['psu', '--headless'],
      }])
      // fetchSelfWake's two parallel queries: active loop, then event awaits.
      .mockResolvedValueOnce([{ target_owner_id: 'su-probed' }])
      .mockResolvedValueOnce([]);

    const sessions = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
    });

    expect(sessions[0]?.workerAttestation.stages.durableWake).toEqual({
      status: 'satisfied',
      wakeSource: 'loop',
    });
    const queries = launchCoreSql.mock.calls.map((call) => String(call[0]?.join(' ')));
    expect(queries.some((query) => query.includes('harness_shared.routines'))).toBe(true);
    expect(queries.some((query) => query.includes('harness_shared.event_awaits'))).toBe(true);
    expect(queries.some((query) => query.includes('harness_shared.session_briefs'))).toBe(false);
  });

  it('fails closed when the authoritative self-wake oracle cannot be read', async () => {
    launchCoreSql
      .mockResolvedValueOnce([{
        id: 126,
        session_id: 'native-session-126',
        coord_owner_id: 'su-probed',
        successful_calls: 1,
        scheduler_calls: 0,
        successful_scheduler_calls: 0,
        ms_since_last_signal: 25,
        has_presence: true,
        scheduler_disposition: null,
        claimed_work_item_id: null,
        launch_spec: {},
        launch_argv: ['psu', '--headless'],
      }])
      .mockRejectedValueOnce(new Error('self-wake oracle unavailable'));

    await expect(probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
    })).rejects.toThrow('fresh-launch probe failed: self-wake oracle unavailable');
  });

  it('treats the Claude [1m] context marker as equivalent during attestation', async () => {
    const row = (model: string) => ({
      id: 124,
      session_id: 'native-session-124',
      coord_owner_id: 'su-probed',
      successful_calls: 1,
      scheduler_calls: 1,
      successful_scheduler_calls: 1,
      ms_since_last_signal: 25,
      has_presence: true,
      wake_source: 'loop',
      scheduler_disposition: { kind: 'claimed', workItemId: 'WI-42407' },
      claimed_work_item_id: 'WI-42407',
      launch_spec: {
        agent: 'claude',
        workspaceId: 'ws-probe',
        harnessSlug: 'papercusp',
        planSlug: null,
        model,
        fleet: { slug: 'fleet-probe', role: 'member' },
      },
      launch_argv: [
        'psu',
        `--model=${model}`,
        '--account=default',
        '--carry=warm',
        '--headless',
      ],
    });
    const expected = {
      ownerId: 'su-probed',
      agent: 'claude',
      workspaceId: 'ws-probe',
      harnessSlug: 'papercusp',
      planSlug: null,
      model: 'claude-sonnet-5:xhigh',
      modelSource: null,
      effort: 'xhigh',
      account: 'default',
      carry: 'warm' as const,
      visibility: 'headless' as const,
      fleetSlug: 'fleet-probe',
      fleetRole: 'member',
    };

    launchCoreSql.mockResolvedValueOnce([row('claude-sonnet-5[1m]:xhigh')]);
    const normalized = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
      expectedOwnerIds: ['su-probed'],
      expectedAttestations: [expected],
    });
    expect(normalized[0]?.attestationDiffs).toEqual([]);

    launchCoreSql.mockResolvedValueOnce([row('claude-sonnet-4-6:xhigh')]);
    const genuinelyDifferent = await probeFreshLaunchSessions({
      workspaceId: 'ws-probe',
      launcherOwnerId: 'su-launcher',
      since: 1_000,
      expectedOwnerIds: ['su-probed'],
      expectedAttestations: [expected],
    });
    expect(genuinelyDifferent[0]?.attestationDiffs).toEqual([
      {
        field: 'model',
        requested: 'claude-sonnet-5:xhigh',
        actual: 'claude-sonnet-4-6:xhigh',
      },
    ]);
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
    // EI-153 addressing: the payload must NAME its addressee. Without `ownerId`
    // the receiving host's misdelivery guard abstains (its predicate is
    // `msg.ownerId != null && msg.ownerId !== ownerId`), so a stale or
    // mis-resolved socket silently accepts another agent's turn. Asserting the
    // field here is what keeps this path from regressing back to unaddressed.
    expect(inject).toHaveBeenCalledWith(`/run/psu-pty/${OWNER}.sock`, {
      mode: 'turn',
      data: 'pick up where you left off',
      ownerId: OWNER,
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

describe('verifyResumeStarted (resume liveness is three-state)', () => {
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

  it('refuses a live owner host whose backend resumed a different native UUID', async () => {
    const r = await verifyResumeStarted(OWNER, {
      expectedSessionId: 'later-rollout-uuid',
      findHost: () => ({
        ownerId: OWNER,
        pid: 42,
        sock: `/run/psu-pty/${OWNER}.sock`,
        command: 'codex',
        args: ['--model', 'gpt-5.6-sol', 'resume', 'older-root-uuid'],
      }) as never,
    });

    expect(r).toMatchObject({
      started: false,
      mismatch: true,
      expectedSessionId: 'later-rollout-uuid',
      actualSessionId: 'older-root-uuid',
    });
  });

  // EI-21476169071856015: a healthy exact Codex resume registered more than seven
  // minutes after the 30s verifier refused it. No host inside a bounded window is
  // absence of evidence, not an observed no-op.
  it('reports started:null when no live host appears before the deadline', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const r = await verifyResumeStarted(OWNER, {
      findHost: () => null,
      sleep,
      pollMs: 10,
      timeoutMs: 35,
    });

    expect(r.started).toBeNull();
    expect(r.waitedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('nativeSessionIdFromHost', () => {
  it('reads Codex positional resume and Claude/OMP resume flags', () => {
    expect(nativeSessionIdFromHost({ command: 'codex', args: ['-m', 'gpt-5.6-sol', 'resume', 'codex-uuid'] })).toBe('codex-uuid');
    expect(nativeSessionIdFromHost({ command: 'claude', args: ['--resume', 'claude-uuid'] })).toBe('claude-uuid');
    expect(nativeSessionIdFromHost({ command: 'omp', args: ['--resume-session=omp-uuid'] })).toBe('omp-uuid');
  });

  it('returns null when the host does not attest a native resume id', () => {
    expect(nativeSessionIdFromHost({ command: 'codex', args: ['--model', 'gpt-5.6-sol'] })).toBeNull();
    expect(nativeSessionIdFromHost({ command: 'codex' })).toBeNull();
    expect(nativeSessionIdFromHost({ command: 'codex', args: ['resume', '--last'] })).toBeNull();
  });
});

describe('guarded visible restoration', () => {
  it('permits shutdown only with a positive dead-window witness', () => {
    expect(restoreVisibleMayShutdown('dead')).toBe(true);
    expect(restoreVisibleMayShutdown('alive')).toBe(false);
    expect(restoreVisibleMayShutdown('unknown')).toBe(false);
    expect(restoreVisibleMayShutdown('not-a-window')).toBe(false);
  });

  it('waits for the exact old host to disappear before relaunching', async () => {
    const findHost = vi.fn().mockReturnValueOnce({ pid: 1 }).mockReturnValueOnce({ pid: 1 }).mockReturnValue(null);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitForPtyHostGone(OWNER, { findHost: findHost as never, sleep, pollMs: 1, timeoutMs: 100 })).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the old host never disappears', async () => {
    await expect(waitForPtyHostGone(OWNER, {
      findHost: (() => ({ pid: 1 })) as never,
      sleep: vi.fn().mockResolvedValue(undefined),
      pollMs: 10,
      timeoutMs: 25,
    })).resolves.toBe(false);
  });
});

describe('stale headless recovery guard', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');

  it('only marks an explicitly agent-launched headless host stale after measured idle time', () => {
    expect(
      isStaleHeadlessAgentHost(
        {
          bridgeTty: false,
          launchedBy: 'su-launcher',
          lastActivityAt: now - 31 * 60_000,
        },
        { now },
      ),
    ).toBe(true);
    expect(
      isStaleHeadlessAgentHost(
        {
          bridgeTty: false,
          launchedBy: 'su-launcher',
          lastOutputAt: now - 31 * 60_000,
          lastInputAt: now - 2 * 60_000,
        },
        { now },
      ),
    ).toBe(false);
  });

  it('fails closed for unknown provenance/activity and interactive or recent hosts', () => {
    const stale = now - 31 * 60_000;
    expect(isStaleHeadlessAgentHost({ bridgeTty: false, lastActivityAt: stale }, { now })).toBe(false);
    expect(isStaleHeadlessAgentHost({ bridgeTty: false, launchedBy: 'su-launcher' }, { now })).toBe(false);
    expect(isStaleHeadlessAgentHost({ bridgeTty: true, launchedBy: 'su-launcher', lastActivityAt: stale }, { now })).toBe(false);
    expect(isStaleHeadlessAgentHost({ bridgeTty: false, launchedBy: 'su-launcher', lastActivityAt: now - 5 * 60_000 }, { now })).toBe(false);
  });
});
