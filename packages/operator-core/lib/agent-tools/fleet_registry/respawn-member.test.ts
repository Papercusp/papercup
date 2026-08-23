/**
 * Unit tests for fleet:respawn-member (P-008). The shared resolveFleetMemberTarget and the two
 * DELEGATED tools (fleet:kill, capability:launch-agent) are mocked, so this verifies the
 * orchestration — the required-field guard, kill-before-launch ordering, the abort-if-kill-fails
 * safety (never double-run a lane), the two DIFFERENT delegate result shapes (kill → { data:{counts} },
 * launch → text + isError), the declarative MemberSpec handed to the relaunch, and — WI-6936 — the
 * post-launch roster verification that stops a spawned-but-dead CLI reporting as a live member.
 * EI-20184677448862558 also covers the idempotent already-dead/not_found kill precondition.
 * No real kill/launch ever runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveFleetMemberTarget = vi.fn();
const killHandler = vi.fn();
const launchHandler = vi.fn();
const listFleetPresence = vi.fn();
const resolveSavedFleetLaunchSpec = vi.fn();

const LEADER = 'su-leader';
const MEMBER = 'su-member-abc';
const SLUG = 'rocket';

vi.mock('./member-target', () => ({
  resolveFleetMemberTarget: (...a: unknown[]) => resolveFleetMemberTarget(...a),
}));
vi.mock('../fleet/kill', () => ({ default: { handler: (...a: unknown[]) => killHandler(...a) } }));
vi.mock('../capability/launch-agent', () => ({ default: { handler: (...a: unknown[]) => launchHandler(...a) } }));
vi.mock('../coordination/presence-fleet', () => ({
  listFleetPresence: (...a: unknown[]) => listFleetPresence(...a),
}));
vi.mock('./saved-launch-spec', () => ({
  resolveSavedFleetLaunchSpec: (...a: unknown[]) => resolveSavedFleetLaunchSpec(...a),
}));
vi.mock('./_shared', () => ({
  ROUTING_LADDER: 'ladder',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
}));

import tool, { awaitReplacementMember } from './respawn-member';

const row = (ownerId: string, heartbeatAgoMs = 0) => ({
  ownerId,
  startedAt: new Date(Date.now() - 60_000),
  heartbeatAt: new Date(Date.now() - heartbeatAgoMs),
});

function parse(res: unknown) {
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}

describe('fleet:respawn-member — ambient workspace transaction safety (EI-20215222062407258)', () => {
  it('opts out because drain/launch/heartbeat verification can await beyond the idle tx timeout', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveFleetMemberTarget.mockResolvedValue({
    ok: true,
    callerId: LEADER,
    workspaceId: 'ws',
    identity: { ownerId: LEADER },
    slug: SLUG,
    fleet: { fleetSlug: SLUG, leaderOwnerId: LEADER },
    memberOwnerId: MEMBER,
    memberRole: 'member',
    invokedAs: 'leader',
  });
  // fleet:kill → bulk envelope { data: { ok, results, counts } }
  killHandler.mockResolvedValue({ data: { ok: true, results: [{ ok: true, target: MEMBER }], counts: { ok: 1, failed: 0 } } });
  // capability:launch-agent → human-readable text + (optional) isError
  launchHandler.mockResolvedValue({ content: [{ type: 'text', text: `Launched su-new into ${SLUG}` }] });
  // Roster: the old member before the kill, a NEW live owner once the replacement has booted.
  // mockReset (not clearAllMocks) — a leftover `once` value would be consumed by the verification
  // poll instead of the snapshot, and the test would then really wait out the 90s window.
  listFleetPresence.mockReset();
  listFleetPresence
    .mockResolvedValueOnce([row(LEADER), row(MEMBER)])
    .mockResolvedValue([row(LEADER), row('su-new-xyz')]);
  resolveSavedFleetLaunchSpec.mockReset();
  resolveSavedFleetLaunchSpec.mockImplementation(async (opts: { requested?: Record<string, unknown>; reusePath: string }) => {
    const member: Record<string, unknown> = {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      account: 'default',
      headless: true,
      carry: 'warm',
      contextSize: 'trimmed',
      role: 'su',
    };
    for (const [field, value] of Object.entries(opts.requested ?? {})) {
      if (value !== undefined) member[field] = value;
    }
    return {
      ok: true,
      found: true,
      target: 16,
      config: {
        plan: 'byoc-plan',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        account: 'default',
        headless: true,
        carry: 'warm',
        contextSize: 'trimmed',
        role: 'su',
      },
      saved: { plan: 'byoc-plan', harness: 'papercusp', member: { ...member } },
      effective: { plan: 'byoc-plan', harness: 'papercusp', member },
      preservedFields: ['plan', 'harness', 'carry', 'role'],
      overrides: [],
      provenance: {
        source: 'fleet:headcount-target',
        workspaceId: 'ws',
        fleetSlug: SLUG,
        target: 16,
      },
      reusePath: opts.reusePath,
    };
  });
});

describe('fleet:respawn-member (P-008)', () => {
  it('kills the old member then fresh-launches the replacement with the new declarative spec', async () => {
    const res = await tool.handler(
      { member: MEMBER, model: 'opus[1m]', effort: 'high', compactionLimit: 200_000 } as never,
      {} as never,
    );
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, fleet: SLUG, oldMember: MEMBER, invokedAs: 'leader' });
    expect(p.changed).toEqual(expect.arrayContaining(['model', 'effort', 'compactionLimit']));
    expect(resolveSavedFleetLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ memberOwnerId: MEMBER, fleetSlug: SLUG, workspaceId: 'ws' }),
    );
    // kill happened, targeting the old member
    expect(killHandler).toHaveBeenCalledWith(expect.objectContaining({ owner: MEMBER, close_terminal: true }), expect.anything());
    // launch into the SAME fleet with the new MemberSpec (declarative path)
    expect(launchHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        fleet: SLUG,
        count: 1,
        members: [expect.objectContaining({ model: 'opus[1m]', effort: 'high', compactionLimit: 200_000, brief: expect.any(String) })],
      }),
      expect.anything(),
    );
    expect(p.launched).toContain('Launched su-new');
  });

  it('ABORTS (no relaunch) when the kill fails — never double-runs the lane', async () => {
    killHandler.mockResolvedValue({ data: { ok: true, results: [{ ok: false, target: MEMBER, error: 'no host' }], counts: { ok: 0, failed: 1 } } });
    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'kill_failed' });
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('relaunches when the known member is already dead and kill returns not_found', async () => {
    killHandler.mockResolvedValue({
      data: {
        ok: true,
        results: [{ ok: false, target: MEMBER, code: 'not_found', error: 'already dead' }],
        counts: { ok: 0, failed: 1 },
      },
    });
    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: true, drainOutcome: 'already-dead' });
    expect(launchHandler).toHaveBeenCalledTimes(1);
  });

  it('reports the down-a-member failure when the relaunch fails after a successful kill', async () => {
    launchHandler.mockResolvedValue({ content: [{ type: 'text', text: 'launch failed: no capacity' }], isError: true });
    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);
    expect(p.ok).toBe(false);
    expect(p.message).toMatch(/down one member/);
    expect(killHandler).toHaveBeenCalledTimes(1); // the kill DID happen
  });

  it('refuses when no boot-baked setting is passed (nothing to respawn)', async () => {
    const res = await tool.handler({ member: MEMBER, brief: 'hi' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'nothing_to_respawn' });
    expect(resolveFleetMemberTarget).not.toHaveBeenCalled();
    expect(killHandler).not.toHaveBeenCalled();
  });

  it('propagates a member-target authorization refusal', async () => {
    resolveFleetMemberTarget.mockResolvedValue({ ok: false, error: 'not_authorized', message: 'not the leader', fleet: SLUG });
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(killHandler).not.toHaveBeenCalled();
  });

  it('defaults the replacement brief when none is given', async () => {
    await tool.handler({ member: MEMBER, account: 'auto' } as never, {} as never);
    const launchArgs = launchHandler.mock.calls[0][0] as { members: { brief: string }[] };
    expect(launchArgs.members[0].brief).toMatch(/respawned/i);
  });
});

/**
 * WI-6936: capability:launch-agent returns once it has spawned the member's TERMINAL, whose
 * wrapper script ends in `exec "$SHELL" -l` — so a CLI that dies before its first turn leaves a
 * live pid, a live terminal, and no agent, while the launcher reports success. Only a new
 * coord_presence row proves an agent booted, so the respawn's `ok` must ride on that, not on the
 * launcher's return value.
 */
