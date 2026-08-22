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

// `onFlagChange` is required even though this suite never exercises it: importing
// locks/configure.ts pulls in txn-timeouts-config.ts, which calls onFlagChange() at
// MODULE SCOPE (D-010 event-driven refresh). A mock omitting it fails the whole file
// at COLLECTION with `No "onFlagChange" export is defined`, i.e. 0 tests run.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async () => true),
  onFlagChange: vi.fn(),
}));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    LOOPS: 'papercusp-loops',
    HEADLESS_LOOPS_COLD_BY_DEFAULT: 'papercusp-headless-loops-cold-by-default',
    SCOPED_SUPERUSER_CLAMP: 'papercusp-scoped-superuser-clamp',
  },
}));
// EI-19966210024116714: arm.ts reaches harness-core ONLY via a dynamic import inside the
// cross-workspace guard, which is itself gated on a CLAMPED superuser ctx — so this mock is
// never touched by any test that does not opt in with ctx.isSuperuser.
vi.mock('../../harness-core', () => ({ resolveWorkspaceForHarnessSlugIn: vi.fn(async () => null) }));
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
vi.mock('../../pot/wake', () => ({ resolvePotHomeSlug: vi.fn(() => 'papercusp') }));
vi.mock('../pot/_resolve', () => ({ resolveHomePotSlug: vi.fn(async () => 'papercusp') }));
vi.mock('../../session-brief', () => ({ getSessionBrief: vi.fn(async () => null) }));
vi.mock('../../harness/routines/loop', () => ({
  LOOP_INTERVAL_FLOOR_SEC: 60,
  buildLoopWakePrompt: vi.fn(() => 'kickoff-prompt'),
  materializeLoop: vi.fn(async () => ({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') })),
  // WI-2429 fix A: goal auto-detect of the driven work-item (cold-only). Default null
  // (no id) so the WI-1471 identity tests below are unaffected; per-test override sets it.
  detectDrivenWorkItemId: vi.fn(() => null),
  // EI-18221784742583615: the arm-time overwrite-guard read of the prior loop. Default null
  // (no prior loop) so every existing test is unaffected; per-test override sets a prior.
  readActiveLoopFacts: vi.fn(async () => null),
}));
// WI-2429 fix A: the arm-time auto-claim of the loop's driven work-item.
vi.mock('../../work-items', () => ({
  claimWorkItem: vi.fn(async () => null),
  classifyClaimFailure: vi.fn(() => ({ reason: 'gated', holder: null })),
  getWorkItem: vi.fn(async () => null),
}));
// EI-20123870155538062: loop:arm shares the by-id fleet-scope admission seam with
// work_items:claim. Keep the arm tests DB-free while pinning the ordering contract.
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => ({ allowed: true, scoped: false })),
}));
vi.mock('../../events/await/inbox-wake-arm', () => ({ armInboxWake: vi.fn(async () => undefined) }));
// EI-19447204017443244: the arm-time live-wake-await lookup behind the cap message.
// Defaults to EMPTY so every pre-existing handler test keeps its exact prior wording.
vi.mock('../../events/await/store', () => ({
  listWakeAwaitsForSubscriber: vi.fn(async () => [] as Array<{ eventKey: string }>),
}));
vi.mock('../../events/await/wake-reachability', () => ({
  probeWakeReachability: vi.fn(async () => ({
    reachable: true,
    channel: 'psu-socket',
    durableWhileAlive: true,
    summary: 'ok',
    awaitRepairable: false,
    wouldBeChannel: null,
  })),
}));
// EI-6878: @papercusp/db-org is a big package (transitively required by other
// bootstrap code in this import graph via @papercusp/agent-mcp) — partial-mock it
// via importOriginal so only isParkedNextFire is overridden and everything else
// (incl. `generated`) stays real. Same getTime()-equality contract the real
// isParkedNextFire uses, just against a locally-defined sentinel so this test
// doesn't depend on the exact NEXT_FIRE_PARKED value staying byte-identical.
const NEXT_FIRE_PARKED_FOR_TEST = new Date(8_640_000_000_000_000);
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isParkedNextFire: (d: Date | null) => d instanceof Date && d.getTime() === NEXT_FIRE_PARKED_FOR_TEST.getTime(),
  };
});

// B (cold-with-carry-activation-2026-07-20): findLiveHost drives the headless carry
// default. Mock it (default null ⇒ warm, so the WI-1471 identity tests are unchanged)
// with the REAL sessionClassForHost logic so per-test hosts classify correctly.
vi.mock('../../events/await/psu-pty-discovery', () => ({
  findLiveHost: vi.fn(() => null),
  sessionClassForHost: (host: { bridgeTty?: boolean } | null | undefined) =>
    host?.bridgeTty === false ? 'claude-headless' : 'claude-interactive',
}));

import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  readActiveLoopFacts,
} from '../../harness/routines/loop';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
import { admitWorkItemForFleetTarget } from '../../scheduler/fleet-scope-admission';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { probeWakeReachability } from '../../events/await/wake-reachability';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
import { resolveHomePotSlug } from '../pot/_resolve';
import { decideDefaultCarry, computeLoopOverwriteNote, resolveBlockedBackoff } from './arm';
import { mockResolvedOnceTyped, mockResolvedTyped, mockReturnOnceTyped, mockReturnTyped } from '../../testing/typed-mock';

const materializeM = vi.mocked(materializeLoop);
const buildPromptM = vi.mocked(buildLoopWakePrompt);
const detectM = vi.mocked(detectDrivenWorkItemId);
const priorLoopM = vi.mocked(readActiveLoopFacts);
const claimM = vi.mocked(claimWorkItem);
const classifyM = vi.mocked(classifyClaimFailure);
const getWiM = vi.mocked(getWorkItem);
const admitM = vi.mocked(admitWorkItemForFleetTarget);
const armWakeM = vi.mocked(armInboxWake);
const probeM = vi.mocked(probeWakeReachability);
const findHostM = vi.mocked(findLiveHost);
const homePotM = vi.mocked(resolveHomePotSlug);
const briefM = vi.mocked((await import('../../session-brief')).getSessionBrief);
const potHomeM = vi.mocked((await import('../../pot/wake')).resolvePotHomeSlug);
const wakeAwaitsM = vi.mocked((await import('../../events/await/store')).listWakeAwaitsForSubscriber);
// EI-19966210024116714: hoisted to module scope — `await import` is illegal inside a
// (non-async) describe callback, and this file's describes are synchronous.
const resolveWsM = vi.mocked((await import('../../harness-core')).resolveWorkspaceForHarnessSlugIn);
const tool = (await import('./arm')).default;

