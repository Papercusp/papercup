/**
 * Unit tests for fleet:respawn-member (P-008). The shared resolveFleetMemberTarget and the two
 * DELEGATED tools (fleet:kill, capability:launch-agent) are mocked, so this verifies the
 * orchestration — the required-field guard, kill-before-launch ordering, the abort-if-kill-fails
 * safety (never double-run a lane), the two DIFFERENT delegate result shapes (kill → { data:{counts} },
 * launch → text + isError), and the declarative MemberSpec handed to the relaunch. No real
 * kill/launch ever runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveFleetMemberTarget = vi.fn();
const killHandler = vi.fn();
const launchHandler = vi.fn();

const LEADER = 'su-leader';
const MEMBER = 'su-member-abc';
const SLUG = 'rocket';

vi.mock('./member-target', () => ({
  resolveFleetMemberTarget: (...a: unknown[]) => resolveFleetMemberTarget(...a),
}));
vi.mock('../fleet/kill', () => ({ default: { handler: (...a: unknown[]) => killHandler(...a) } }));
vi.mock('../capability/launch-agent', () => ({ default: { handler: (...a: unknown[]) => launchHandler(...a) } }));
vi.mock('./_shared', () => ({
  ROUTING_LADDER: 'ladder',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
}));

import tool from './respawn-member';

function parse(res: unknown) {
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}

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