describe('fleet:respawn-member replacement verification (WI-6936)', () => {
  it('reports verified with the NEW owner-id once it appears in the roster', async () => {
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: true, newMember: 'su-new-xyz' });
    // the pre-kill snapshot is what makes the new owner identifiable
    expect(listFleetPresence).toHaveBeenCalledWith('ws', SLUG);
  });

  it('FAILS the respawn when the launcher succeeded but no new member ever appears', async () => {
    listFleetPresence.mockReset();
    listFleetPresence.mockResolvedValue([row(LEADER), row(MEMBER)]);
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]', verifySec: 1 } as never, {} as never);
    const p = parse(res);
    expect(p.ok).toBe(false);
    expect(p.verified).toBe(false);
    expect(p.message).toMatch(/never appeared in the fleet roster/);
    expect((res as { isError?: boolean }).isError).toBe(true);
    // the launch itself did NOT error — the failure is the missing agent, not the launcher
    expect(p.launched).toContain('Launched su-new');
  });

  it('does NOT count a pre-existing member as the replacement', async () => {
    listFleetPresence.mockReset();
    listFleetPresence.mockResolvedValue([row(LEADER), row(MEMBER)]);
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]', verifySec: 1 } as never, {} as never);
    expect(parse(res).verified).toBe(false);
  });

  it('verifySec:0 returns unverified with the probe to run, never a bare ok', async () => {
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]', verifySec: 0 } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: false, verification: 'skipped' });
    expect(p.message).toMatch(/NOT verified/);
    expect(p.message).toMatch(/leader-brief/);
  });

  it('degrades to unverified (not a false success) when the roster cannot be read', async () => {
    listFleetPresence.mockReset();
    listFleetPresence.mockRejectedValue(new Error('pg down'));
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: false, verification: 'unavailable' });
  });

  it('leaves the launch-failed path reporting unverified too', async () => {
    launchHandler.mockResolvedValue({ content: [{ type: 'text', text: 'launch failed' }], isError: true });
    const p = parse(await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never));
    expect(p).toMatchObject({ ok: false, verified: false });
  });
});