describe('loop:arm — ambient workspace transaction safety (EI-20224334803038640)', () => {
  it('opts out because the handler owns its independent DB scopes', () => {
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) =>
  tool.handler({ intervalSec: 120, goal: 'g', ...args } as never, { harnessSlug: 'papercusp' } as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') } as never);
  mockResolvedTyped(probeM, {
    reachable: true,
    channel: 'psu-socket',
    durableWhileAlive: true,
    summary: 'ok',
    awaitRepairable: false,
    wouldBeChannel: null,
  });
  // WI-2429 defaults: no goal-detected id, claim returns null (unheld → re-read path).
  mockReturnTyped(detectM, null);
  claimM.mockResolvedValue(null as never);
  classifyM.mockReturnValue({ reason: 'gated', holder: null } as never);
  getWiM.mockResolvedValue(null as never);
  mockResolvedTyped(admitM, { allowed: true, scoped: false });
  // EI-18221784742583615: default no prior loop ⇒ no overwrite note (every existing test).
  priorLoopM.mockResolvedValue(null as never);
  // EI-19447204017443244: default no live wake-awaits (the 'none' rendering).
  wakeAwaitsM.mockResolvedValue([] as never);
  homePotM.mockResolvedValue('papercusp');
  briefM.mockResolvedValue(null);
  potHomeM.mockReturnValue('papercusp');
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

describe('loop:arm — WI-5345: mode reaches materializeLoop + the response (previously only threaded into the wake-prompt template, never persisted/observable)', () => {
  it("defaults to mode:'work' when omitted", async () => {
    const b = body(await call({}));
    expect(b.loop.mode).toBe('work');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'work' }));
  });

  it("an explicit mode:'monitor' reaches materializeLoop AND is echoed in the response", async () => {
    const b = body(await call({ mode: 'monitor' }));
    expect(b.loop.mode).toBe('monitor');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ mode: 'monitor' }));
  });
});

describe('loop:arm — EI-20034001963934568: reject unverified owner tags in replayed goals', () => {
  it('refuses a bare [owner:…] goal tag before claiming or materializing the loop', async () => {
    const b = body(await call({ goal: '[owner:Jane 2026-08-10] continue the drain' }));

    expect(b).toMatchObject({ ok: false, error: 'unverified_goal_provenance' });
    expect(b.message).toContain('[turn:<session>@<timestamp>]');
    expect(materializeM).not.toHaveBeenCalled();
    expect(claimM).not.toHaveBeenCalled();
  });

  it('allows the documented placeholder form, which describes the tag syntax rather than asserting attribution', async () => {
    const b = body(await call({ goal: '[owner:<name> <date>] continue the drain' }));

    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalled();
  });

  it('allows a same-line [turn:…] anchor for a real owner tag', async () => {
    const b = body(await call({ goal: '[turn:abc123@2026-08-10T03:27:00Z] [owner:Jane 2026-08-10] continue the drain' }));

    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalled();
  });
});

