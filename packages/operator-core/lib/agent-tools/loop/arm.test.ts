/**
 * arm.test.ts — the loop:arm handler, focused on the WI-1471 owner-override fix:
 * an explicit `ownerId` arg should be honored (mirroring loop:end/loop:status),
 * instead of always binding to resolveAgentIdentity(ctx)'s resolved identity —
 * which, for a client-less caller (e.g. a ptool/curl bridge over the superuser
 * transport with no per-session id), silently falls back to the non-wake-reachable
 * `su-loopback` fixed identity.
 *
 * Everything downstream of identity resolution is mocked so the assertions are
 * purely about WHICH ownerId every downstream call receives.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/arm.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { LOOPS: 'papercusp-loops' } }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-caller-own-id',
    ownerLabel: 'su · caller',
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../../hive/wake', () => ({ resolveHiveHomeSlug: vi.fn(() => 'papercusp') }));
vi.mock('../../harness/routines/loop', () => ({
  LOOP_INTERVAL_FLOOR_SEC: 60,
  buildLoopWakePrompt: vi.fn(() => 'kickoff-prompt'),
  materializeLoop: vi.fn(async () => ({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') })),
  // WI-2429 fix A: goal auto-detect of the driven work-item (cold-only). Default null
  // (no id) so the WI-1471 identity tests below are unaffected; per-test override sets it.
  detectDrivenWorkItemId: vi.fn(() => null),
}));
// WI-2429 fix A: the arm-time auto-claim of the loop's driven work-item.
vi.mock('../../work-items', () => ({
  claimWorkItem: vi.fn(async () => null),
  classifyClaimFailure: vi.fn(() => ({ reason: 'gated', holder: null })),
  getWorkItem: vi.fn(async () => null),
}));
vi.mock('../../events/await/inbox-wake-arm', () => ({ armInboxWake: vi.fn(async () => undefined) }));
vi.mock('../../events/await/wake-reachability', () => ({
  probeWakeReachability: vi.fn(async () => ({ reachable: true, channel: 'inject', durableWhileAlive: true, summary: 'ok' })),
}));

import { materializeLoop, buildLoopWakePrompt, detectDrivenWorkItemId } from '../../harness/routines/loop';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { probeWakeReachability } from '../../events/await/wake-reachability';

const materializeM = vi.mocked(materializeLoop);
const buildPromptM = vi.mocked(buildLoopWakePrompt);
const detectM = vi.mocked(detectDrivenWorkItemId);
const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getWiM = vi.mocked(getWorkItem);
const armWakeM = vi.mocked(armInboxWake);
const probeM = vi.mocked(probeWakeReachability);
const tool = (await import('./arm')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ intervalSec: 120, goal: 'g', ...args } as never, { harnessSlug: 'papercusp' } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') } as never);
  probeM.mockResolvedValue({ reachable: true, channel: 'inject', durableWhileAlive: true, summary: 'ok' } as never);
  // WI-2429 defaults: no goal-detected id, claim returns null (unheld → re-read path).
  detectM.mockReturnValue(null as never);
  claimM.mockResolvedValue(null as never);
  classifyM.mockReturnValue({ reason: 'gated', holder: null } as never);
  getWiM.mockResolvedValue(null as never);
});

describe('loop:arm — WI-1471 ownerId override', () => {
  it('defaults to the caller\'s own resolved identity when ownerId is omitted', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: true, loop: { ownerId: 'su-caller-own-id', ownerLabel: 'su · caller' } });
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-caller-own-id' }));
    expect(armWakeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-caller-own-id' }));
    expect(probeM).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('honors an explicit ownerId — arms the loop FOR that owner, not the caller', async () => {
    const b = body(await call({ ownerId: 'su-target-other-session' }));
    expect(b).toMatchObject({ ok: true, loop: { ownerId: 'su-target-other-session' } });
    // shortOwnerLabel truncates a non-'pus-' id to 8 chars (cosmetic-only, per its docstring).
    expect(b.loop.ownerLabel).toBe('su · su-targe');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-target-other-session' }));
    expect(armWakeM).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-target-other-session' }));
    expect(probeM).toHaveBeenCalledWith('su-target-other-session');
  });

  it('never binds to su-loopback when an explicit ownerId is given — the WI-1471 regression case', async () => {
    // resolveAgentIdentity mock always returns 'su-caller-own-id' here, but a
    // client-less bridge would resolve SUPERUSER_FALLBACK_CLIENT_ID ('su-loopback')
    // instead — the override must win regardless of what identity resolved to.
    const b = body(await call({ ownerId: 'su-real-target' }));
    expect(b.loop.ownerId).not.toBe('su-loopback');
    expect(b.loop.ownerId).toBe('su-real-target');
  });

  it('the kickoff prompt is built for the OVERRIDDEN owner, not the caller', async () => {
    const { buildLoopWakePrompt } = await import('../../harness/routines/loop');
    await call({ ownerId: 'su-target-other-session' });
    expect(vi.mocked(buildLoopWakePrompt)).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-target-other-session' }),
    );
  });
});

describe('loop:arm — WI-2429 fix A: auto-claim the driven work-item at arm time', () => {
  const claimedRow = { id: 'X', assignee: 'su-caller-own-id' };

  it('claims an EXPLICIT workItem for the loop owner (any carry) and names it in the wake prompt', async () => {
    claimM.mockResolvedValue(claimedRow as never);
    const b = body(await call({ workItem: 'WI-42' }));
    expect(claimM).toHaveBeenCalledWith('WI-42', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b).toMatchObject({ ok: true, loop: { workItem: 'WI-42' }, workItemClaim: { id: 'WI-42', claimed: true } });
    expect(b.note).toContain('Auto-claimed work-item WI-42');
    // the held id is passed to the wake-prompt builder so the mandate is concrete
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: 'WI-42' }));
  });

  it('normalizes an explicit lower-case id to the canonical upper-case before claiming', async () => {
    claimM.mockResolvedValue(claimedRow as never);
    await call({ workItem: 'wi-42' });
    expect(claimM).toHaveBeenCalledWith('WI-42', 'su-caller-own-id', { harness: 'papercusp' });
  });

  it('on a COLD loop with no explicit workItem, auto-detects + claims the id from the goal', async () => {
    detectM.mockReturnValue('WI-7' as never);
    claimM.mockResolvedValue(claimedRow as never);
    const b = body(await call({ carry: 'cold', goal: 'root-cause WI-7' }));
    expect(detectM).toHaveBeenCalledWith('root-cause WI-7');
    expect(claimM).toHaveBeenCalledWith('WI-7', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b.loop.workItem).toBe('WI-7');
  });

  it('does NOT auto-detect from the goal on a WARM loop — warm behaviour stays byte-identical', async () => {
    detectM.mockReturnValue('WI-7' as never);
    const b = body(await call({ carry: 'warm', goal: 'root-cause WI-7' }));
    expect(detectM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
    expect(b.loop.workItem).toBeNull();
    expect(b.workItemClaim).toBeNull();
  });

  it('a claim_conflict is NON-FATAL: the loop still arms, the prompt is NOT told "you hold it", and the holder is surfaced', async () => {
    claimM.mockResolvedValue(null as never); // compare-and-claim lost
    getWiM.mockResolvedValue({ id: 'WI-HELD', assignee: 'peer' } as never);
    classifyM.mockReturnValue({ reason: 'conflict', holder: 'peer' } as never);
    const b = body(await call({ workItem: 'WI-HELD' }));
    expect(b.ok).toBe(true); // armed regardless
    expect(b.loop.workItem).toBeNull(); // we do NOT hold it
    expect(b.workItemClaim).toMatchObject({ id: 'WI-HELD', claimed: false, reason: 'claim_conflict', holder: 'peer' });
    expect(b.note).toContain('already held by peer');
    // a conflicted candidate must NOT be named as held in the wake prompt
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('a claim throwing is swallowed — arming never fails on the best-effort claim leg', async () => {
    claimM.mockRejectedValue(new Error('db down') as never);
    const b = body(await call({ workItem: 'WI-99' }));
    expect(b.ok).toBe(true);
    expect(b.loop.workItem).toBeNull();
    expect(b.workItemClaim).toMatchObject({ id: 'WI-99', claimed: false });
    expect(b.workItemClaim.reason).toContain('db down');
  });
});

describe('loop:arm — flag gate + harness resolution (unaffected by the ownerId change)', () => {
  it('returns loops_disabled when the feature flag is off', async () => {
    const { getFlag } = await import('@papercusp/flags/server');
    vi.mocked(getFlag).mockResolvedValueOnce(false as never);
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, error: 'loops_disabled' });
    expect(materializeM).not.toHaveBeenCalled();
  });

  it('fails loud with no_harness when neither args.harness nor ctx.harnessSlug nor a home hive resolves', async () => {
    const { resolveHiveHomeSlug } = await import('../../hive/wake');
    vi.mocked(resolveHiveHomeSlug).mockReturnValueOnce(null as never);
    const out = await tool.handler({ intervalSec: 120, goal: 'g' } as never, {} as never) as Out;
    const b = body(out);
    expect(b).toMatchObject({ ok: false, error: 'no_harness' });
  });
});