describe('awaitReplacementMember', () => {
  const nowFn = () => 1_000_000;

  it('returns the first NEW owner with a fresh heartbeat', async () => {
    const res = await awaitReplacementMember({
      before: new Set(['a']),
      list: async () => [
        { ownerId: 'a', startedAt: new Date(nowFn()), heartbeatAt: new Date(nowFn()), lastToolCallAt: null },
        { ownerId: 'b', startedAt: new Date(nowFn()), heartbeatAt: new Date(nowFn()), lastToolCallAt: null },
      ],
      timeoutMs: 10_000,
      now: nowFn,
    });
    expect(res).toMatchObject({ verified: true, newMemberOwnerId: 'b' });
  });

  it('ignores a new owner whose heartbeat is stale (a corpse row, not a live agent)', async () => {
    let t = nowFn();
    const res = await awaitReplacementMember({
      before: new Set(['a']),
      list: async () => [
        { ownerId: 'b', startedAt: new Date(0), heartbeatAt: new Date(nowFn() - 600_000), lastToolCallAt: null },
      ],
      timeoutMs: 5_000,
      intervalMs: 1_000,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    });
    expect(res.verified).toBe(false);
    expect(res.rosterOwnerIds).toEqual(['b']);
  });

  it('keeps polling through a transient roster read failure instead of failing the respawn', async () => {
    let call = 0;
    const times = [0, 1_000, 2_000];
    const res = await awaitReplacementMember({
      before: new Set(['a']),
      list: async () => {
        call += 1;
        if (call === 1) throw new Error('transient');
        return [
          { ownerId: 'b', startedAt: new Date(0), heartbeatAt: new Date(times[call - 1] ?? 0), lastToolCallAt: null },
        ];
      },
      timeoutMs: 10_000,
      intervalMs: 1_000,
      now: () => times[Math.min(call, times.length - 1)] ?? 0,
      sleep: async () => {},
    });
    expect(res).toMatchObject({ verified: true, newMemberOwnerId: 'b' });
    expect(call).toBe(2);
  });

  it('stops at the deadline rather than overrunning it', async () => {
    let t = 0;
    const sleep = vi.fn(async (ms: number) => { t += ms; });
    const res = await awaitReplacementMember({
      before: new Set<string>(),
      list: async () => [],
      timeoutMs: 5_000,
      intervalMs: 1_000,
      now: () => t,
      sleep,
    });
    expect(res.verified).toBe(false);
    // sleeps at t=0,1000,2000,3000,4000 → t=5000; the next poll would overrun the 5s budget
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(res.waitedMs).toBeLessThanOrEqual(5_000);
  });
});