describe('loop:arm — WI-2429 fix A: auto-claim the driven work-item at arm time', () => {
  const claimedRow = { id: 'X', assignee: 'su-caller-own-id' };

  it('EI-20123870155538062: refuses an out-of-spec auto-claim before mutation, but still arms the loop', async () => {
    mockResolvedTyped(admitM, {
      allowed: false,
      scoped: true,
      code: 'fleet_scope_violation',
      reason: "work-item WI-OUT does not match fleet spec 'fleet-x@rev7'",
      scope: {
        ownerId: 'su-caller-own-id',
        fleetSlug: 'fleet-x',
        fleetRole: 'member',
        workspaceId: 'ws-1',
        record: {
          source: 'fleet',
          spec: {
            specVersion: '1.0',
            specId: 'fleet-x',
            revision: 7,
            view: { filter: { field: 'id', op: 'in', value: ['WI-OUT'] } },
            rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
          },
          revision: 7,
          updatedBy: null,
          updatedAt: null,
          fleetSlug: 'fleet-x',
        },
      },
    });

    const b = body(await call({ workItem: 'WI-OUT' }));

    expect(admitM).toHaveBeenCalledWith({
      target: 'su-caller-own-id',
      workItemId: 'WI-OUT',
      harness: 'papercusp',
      workspaceId: 'ws-1',
    });
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: {
        id: 'WI-OUT',
        claimed: false,
        reason: 'fleet_scope_violation',
        hint: "work-item WI-OUT does not match fleet spec 'fleet-x@rev7'",
      },
    });
    expect(b.note).toContain('fleet admission gate refused');
  });

  it('claims an EXPLICIT workItem for the loop owner (any carry) and names it in the wake prompt', async () => {
    getWiM.mockResolvedValue({ id: 'WI-42', state: 'open', assignee: null } as never);
    claimM.mockResolvedValue(claimedRow as never);
    const b = body(await call({ workItem: 'WI-42' }));
    expect(claimM).toHaveBeenCalledWith('WI-42', 'su-caller-own-id', { harness: 'papercusp' });
    expect(b).toMatchObject({ ok: true, loop: { workItem: 'WI-42' }, workItemClaim: { id: 'WI-42', claimed: true } });
    expect(b.note).toContain('Auto-claimed work-item WI-42');
    // the held id is passed to the wake-prompt builder so the mandate is concrete
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: 'WI-42' }));
  });

  it('normalizes an explicit lower-case id to the canonical upper-case before claiming', async () => {
    getWiM.mockResolvedValue({ id: 'WI-42', state: 'open', assignee: null } as never);
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

  it('refuses a terminal workItem pin without claiming or binding it to the wake prompt', async () => {
    getWiM.mockResolvedValue({ id: 'EI-DONE', state: 'done', assignee: null } as never);
    const b = body(await call({ workItem: 'EI-DONE' }));
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'EI-DONE', claimed: false, reason: 'terminal' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
  });

  it('refuses a terminal workItem discovered from a COLD goal without claiming or binding it to the wake prompt', async () => {
    detectM.mockReturnValue('EI-DONE');
    getWiM.mockResolvedValue({ id: 'EI-DONE', state: 'done', assignee: null } as never);
    const b = body(await call({ carry: 'cold', goal: 'EI-DONE is CLOSED; do not re-litigate it.' }));

    expect(detectM).toHaveBeenCalledWith('EI-DONE is CLOSED; do not re-litigate it.');
    expect(claimM).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      loop: { workItem: null },
      workItemClaim: { id: 'EI-DONE', claimed: false, reason: 'terminal' },
    });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ workItem: null }));
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
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    vi.mocked(resolvePotHomeSlug).mockReturnValueOnce(null as never);
    homePotM.mockResolvedValueOnce(null);
    const out = await tool.handler({ intervalSec: 120, goal: 'g' } as never, {} as never) as Out;
    const b = body(out);
    expect(b).toMatchObject({ ok: false, error: 'no_harness' });
  });

  it('EI-21104346635924603: refuses an explicitly empty harness before unrelated workspace-home fallback', async () => {
    const out = await tool.handler(
      { intervalSec: 120, goal: 'g', harness: '' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    ) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: false, error: 'empty_harness' });
    expect(b.message).toContain('Omit `harness`');
    expect(briefM).not.toHaveBeenCalled();
    expect(priorLoopM).not.toHaveBeenCalled();
    expect(homePotM).not.toHaveBeenCalled();
    expect(materializeM).not.toHaveBeenCalled();
  });

  it('EI-20185529721601434: resolves a workspace-scoped wildcard session to its formal home pot', async () => {
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    homePotM.mockResolvedValueOnce('workspace-home');
    mockReturnOnceTyped(potHomeM, 'workspace-home');
    const out = await tool.handler(
      { intervalSec: 120, goal: 'g' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    ) as Out;
    const b = body(out);
    expect(homePotM).toHaveBeenCalledWith('ws-1');
    expect(b).toMatchObject({ ok: true, loop: { harness: 'workspace-home' } });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'workspace-home' }));
  });

  it('EI-20211399000978706: reuses the concrete harness persisted by coord:orient before workspace-home fallback', async () => {
    mockResolvedOnceTyped(briefM, {
      ownerId: 'su-caller-own-id',
      workspaceId: 'ws-1',
      ownerLabel: 'su · caller',
      source: 'test',
      intent: '',
      currentPlanSlug: null,
      currentFiles: [],
      ambientExcludedRefs: null,
      harnessSlug: 'oriented-harness',
      potSlug: null,
      goalId: null,
      nativeSessionId: null,
      lifecycle: null,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockReturnOnceTyped(potHomeM, 'oriented-harness');
    const out = await tool.handler(
      { intervalSec: 120, goal: 'g' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    ) as Out;
    const b = body(out);
    expect(briefM).toHaveBeenCalledWith({ ownerId: 'su-caller-own-id' });
    expect(homePotM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, loop: { harness: 'oriented-harness' } });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'oriented-harness' }));
  });

  it('EI-20245033088778955: reuses an existing routine install scope through a wildcard tools:invoke context', async () => {
    // A tools:invoke re-dispatch can rebuild the target ctx with harnessSlug='*'.
    // When this is a re-arm of an existing routine, its install_slug is the
    // authoritative scope and must beat the missing workspace-home fallback.
    priorLoopM.mockResolvedValueOnce({ ...priorLoop(), harnessSlug: 'papercusp' } as never);
    briefM.mockResolvedValueOnce(null);
    homePotM.mockResolvedValueOnce(null);
    potHomeM.mockReturnValueOnce('papercusp').mockReturnValue(null as never);

    const out = await tool.handler(
      { intervalSec: 120, goal: 're-arm the existing loop' } as never,
      { harnessSlug: '*', workspaceId: 'ws-1' } as never,
    ) as Out;
    const b = body(out);

    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
    expect(homePotM).not.toHaveBeenCalled();
  });

  // EI-7734 regression: every superuser/operator-scope session sets ctx.harnessSlug='*'
  // (the wildcard sentinel, _harness-scope.ts). A raw `args.harness ?? ctx.harnessSlug ?? …`
  // chain would let that truthy '*' win outright — bypassing resolvePotHomeSlug's own
  // '*'-skip logic entirely — and the wildcard would then get interpolated verbatim into
  // the wake prompt's self-task example (`work_items:create { harness:'*', … }`), which
  // work_items:create's harness resolution rejects (harnessScope throws on the wildcard).
  // The fix routes BOTH args.harness and ctx.harnessSlug THROUGH resolvePotHomeSlug
  // (which skips '*' at each level) rather than `??`-chaining ctx.harnessSlug in first.
  it('EI-7734: routes ctx.harnessSlug through resolvePotHomeSlug\'s \'*\'-skip instead of short-circuiting a raw ?? chain on it', async () => {
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    // Exercise the synchronous fallback path explicitly; normal workspace-scoped
    // calls resolve the formal home pot first (EI-20185529721601434).
    homePotM.mockResolvedValueOnce(null);
    vi.mocked(resolvePotHomeSlug).mockReturnValueOnce('papercusp' as never);
    const out = await tool.handler({ intervalSec: 120, goal: 'g' } as never, { harnessSlug: '*' } as never) as Out;
    const b = body(out);
    // resolvePotHomeSlug must be CALLED with the raw '*' so its own skip logic runs —
    // a pre-fix raw `??` chain would never call it at all (ctx.harnessSlug='*' wins first).
    expect(vi.mocked(resolvePotHomeSlug)).toHaveBeenCalledWith(undefined, '*');
    // The resolved (non-wildcard) harness is what actually arms + what the wake prompt sees —
    // never the raw '*'.
    expect(b).toMatchObject({ ok: true, loop: { harness: 'papercusp' } });
    expect(b.loop.harness).not.toBe('*');
    expect(buildPromptM).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
  });
});

// EI-19966210024116714 — a loop armed against a harness the OWNING SESSION cannot address
// is doomed from `armedAt` and fails SILENTLY: every harness-scoped call its wake contract
// prescribes is refused by the dispatch clamp with `harness_forbidden`, so the agent wakes on
// cadence, errors on every pull, and produces nothing — until the stalled-loops guard disarms
// it (WI-6639) and the claim reaper releases its held items as `reaper:dead`. Observed live
// 2026-08-08/09 across four fleet members who armed on harness 'papercusp' from sessions
// scoped to workspace 'default'; one burned 44 wakes over ~8h and lost a held item to the
// reaper mid-diagnosis. The mismatch is fully determinable at arm time, so refuse there.
describe('loop:arm — EI-19966210024116714: refuse a cross-workspace arm the session could never service', () => {
  const scopedCtx = { harnessSlug: 'papercusp', isSuperuser: true, workspaceId: 'ws-1' };
  const callAs = (ctx: Record<string, unknown>, args: Record<string, unknown> = {}) =>
    tool.handler({ intervalSec: 120, goal: 'g', ...args } as never, ctx as never) as Promise<Out>;

  it('REFUSES when the harness belongs to a different workspace — and arms nothing', async () => {
    resolveWsM.mockResolvedValueOnce('papercusp-workspace' as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({
      ok: false,
      error: 'harness_workspace_mismatch',
      harness: 'papercusp',
      harnessWorkspace: 'papercusp-workspace',
      sessionWorkspace: 'ws-1',
    });
    // The whole point: no durable routine row, so no wake can fire into a doomed loop.
    expect(materializeM).not.toHaveBeenCalled();
  });

  it('the refusal names the concrete consequence, not just the mismatch', async () => {
    resolveWsM.mockResolvedValueOnce('papercusp-workspace' as never);
    const b = body(await callAs(scopedCtx));
    expect(b.message).toContain('harness_forbidden');
    expect(b.message).toContain('reaped as dead');
  });

  it('ARMS NORMALLY when the harness resolves to the session\'s own workspace', async () => {
    resolveWsM.mockResolvedValueOnce('ws-1' as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({ ok: true });
    expect(materializeM).toHaveBeenCalled();
  });

  it('fails OPEN on a resolver THROW — an unreadable registry never blocks a legitimate arm', async () => {
    resolveWsM.mockRejectedValueOnce(new Error('ambiguous cross-workspace collision') as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({ ok: true });
    expect(materializeM).toHaveBeenCalled();
  });

  it('fails OPEN when the harness resolves to NOTHING — absence is not a confirmed foreign resolution', async () => {
    resolveWsM.mockResolvedValueOnce(null as never);
    const b = body(await callAs(scopedCtx));
    expect(b).toMatchObject({ ok: true });
    expect(materializeM).toHaveBeenCalled();
  });

  it('does NOT check an UNSCOPED (\'*\') superuser — spanning workspaces is legitimate there', async () => {
    const b = body(await callAs({ harnessSlug: 'papercusp', isSuperuser: true, workspaceId: '*' }));
    expect(b).toMatchObject({ ok: true });
    expect(resolveWsM).not.toHaveBeenCalled();
  });

  it('does NOT check a NON-superuser session — the clamp that produces the failure does not apply', async () => {
    const b = body(await callAs({ harnessSlug: 'papercusp', workspaceId: 'ws-1' }));
    expect(b).toMatchObject({ ok: true });
    expect(resolveWsM).not.toHaveBeenCalled();
  });
});

describe('loop:arm — EI-6878: firstFireAt must not leak the raw parked-loop sentinel', () => {
  it('a normal (unparked) nextFireAt renders as its real ISO timestamp', async () => {
    materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: new Date('2026-01-01T00:00:00Z') } as never);
    const b = body(await call({}));
    expect(b.loop.firstFireAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a re-arm mid-turn returns the loop row PARKED at the infinity sentinel — renders as the literal string, never the raw +275760 date', async () => {
    materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: NEXT_FIRE_PARKED_FOR_TEST } as never);
    const b = body(await call({}));
    expect(b.loop.firstFireAt).toBe('after-turn-settle');
    expect(b.loop.firstFireAt).not.toContain('275760');
  });

  it('no nextFireAt at all still renders null (unchanged behavior)', async () => {
    materializeM.mockResolvedValue({ name: 'loop-x', nextFireAt: null } as never);
    const b = body(await call({}));
    expect(b.loop.firstFireAt).toBeNull();
  });
});

describe('loop:arm — WI-5557 TIER 1: unbounded warm-carry WORK loop warning (additive, no behavior change)', () => {
  it('warm + work + no maxFires/maxDurationSec (the default arm shape) → warning present in both the note and the structured field', async () => {
    const b = body(await call({}));
    expect(b.ok).toBe(true); // purely additive — arming still succeeds
    expect(b.unboundedWarmLoopWarning).toContain('WI-5557');
    expect(b.unboundedWarmLoopWarning).toMatch(/maxFires|maxDurationSec/);
    expect(b.note).toContain('unattended warm-carry WORK loop');
  });

  it("warm + mode:'monitor' → no warning (a monitor loop is actively watched each wake by contract)", async () => {
    const b = body(await call({ mode: 'monitor' }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
    expect(b.note).not.toContain('unattended warm-carry WORK loop');
  });

  it("carry:'cold' → no warning (cold resets to the carry-note each fire, so context never grows unbounded)", async () => {
    const b = body(await call({ carry: 'cold' }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
    expect(b.note).not.toContain('unattended warm-carry WORK loop');
  });

  it('either dead-man guard set (maxFires) suppresses the warning', async () => {
    const b = body(await call({ maxFires: 20 }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
  });

  it('either dead-man guard set (maxDurationSec) suppresses the warning', async () => {
    const b = body(await call({ maxDurationSec: 3600 }));
    expect(b.unboundedWarmLoopWarning).toBeNull();
  });
});

// B (cold-with-carry-activation-2026-07-20): headless loops default to cold carry.
describe('decideDefaultCarry (pure B decision)', () => {
  const headless = { bridgeTty: false };
  const interactive = { bridgeTty: true };
  it('flag OFF ⇒ warm even for a headless host', () => {
    expect(decideDefaultCarry(false, headless)).toBe('warm');
  });
  it('flag ON + headless host ⇒ cold', () => {
    expect(decideDefaultCarry(true, headless)).toBe('cold');
  });
  it('flag ON + interactive host ⇒ warm (D-005 never-cold-a-human)', () => {
    expect(decideDefaultCarry(true, interactive)).toBe('warm');
  });
  it('flag ON + no live host ⇒ warm (fail-soft)', () => {
    expect(decideDefaultCarry(true, null)).toBe('warm');
  });
});

describe('loop:arm headless carry default (B, through the handler)', () => {
  beforeEach(() => {
    findHostM.mockReturnValue(null); // default: no host ⇒ warm
  });
  it('a HEADLESS caller with no explicit carry materializes the loop COLD + discloses it', async () => {
    findHostM.mockReturnValue({ bridgeTty: false } as never);
    const b = body(await call({}));
    expect(b.loop.carry).toBe('cold');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'cold' }));
    expect(b.note).toContain('COLD carry');
    // a cold loop is not an unbounded-warm loop ⇒ no WI-5557 warning
    expect(b.unboundedWarmLoopWarning).toBeNull();
  });
  it('an INTERACTIVE caller with no explicit carry stays WARM', async () => {
    findHostM.mockReturnValue({ bridgeTty: true } as never);
    const b = body(await call({}));
    expect(b.loop.carry).toBe('warm');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'warm' }));
    expect(b.note).not.toContain('COLD carry');
  });
  it('an EXPLICIT carry:"warm" overrides the headless default', async () => {
    findHostM.mockReturnValue({ bridgeTty: false } as never);
    const b = body(await call({ carry: 'warm' }));
    expect(b.loop.carry).toBe('warm');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'warm' }));
  });
});

// EI-18221784742583615 — arm-time overwrite guard: a stale/replayed fleet-kickoff turn
// silently clobbered an active specialized loop's config. loop:arm now surfaces the prior
// loop when the re-arm materially changes an ACTIVE loop's goal.
const priorLoop = (over: Partial<Parameters<typeof computeLoopOverwriteNote>[0] & object> = {}) => ({
  active: true,
  intervalSec: 1200,
  harnessSlug: null,
  kickoff: 'You are continuing your OWN warm session toward: watch WI-5672 for the next live-fed-gate fire',
  fireCount: 48,
  carry: 'cold' as const,
  mode: 'work' as const,
  armedAt: '2026-07-20T00:00:00.000Z',
  ...over,
});

describe('computeLoopOverwriteNote (pure EI-18221784742583615 decision)', () => {
  const next = { goal: 'drain the generic bug backlog', intervalSec: 120, kickoff: 'new-generic-kickoff' };

  it('null / inactive prior ⇒ no note (a fresh start or re-arm over an ended loop is fine)', () => {
    expect(computeLoopOverwriteNote(null, next)).toBeNull();
    expect(computeLoopOverwriteNote(priorLoop({ active: false }), next)).toBeNull();
  });

  it('identical re-arm (same built kickoff) ⇒ no note, even with an unrelated goal string', () => {
    const prior = priorLoop({ kickoff: 'same-kickoff-text' });
    expect(computeLoopOverwriteNote(prior, { ...next, kickoff: 'same-kickoff-text' })).toBeNull();
    // whitespace/case-insensitive
    expect(computeLoopOverwriteNote(prior, { ...next, kickoff: '  SAME-kickoff-TEXT  ' })).toBeNull();
  });

  it('goal PRESERVED (new goal appears verbatim in the prior kickoff) ⇒ no note — an interval-only retune', () => {
    const prior = priorLoop({ kickoff: 'toward: watch WI-5672 for the next fire', intervalSec: 1200 });
    // same goal, only the interval changed → deliberate retune, not a goal swap
    const note = computeLoopOverwriteNote(prior, {
      goal: 'watch WI-5672 for the next fire',
      intervalSec: 300,
      kickoff: 'toward: watch WI-5672 for the next fire (300s)',
    });
    expect(note).toBeNull();
  });

  it('goal SWAP over an active long-running loop ⇒ a note surfacing the prior config', () => {
    const note = computeLoopOverwriteNote(priorLoop(), next);
    expect(note).not.toBeNull();
    expect(note!.priorIntervalSec).toBe(1200);
    expect(note!.priorFireCount).toBe(48);
    expect(note!.intervalChanged).toBe(true); // 1200s → 120s
    expect(note!.message).toContain('OVERWRITES an already-ACTIVE loop');
    expect(note!.message).toContain('fired 48×');
    expect(note!.message).toContain('1200s → 120s');
    expect(note!.message).toContain('loop:end');
    // the prior kickoff is quoted so the agent can compare goals
    expect(note!.priorKickoffExcerpt).toContain('WI-5672');
  });

  it('interval unchanged but goal swapped ⇒ note with intervalChanged=false and no interval delta text', () => {
    const note = computeLoopOverwriteNote(priorLoop({ intervalSec: 120 }), next);
    expect(note).not.toBeNull();
    expect(note!.intervalChanged).toBe(false);
    expect(note!.message).not.toContain('→');
  });
});

describe('loop:arm — EI-18221784742583615 overwrite guard (through the handler)', () => {
  it('preserves an active marked custom kickoff when wakePrompt is omitted', async () => {
    const customKickoff = 'custom mission-specific wake instruction';
    priorLoopM.mockResolvedValue(
      priorLoop({ goal: 'g', kickoff: customKickoff, customWakePrompt: true }) as never,
    );

    const b = body(await call({}));

    expect(b.ok).toBe(true);
    expect(b.loop.customWakePrompt).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: customKickoff, customWakePrompt: true }),
    );
  });

  it('rebuilds the default kickoff for a legacy row without the marker', async () => {
    const legacyKickoff = 'legacy custom-looking kickoff';
    priorLoopM.mockResolvedValue(priorLoop({ goal: 'g', kickoff: legacyKickoff }) as never);

    const b = body(await call({}));

    expect(b.ok).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: 'kickoff-prompt', customWakePrompt: false }),
    );
    expect(b.loop.customWakePrompt).toBe(false);
  });

  it('marks an explicit wakePrompt custom and passes the marker to materializeLoop', async () => {
    const b = body(await call({ wakePrompt: 'new custom wake instruction' }));

    expect(b.ok).toBe(true);
    expect(b.loop.customWakePrompt).toBe(true);
    expect(materializeM).toHaveBeenCalledWith(
      expect.objectContaining({ kickoff: 'new custom wake instruction', customWakePrompt: true }),
    );
  });

  it('re-arming over an active loop with a DIFFERENT goal surfaces priorLoopOverwrite + a note; the loop still arms', async () => {
    priorLoopM.mockResolvedValue(priorLoop() as never);
    // buildLoopWakePrompt is mocked to 'kickoff-prompt', which the prior kickoff does not
    // contain, and the goal below is not in the prior kickoff → materially different.
    const b = body(await call({ intervalSec: 120, goal: 'drain the generic bug backlog' }));
    expect(b.ok).toBe(true); // purely advisory — arming still succeeds
    expect(materializeM).toHaveBeenCalled(); // the loop was (re-)armed regardless
    expect(b.priorLoopOverwrite).not.toBeNull();
    expect(b.priorLoopOverwrite.priorFireCount).toBe(48);
    expect(b.note).toContain('OVERWRITES an already-ACTIVE loop');
    expect(priorLoopM).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('re-arming with the SAME goal (goal present in the prior kickoff) ⇒ no overwrite note', async () => {
    priorLoopM.mockResolvedValue(
      priorLoop({ kickoff: 'toward: drain the generic bug backlog now' }) as never,
    );
    const b = body(await call({ intervalSec: 120, goal: 'drain the generic bug backlog' }));
    expect(b.priorLoopOverwrite).toBeNull();
    expect(b.note).not.toContain('OVERWRITES an already-ACTIVE loop');
  });

  it('no prior loop ⇒ priorLoopOverwrite null (the default arm shape, unaffected)', async () => {
    const b = body(await call({}));
    expect(b.priorLoopOverwrite).toBeNull();
  });

  it('the overwrite-guard read throwing is swallowed — arming never fails on the advisory leg', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    priorLoopM.mockRejectedValue(new Error('db down') as never);
    const b = body(await call({ goal: 'anything' }));
    expect(b.ok).toBe(true);
    expect(b.priorLoopOverwrite).toBeNull();
    // the failure is logged (best-effort), not surfaced as an error
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prior-loop read failed'));
    warnSpy.mockRestore();
  });
});

// EI-18792078711601844 — a re-arm with `carry` omitted must PRESERVE the loop's prior
// carry (when one is active) instead of silently recomputing a fresh headless/interactive
// default that can legitimately differ (host-discovery flakiness, a flag flip mid-run).
// The playbook's own prescribed remedy for a blocked loop — "re-loop:arm with a larger
// intervalSec" — passes only intervalSec, so this is exactly the call the bug's repro hit.
describe('loop:arm — EI-18792078711601844 carry preserved on re-arm', () => {
  beforeEach(() => {
    // Force the fresh-default resolution path to 'warm' whenever it's reached, so a test
    // asserting 'cold' survives can ONLY be passing because of preservation, never a
    // coincidental default. Interactive (no live host) always resolves 'warm'.
    findHostM.mockReturnValue(null);
  });

  it('an active prior loop with carry cold + carry omitted ⇒ re-arm PRESERVES cold (not the fresh warm default)', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'cold' }) as never);
    const b = body(await call({ intervalSec: 1200, goal: 'watch WI-5672 for the next fire' }));
    expect(b.ok).toBe(true);
    expect(b.loop.carry).toBe('cold');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'cold' }));
    expect(b.note).toContain("carry 'cold' PRESERVED from the loop's prior config");
    // this is the preservation path, not the headless-default path — no "Defaulted to COLD" text
    expect(b.note).not.toContain('Defaulted to COLD carry');
  });

  it('an active prior loop with carry warm + carry omitted ⇒ re-arm PRESERVES warm', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'warm' }) as never);
    const b = body(await call({ intervalSec: 1200, goal: 'watch WI-5672 for the next fire' }));
    expect(b.loop.carry).toBe('warm');
    expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ carry: 'warm' }));
    expect(b.note).toContain("carry 'warm' PRESERVED from the loop's prior config");
  });

  it('an EXPLICIT carry always overrides preservation, even over an active cold prior', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'cold' }) as never);
    const b = body(await call({ carry: 'warm', goal: 'watch WI-5672 for the next fire' }));
    expect(b.loop.carry).toBe('warm');
    expect(b.note).not.toContain('PRESERVED from the');
  });

  it('an INACTIVE prior loop (ended) ⇒ NOT preserved — falls through to the fresh default (warm, no live host)', async () => {
    priorLoopM.mockResolvedValue(priorLoop({ carry: 'cold', active: false }) as never);
    const b = body(await call({}));
    expect(b.loop.carry).toBe('warm');
    expect(b.note).not.toContain('PRESERVED from the');
  });

  it('no prior loop at all ⇒ NOT preserved — falls through to the fresh default (cold, headless host)', async () => {
    findHostM.mockReturnValue({ bridgeTty: false } as never);
    priorLoopM.mockResolvedValue(null as never);
    const b = body(await call({}));
    expect(b.loop.carry).toBe('cold');
    expect(b.note).toContain('Defaulted to COLD carry');
    expect(b.note).not.toContain('PRESERVED from the');
  });

  it('the prior-loop read throwing falls back to fresh-default resolution (fail-soft, arming never fails)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    priorLoopM.mockRejectedValue(new Error('db down') as never);
    const b = body(await call({}));
    expect(b.ok).toBe(true);
    expect(b.loop.carry).toBe('warm'); // fresh-default path, no live host
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('prior-loop read failed'));
    warnSpy.mockRestore();
  });
});

describe('loop:arm — EI-19395290807657827: the self-sealing backoff', () => {
  describe('resolveBlockedBackoff (pure)', () => {
    it('changes NO BEHAVIOUR when blockedOn is absent — every existing call site is unchanged', () => {
      // P-006/D-098 narrowed this contract deliberately: a wide undeclared interval now
      // returns an advisory `note`. The BEHAVIOURAL half is what the call sites depend on
      // and it is asserted here field-by-field — interval untouched, never clamped, no
      // wake premise injected.
      const r = resolveBlockedBackoff(7200, null);
      expect(r.intervalSec).toBe(7200);
      expect(r.clamped).toBe(false);
      expect(r.wakePremise).toBeNull();
    });

    it('stays fully silent for an ordinary short interval — the nudge must not nag a 60s loop', () => {
      expect(resolveBlockedBackoff(60, null)).toEqual({
        intervalSec: 60,
        clamped: false,
        note: null,
        wakePremise: null,
      });
    });

    // ── P-006 / D-098: surface `blockedOn` where it is actionable ──────────────
    // Measured 0 uses in 294 arm calls across 91 agents (14d) — built, better than a
    // prose-matching auto-attach, and never asked for.
    it('NUDGES an undeclared WIDE interval toward blockedOn, advisory only', () => {
      const r = resolveBlockedBackoff(1800, null);
      expect(r.intervalSec).toBe(1800); // advisory: never caps an undeclared loop
      expect(r.clamped).toBe(false);
      expect(r.wakePremise).toBeNull();
      expect(r.note).toContain('blockedOn');
      expect(r.note).toContain('events:catalog');
    });

    it('warns the await must be IN ADDITION to the loop, never instead of it (WI-6595)', () => {
      // The whole reason P-006's original "await INSTEAD of the poll" was refused: a
      // parked await suppresses loop fires, so an await on an event that cannot fire
      // deletes the agent's only backstop.
      const r = resolveBlockedBackoff(1800, null);
      expect(r.note).toMatch(/never instead of it/i);
      expect(r.note).toContain('WI-6595');
    });

    it('fires exactly at the cap boundary — one threshold, not a second constant', () => {
      expect(resolveBlockedBackoff(899, null).note).toBeNull();
      expect(resolveBlockedBackoff(900, null).note).toContain('blockedOn');
    });

    it('a DECLARED blocker never gets the undeclared-nudge — it gets the real backoff note', () => {
      const r = resolveBlockedBackoff(1800, { reason: 'gate red' });
      expect(r.note).toContain('Backoff recorded');
      expect(r.note).not.toMatch(/If you widened it because/i);
    });

    it('THE REGRESSION CASE: a 2h backoff with no clearing event is capped to 15min', () => {
      // The measured incident: five members re-armed at 7200s inside a 32s window and slept
      // ~2h past a blocker that had already cleared.
      const r = resolveBlockedBackoff(7200, { reason: 'green gate red 8h, blocking every deploy' });
      expect(r.intervalSec).toBe(900);
      expect(r.clamped).toBe(true);
      expect(r.note).toContain('CAPPED 7200s → 900s');
    });

    it('does not inflate an interval already below the cap', () => {
      const r = resolveBlockedBackoff(300, { reason: 'waiting on a peer' });
      expect(r.intervalSec).toBe(300);
      expect(r.clamped).toBe(false);
    });

    it('treats the cap boundary itself as un-clamped', () => {
      const r = resolveBlockedBackoff(900, { reason: 'boundary' });
      expect(r.intervalSec).toBe(900);
      expect(r.clamped).toBe(false);
    });

    it('HONOURS a long interval when a clearing event is named — the push channel makes it safe', () => {
      const r = resolveBlockedBackoff(7200, { reason: 'gate red', event: 'green-gate-verdict' });
      expect(r.intervalSec).toBe(7200);
      expect(r.clamped).toBe(false);
    });

    it('warns that naming an event is NOT the same as parking on it', () => {
      const r = resolveBlockedBackoff(7200, { reason: 'gate red', event: 'green-gate-verdict' });
      expect(r.note).toContain('events:await');
      expect(r.note).toMatch(/does NOT register the await/i);
    });

    it('always emits a wake premise instructing a re-check, in BOTH branches', () => {
      const withEvent = resolveBlockedBackoff(7200, { reason: 'gate red', event: 'green-gate-verdict' });
      const without = resolveBlockedBackoff(7200, { reason: 'gate red' });
      for (const r of [withEvent, without]) {
        expect(r.wakePremise).toContain('gate red');
        expect(r.wakePremise).toMatch(/RE-CHECK THAT PREMISE FIRST/);
        expect(r.wakePremise).toMatch(/RESTORE your normal cadence/);
      }
      // Only the event-less branch can claim nothing will push a wake.
      expect(without.wakePremise).toMatch(/NOTHING will push you a wake/);
      expect(withEvent.wakePremise).toContain('green-gate-verdict');
    });

    // EI-19447204017443244 — the cap used to assert "nothing can push you a wake" as
    // FACT while consulting only blockedOn.event. These four cases pin the three honest
    // renderings apart; each pair differs in exactly ONE input, so deleting the wiring
    // collapses them together and the suite fails by construction.
    describe('the live-push-channel claim (EI-19447204017443244)', () => {
      const blocked = { reason: 'waiting on a deploy' };

      it('NEVER states the caller has no push channel as an unqualified fact', () => {
        // The regression itself. The old text read "...you named no clearing event, so
        // nothing can push you a wake" — a claim about the caller's WHOLE wake surface,
        // which this function had never looked at. The scoped form is true by
        // construction, so it survives regardless of what the lookup found.
        for (const lp of [
          { status: 'unknown' } as const,
          { status: 'none' } as const,
          { status: 'found', count: 1, sample: ['predicate:abc'] } as const,
        ]) {
          const r = resolveBlockedBackoff(7200, blocked, lp);
          expect(r.note).toContain('no clearing event for this loop');
          expect(r.note).not.toMatch(/so nothing can push you a wake and the timer/);
        }
      });

      it('FOUND: names the live awaits instead of denying they exist — and still caps', () => {
        const r = resolveBlockedBackoff(7200, blocked, {
          status: 'found',
          count: 2,
          sample: ['predicate:44071', 'release:green:papercusp'],
        });
        expect(r.note).toContain('predicate:44071');
        expect(r.note).toMatch(/cannot tell whether any of them fires on THIS blocker/);
        // Item's option (b): the guard's behaviour is unchanged — only its claim is.
        expect(r.intervalSec).toBe(900);
        expect(r.clamped).toBe(true);
      });

      it('NONE: earns the negative claim by labelling it as MEASURED', () => {
        const r = resolveBlockedBackoff(7200, blocked, { status: 'none' });
        expect(r.note).toMatch(/measured, not assumed/);
        expect(r.note).not.toMatch(/you DO hold/);
      });

      it('UNKNOWN: a failed/absent lookup claims NEITHER — no fabricated measurement', () => {
        // The trap this guards: degrading "I could not look" into "I looked and found
        // nothing" would print a measurement that was never taken — the same defect
        // class, reintroduced through the error path.
        const r = resolveBlockedBackoff(7200, blocked, { status: 'unknown' });
        expect(r.note).not.toMatch(/measured, not assumed/);
        expect(r.note).not.toMatch(/you DO hold/);
      });

      it('defaults to UNKNOWN when the caller supplies no observation', () => {
        // Pins the back-compat contract: every pre-existing 2-arg caller is unaffected.
        expect(resolveBlockedBackoff(7200, blocked).note).toBe(
          resolveBlockedBackoff(7200, blocked, { status: 'unknown' }).note,
        );
      });

      it('the WAKE PREMISE names no specific await — it is re-injected on every wake', () => {
        // A once-await fires and is gone, so "you hold watch #44071" would be a fresh
        // false claim of this same class, merely time-shifted. The premise must stay
        // durable: scoped to the loop, naming nothing that can expire under it.
        const r = resolveBlockedBackoff(7200, blocked, {
          status: 'found',
          count: 1,
          sample: ['predicate:44071'],
        });
        expect(r.wakePremise).not.toContain('predicate:44071');
        expect(r.wakePremise).toContain('No clearing event was named for this loop');
      });
    });
  });

  describe('handler wiring', () => {
    it('arms the CAPPED interval, not the requested one', async () => {
      const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'gate red 8h' } }));
      expect(b.loop.intervalSec).toBe(900);
      expect(b.loop.requestedIntervalSec).toBe(7200);
      expect(b.loop.blockedOn).toEqual({ reason: 'gate red 8h', event: null, intervalCapped: true });
      expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ intervalSec: 900 }));
    });

    // EI-19447204017443244 — END-TO-END: the pure resolver above can be perfect and the
    // message still lie, if the handler never runs the lookup or drops its result. Each
    // case below differs from the default (empty ⇒ 'none') in exactly ONE input.
    describe('live wake-await lookup wiring (EI-19447204017443244)', () => {
      it('QUERIES the caller and threads a HIT into the cap message', async () => {
        wakeAwaitsM.mockResolvedValue([
          { eventKey: 'predicate:44071', expiresTs: null, rootId: null },
        ] as never);
        const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'waiting on a deploy' } }));
        // Queried for the ARMING owner — a lookup against anyone else answers the wrong question.
        expect(wakeAwaitsM).toHaveBeenCalledWith('su-caller-own-id');
        expect(b.note).toContain('predicate:44071');
        expect(b.note).not.toMatch(/measured, not assumed/);
      });

      it('BASELINE: the same arm with no live awaits makes the measured-negative claim', async () => {
        // The differential partner of the case above: identical call, lookup empty.
        // Delete the handler wiring and these two converge, so neither can pass vacuously.
        const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'waiting on a deploy' } }));
        expect(b.note).toMatch(/measured, not assumed/);
        expect(b.note).not.toContain('predicate:');
      });

      it('does NOT query when a clearing event IS named — that branch never speaks about awaits', async () => {
        await call({
          intervalSec: 7200,
          blockedOn: { reason: 'gate red', event: 'release:green:papercusp' },
        });
        expect(wakeAwaitsM).not.toHaveBeenCalled();
      });

      it('does NOT query on an ordinary arm with no declared blocker', async () => {
        await call({ intervalSec: 7200 });
        expect(wakeAwaitsM).not.toHaveBeenCalled();
      });

      it('a FAILED lookup still arms, and claims NEITHER way', async () => {
        // Best-effort contract: advisory reads must not fail the arm, and must not
        // degrade into a fabricated "I checked and found nothing".
        wakeAwaitsM.mockRejectedValue(new Error('statement timeout') as never);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const b = body(await call({ intervalSec: 7200, blockedOn: { reason: 'waiting on a deploy' } }));
        // The failure is SWALLOWED for the caller but must not be silent for the operator.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('live wake-await lookup failed'));
        warn.mockRestore();
        expect(b.ok).not.toBe(false);
        expect(b.loop.intervalSec).toBe(900);
        expect(b.note).not.toMatch(/measured, not assumed/);
        expect(b.note).not.toMatch(/you DO hold/);
      });
    });

    it('PREPENDS the premise to the kickoff — the mechanism that actually re-checks it each wake', async () => {
      await call({ intervalSec: 7200, blockedOn: { reason: 'gate red 8h' } });
      const kickoff = (materializeM.mock.calls.at(-1)![0] as { kickoff: string }).kickoff;
      expect(kickoff).toMatch(/^⏸ BACKOFF PREMISE/);
      expect(kickoff).toContain('gate red 8h');
      // The original wake prompt must still be there — the premise prepends, never replaces.
      expect(kickoff).toContain('kickoff-prompt');
    });

    it('leaves the kickoff and the response untouched when no backoff is declared', async () => {
      const b = body(await call({ intervalSec: 7200 }));
      expect(b.loop.intervalSec).toBe(7200);
      expect(b.loop.blockedOn).toBeNull();
      expect(b.loop.requestedIntervalSec).toBeUndefined();
      expect((materializeM.mock.calls.at(-1)![0] as { kickoff: string }).kickoff).toBe('kickoff-prompt');
    });

    it('honours the long interval end-to-end when a clearing event is named', async () => {
      const b = body(
        await call({ intervalSec: 7200, blockedOn: { reason: 'gate red', event: 'green-gate-verdict' } }),
      );
      expect(b.loop.intervalSec).toBe(7200);
      expect(b.loop.blockedOn).toEqual({
        reason: 'gate red',
        event: 'green-gate-verdict',
        intervalCapped: false,
      });
      expect(materializeM).toHaveBeenCalledWith(expect.objectContaining({ intervalSec: 7200 }));
    });
  });
});
