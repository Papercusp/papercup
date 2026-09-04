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
const getPresence = vi.fn();
const listFleetPresence = vi.fn();
const sendMessage = vi.fn();
const wakeRecipients = vi.fn();
const resolveSessionStates = vi.fn();
const resolveSavedFleetLaunchSpec = vi.fn();
const getSessionBrief = vi.fn();
const resolveProjectDir = vi.fn();
const assembleRolePrompt = vi.fn();
const readAgentConfig = vi.fn();
const getFleet = vi.fn();
const setFleetLaunchTransaction = vi.fn();
const findLiveHost = vi.fn();

const LEADER = 'su-leader';
const MEMBER = 'su-member-abc';
const SLUG = 'rocket';
let persistedRole = 'su';
let persistedTarget = 16;

vi.mock('./member-target', () => ({
  resolveFleetMemberTarget: (...a: unknown[]) => resolveFleetMemberTarget(...a),
}));
vi.mock('../fleet/kill', () => ({ default: { handler: (...a: unknown[]) => killHandler(...a) } }));
vi.mock('../capability/launch-agent', () => ({ default: { handler: (...a: unknown[]) => launchHandler(...a) } }));
vi.mock('../coordination/presence', () => ({
  getPresence: (...a: unknown[]) => getPresence(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({
  listFleetPresence: (...a: unknown[]) => listFleetPresence(...a),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
vi.mock('../coordination/inbox-wake', () => ({
  wakeRecipients: (...a: unknown[]) => wakeRecipients(...a),
}));
vi.mock('../coordination/liveness-oracle', () => ({
  resolveSessionStates: (...a: unknown[]) => resolveSessionStates(...a),
}));
vi.mock('./saved-launch-spec', () => ({
  resolveSavedFleetLaunchSpec: (...a: unknown[]) => resolveSavedFleetLaunchSpec(...a),
}));
vi.mock('../../session-brief', () => ({
  getSessionBrief: (...a: unknown[]) => getSessionBrief(...a),
}));
vi.mock('../../spawn-config', () => ({
  resolveProjectDir: (...a: unknown[]) => resolveProjectDir(...a),
}));
vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: (...a: unknown[]) => assembleRolePrompt(...a),
}));
vi.mock('../../agent-config', () => ({
  readAgentConfig: (...a: unknown[]) => readAgentConfig(...a),
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-fleets-store')>();
  return {
    ...actual,
    getFleet: (...a: unknown[]) => getFleet(...a),
    setFleetLaunchTransaction: (...a: unknown[]) => setFleetLaunchTransaction(...a),
  };
});
vi.mock('../../events/await/psu-pty-discovery', () => ({
  findLiveHost: (...a: unknown[]) => findLiveHost(...a),
}));
vi.mock('./_shared', () => ({
  ROUTING_LADDER: 'ladder',
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
}));

import tool, {
  awaitMemberDrain,
  awaitReplacementMember,
  persistRespawnLaunchTransaction,
  reconcileRespawnLaunchTransaction,
} from './respawn-member';
import { PAIR_ROLE_IMPLEMENTER } from './pair-launch-options';
import type { FleetLaunchTransaction } from '../../agent-fleets-store';

const row = (ownerId: string, heartbeatAgoMs = 0) => ({
  ownerId,
  startedAt: new Date(Date.now() - 60_000),
  heartbeatAt: new Date(Date.now() - heartbeatAgoMs),
  lastToolCallAt: null,
});

const launchTransaction = (overrides: Partial<FleetLaunchTransaction> = {}): FleetLaunchTransaction => ({
  version: 1,
  transactionId: 'tx-respawn',
  launcherOwnerId: LEADER,
  state: 'partial',
  requestedAt: 1_000,
  updatedAt: 2_000,
  requestedMemberIds: [MEMBER],
  openedMemberIds: [MEMBER],
  verifiedMemberIds: [],
  unconfirmedMemberIds: [MEMBER],
  failed: [],
  waves: [{ index: 0, ownerIds: [MEMBER], state: 'partial', openedOwnerIds: [MEMBER], verifiedOwnerIds: [] }],
  recovery: { retryOwnerIds: [MEMBER], nextAction: 'resume unresolved member' },
  governor: {
    version: 1,
    probeOwnerIds: [MEMBER],
    attestationAttempts: { [MEMBER]: 1 },
    retiredMemberIds: [],
    history: [],
    terminalVerdict: null,
  },
  requestedMembers: [{
    index: 0,
    ownerId: MEMBER,
    agent: 'codex',
    model: 'gpt-5.6-sol',
    account: 'default',
    carry: 'warm',
    headless: true,
  }],
  ...overrides,
});

function parse(res: unknown) {
  return JSON.parse((res as { content: { text: string }[] }).content[0].text);
}

describe('fleet:respawn-member — ambient workspace transaction safety (EI-20215222062407258)', () => {
  it('opts out because drain/launch/heartbeat verification can await beyond the idle tx timeout', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('declares a dispatch budget for the bounded drain plus replacement verification (EI-21266158571232094)', () => {
    // drainVerifySec and verifySec each allow up to 300s; the tool budget must not inherit the
    // dispatch stack's 60s default or tools:invoke will abort a valid long-running respawn.
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec).toBe(660);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  persistedRole = 'su';
  persistedTarget = 16;
  getPresence.mockResolvedValue({ potSlug: 'papercusp' });
  getSessionBrief.mockResolvedValue(null);
  resolveProjectDir.mockResolvedValue('/tmp/papercusp');
  assembleRolePrompt.mockReturnValue({ text: 'role prompt', meta: { projectDir: '/tmp/papercusp' } });
  readAgentConfig.mockResolvedValue({ tiers: [] });
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
  sendMessage.mockResolvedValue({ msg_id: 'yield-1' });
  wakeRecipients.mockResolvedValue({ targets: [MEMBER], keys: ['wake-1'], queued: 1, woken: 1, staged: 0, stagedTargets: [], fanoutCapped: [], timedOutTargets: [] });
  resolveSessionStates.mockReset().mockResolvedValue(new Map());
  getFleet.mockResolvedValue({ lastLaunchTransaction: null });
  setFleetLaunchTransaction.mockResolvedValue(true);
  // WI-2141730: no colliding live host by default — the ordinary respawn path never sees this
  // guard fire. Individual tests override this to exercise the refusal.
  findLiveHost.mockReturnValue(null);
  // Roster: the old member before the kill, a NEW live owner once the replacement has booted.
  // mockReset (not clearAllMocks) — a leftover `once` value would be consumed by the verification
  // poll instead of the snapshot, and the test would then really wait out the 90s window.
  listFleetPresence.mockReset();
  let rosterReadCount = 0;
  listFleetPresence.mockImplementation(async () => {
    rosterReadCount += 1;
    if (rosterReadCount === 1) return [row(LEADER), row(MEMBER)];
    const launchArgs = launchHandler.mock.calls[0]?.[0] as { __respawnOwnerId?: string } | undefined;
    return [row(LEADER), row(launchArgs?.__respawnOwnerId ?? 'su-new-xyz')];
  });
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
      role: persistedRole,
    };
    for (const [field, value] of Object.entries(opts.requested ?? {})) {
      if (value !== undefined) member[field] = value;
    }
    // Keep the orchestration fixture internally coherent when a test changes the model family
    // without pinning an agent. The production resolver preserves a saved explicit agent; tests
    // that exercise that safety boundary pass `agent` explicitly below.
    if (opts.requested?.agent === undefined && typeof member.model === 'string') {
      const model = member.model.replace(/\[[^\]]+\]$/, '').replace(/:(low|medium|high|xhigh|max)$/i, '').toLowerCase();
      if (/^(opus|sonnet|haiku|fable)$/.test(model)) member.agent = 'claude';
      if (/^(sol|terra|luna|gpt-5\.6-(sol|terra|luna))$/.test(model)) member.agent = 'codex';
    }
    return {
      ok: true,
      found: true,
      target: persistedTarget,
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
        target: persistedTarget,
      },
      reusePath: opts.reusePath,
    };
  });
});

describe('respawn launch-transaction persistence', () => {
  it('replaces the drained identity while preserving retirement history and recovery evidence', () => {
    const original = launchTransaction();
    const reconciled = reconcileRespawnLaunchTransaction({
      transaction: original,
      drainedOwnerId: MEMBER,
      replacementOwnerId: 'su-respawn-fixed',
      now: 3_000,
    });

    expect(reconciled).toMatchObject({
      state: 'partial',
      updatedAt: 3_000,
      requestedMemberIds: ['su-respawn-fixed'],
      openedMemberIds: ['su-respawn-fixed'],
      verifiedMemberIds: [],
      unconfirmedMemberIds: ['su-respawn-fixed'],
      recovery: {
        retryOwnerIds: ['su-respawn-fixed'],
        nextAction: expect.stringContaining('do not replay'),
      },
      governor: {
        probeOwnerIds: ['su-respawn-fixed'],
        retiredMemberIds: [MEMBER],
        history: [expect.objectContaining({
          action: 'respawn',
          ownerId: MEMBER,
          replacementOwnerId: 'su-respawn-fixed',
        })],
      },
      requestedMembers: [expect.objectContaining({ ownerId: 'su-respawn-fixed' })],
    });
    expect(reconciled.waves[0]).toMatchObject({
      ownerIds: ['su-respawn-fixed'],
      openedOwnerIds: ['su-respawn-fixed'],
    });
    // The CAS writer must be able to retry from the exact snapshot it read.
    expect(original.requestedMemberIds).toEqual([MEMBER]);
    expect(original.recovery.retryOwnerIds).toEqual([MEMBER]);
  });

  it('persists a verified replacement with the observed transaction revision', async () => {
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction() });

    const result = await persistRespawnLaunchTransaction({
      workspaceId: 'ws',
      fleetSlug: SLUG,
      drainedOwnerId: MEMBER,
      replacementOwnerId: 'su-respawn-fixed',
      outcome: 'verified',
      expectedTransactionId: 'tx-respawn',
      now: () => 3_000,
    });

    expect(result).toMatchObject({ ok: true, attempts: 1 });
    if (!result.ok) throw new Error('expected persistence to succeed');
    expect(result.transaction).toMatchObject({
      state: 'verified',
      updatedAt: 3_000,
      requestedMemberIds: ['su-respawn-fixed'],
      verifiedMemberIds: ['su-respawn-fixed'],
      unconfirmedMemberIds: [],
      recovery: { retryOwnerIds: [], nextAction: expect.stringContaining('verified') },
    });
    expect(setFleetLaunchTransaction).toHaveBeenCalledWith({
      workspaceId: 'ws',
      fleetSlug: SLUG,
      transaction: result.transaction,
      expectedRevision: { transactionId: 'tx-respawn', updatedAt: 2_000 },
    });
  });

  it('preserves a newer launch transaction instead of overwriting it', async () => {
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction({ transactionId: 'tx-new', updatedAt: 4_000 }) });

    const result = await persistRespawnLaunchTransaction({
      workspaceId: 'ws',
      fleetSlug: SLUG,
      drainedOwnerId: MEMBER,
      replacementOwnerId: 'su-respawn-fixed',
      outcome: 'verified',
      expectedTransactionId: 'tx-respawn',
    });

    expect(result).toEqual({
      ok: false,
      attempts: 1,
      reason: 'newer-transaction',
      preservedTransactionId: 'tx-new',
    });
    expect(setFleetLaunchTransaction).not.toHaveBeenCalled();
  });

  it('retries a compare-and-set miss and reports a bounded read failure', async () => {
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction() });
    setFleetLaunchTransaction.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const retried = await persistRespawnLaunchTransaction({
      workspaceId: 'ws',
      fleetSlug: SLUG,
      drainedOwnerId: MEMBER,
      replacementOwnerId: 'su-respawn-fixed',
      outcome: 'unverified',
      expectedTransactionId: 'tx-respawn',
      now: () => 3_000,
    });
    expect(retried).toMatchObject({ ok: true, attempts: 2 });
    expect(setFleetLaunchTransaction).toHaveBeenCalledTimes(2);

    getFleet.mockRejectedValue(new Error('db down'));
    const unreadable = await persistRespawnLaunchTransaction({
      workspaceId: 'ws',
      fleetSlug: SLUG,
      drainedOwnerId: MEMBER,
      replacementOwnerId: 'su-respawn-fixed',
      outcome: 'launch-failed',
      expectedTransactionId: 'tx-respawn',
    });
    expect(unreadable).toMatchObject({ ok: false, attempts: 3, reason: 'read-failed', error: 'db down' });
  });
});

describe('fleet:respawn-member (P-008)', () => {
  it('accepts role as a boot-baked respawn setting at the tool boundary', () => {
    expect(tool.args.safeParse({ member: MEMBER, role: 'su' }).success).toBe(true);
  });

  it('accepts carry as a boot-baked respawn setting at the tool boundary', () => {
    expect(tool.args.safeParse({ member: MEMBER, carry: 'cold' }).success).toBe(true);
  });

  it('accepts and honors an explicit per-call harness context for legacy recovery', async () => {
    getPresence.mockResolvedValueOnce(null);
    getSessionBrief.mockResolvedValueOnce(null);

    expect(tool.args.safeParse({ member: MEMBER, harness: 'papercusp', model: 'gpt-5.6-sol' }).success).toBe(true);

    const res = await tool.handler(
      { member: MEMBER, harness: 'papercusp', model: 'gpt-5.6-sol' } as never,
      { harnessSlug: '*' } as never,
    );
    expect(parse(res)).toMatchObject({ ok: true, fleet: SLUG, oldMember: MEMBER });
    expect(resolveSavedFleetLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyFallbacks: expect.objectContaining({ harness: 'papercusp' }),
      }),
    );
  });

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
        __respawnOwnerId: expect.stringMatching(/^su-respawn-/),
        members: [expect.objectContaining({ model: 'opus[1m]', effort: 'high', compactionLimit: 200_000, brief: expect.any(String) })],
      }),
      expect.anything(),
    );
    expect(p.launched).toContain('Launched su-new');
    expect(p.newMember).toBe(p.replacementOwner);
  });

  it('overrides the saved carry mode and forwards it through the audited replacement launch', async () => {
    const res = await tool.handler(
      { member: MEMBER, carry: 'cold', verifySec: 0 } as never,
      {} as never,
    );
    const p = parse(res);
    const launchArgs = launchHandler.mock.calls[0][0] as Record<string, unknown> & {
      members: Array<Record<string, unknown>>;
    };

    expect(p).toMatchObject({
      ok: true,
      fleet: SLUG,
      oldMember: MEMBER,
      changed: ['carry'],
      verification: 'skipped',
    });
    expect(resolveSavedFleetLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: expect.objectContaining({ carry: 'cold' }),
        allowDeltas: expect.arrayContaining(['carry']),
      }),
    );
    expect(launchArgs).toMatchObject({
      __savedLaunchCarry: 'cold',
      members: [expect.objectContaining({ carry: 'cold' })],
    });
  });

  it('refuses to launch a replacement whose freshly-minted identity already has a live host (WI-2141730)', async () => {
    // Simulates a reused (fleetSlug, memberOwnerId, idempotencyKey) triple after the launch
    // claim TTL expired: the deterministic replacementOwnerId() collides with a still-live
    // earlier replacement's psu-pty host. The old member has ALREADY been killed by this point
    // (drain happens before the identity is pinned), so this must NOT double-launch.
    findLiveHost.mockReturnValue({ ownerId: 'su-respawn-collide', pid: 4242, sock: '/tmp/collide.sock' });

    const res = await tool.handler(
      { member: MEMBER, model: 'opus[1m]', idempotencyKey: 'reused-key' } as never,
      {} as never,
    );
    const p = parse(res);

    expect(p).toMatchObject({
      ok: false,
      error: 'replacement_identity_already_live',
      fleet: SLUG,
      oldMember: MEMBER,
      collidingPid: 4242,
      launched: false,
    });
    expect(p.replacementOwner).toEqual(expect.stringMatching(/^su-respawn-/));
    expect(p.message).toContain(p.replacementOwner);
    expect(p.message).toContain('4242');
    // the old member's drain already happened — this must not be a silent no-op
    expect(killHandler).toHaveBeenCalledWith(expect.objectContaining({ owner: MEMBER, close_terminal: true }), expect.anything());
    // but launching a SECOND process under the colliding identity must be refused
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('preflights an unknown persisted persona role before killing, preserving the diagnostic on refusal', async () => {
    persistedRole = 'missing-persona';
    const roleError = new Error('assembleRolePrompt: no prompt file found for role "missing-persona"');
    assembleRolePrompt.mockImplementationOnce(() => {
      throw roleError;
    });

    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({
      ok: false,
      error: 'saved_role_invalid',
      fleet: SLUG,
      member: MEMBER,
      role: 'missing-persona',
      killed: false,
      launched: false,
    });
    expect(p.message).toContain('Invalid persona role `missing-persona`');
    expect(p.message).toContain('The old member was NOT killed and no replacement was launched.');
    expect(p.message).toContain('NO agents were spawned and NO terminals were opened');
    expect(resolveProjectDir).toHaveBeenCalledWith('papercusp', 'ws');
    expect(assembleRolePrompt).toHaveBeenCalledWith({
      slug: 'papercusp',
      projectDir: '/tmp/papercusp',
      role: 'missing-persona',
      mode: 'chat',
    });
    expect(killHandler).not.toHaveBeenCalled();
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('normalizes the legacy persisted implementer role to the canonical paired persona before preflight and launch', async () => {
    persistedRole = 'implementer';

    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({
      ok: true,
      fleet: SLUG,
      oldMember: MEMBER,
      changed: ['model'],
    });
    expect(assembleRolePrompt).toHaveBeenCalledWith({
      slug: 'papercusp',
      projectDir: '/tmp/papercusp',
      role: PAIR_ROLE_IMPLEMENTER,
      mode: 'chat',
    });
    expect(killHandler).toHaveBeenCalledWith(expect.objectContaining({ owner: MEMBER }), expect.anything());
    expect(launchHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [expect.objectContaining({ role: PAIR_ROLE_IMPLEMENTER })],
      }),
      expect.anything(),
    );
  });

  it('refuses an unavailable saved Claude model before reading the roster or killing the old member', async () => {
    const res = await tool.handler({ member: MEMBER, agent: 'claude', model: 'claude-opus-4' } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({
      ok: false,
      error: 'saved_model_invalid',
      fleet: SLUG,
      member: MEMBER,
      model: 'claude-opus-4:xhigh',
      agent: 'claude',
      killed: false,
      launched: false,
    });
    expect(p.message).toMatch(/not (?:present in|registered in) the effective model tiers or CLOUD_MODEL_MENU/);
    expect(readAgentConfig).toHaveBeenCalledTimes(1);
    expect(listFleetPresence).not.toHaveBeenCalled();
    expect(killHandler).not.toHaveBeenCalled();
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('fails closed when the saved model catalog cannot be read, before killing the old member', async () => {
    readAgentConfig.mockRejectedValueOnce(new Error('config unavailable'));
    const res = await tool.handler({ member: MEMBER, agent: 'claude', model: 'opus[1m]' } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({
      ok: false,
      error: 'saved_model_preflight_failed',
      killed: false,
      launched: false,
    });
    expect(p.message).toContain('config unavailable');
    expect(listFleetPresence).not.toHaveBeenCalled();
    expect(killHandler).not.toHaveBeenCalled();
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('refuses a saved native agent/model backend mismatch before killing the old member', async () => {
    const res = await tool.handler({ member: MEMBER, agent: 'claude', model: 'gpt-5.6-sol', effort: 'xhigh' } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({
      ok: false,
      error: 'saved_model_backend_mismatch',
      model: 'gpt-5.6-sol:xhigh',
      agent: 'claude',
      backend: 'codex',
      killed: false,
      launched: false,
    });
    expect(p.message).toMatch(/belongs to the `codex` backend/);
    expect(listFleetPresence).not.toHaveBeenCalled();
    expect(killHandler).not.toHaveBeenCalled();
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('accepts the open-set Codex model gpt-5.5:high before killing the old member', async () => {
    const res = await tool.handler(
      { member: MEMBER, agent: 'codex', model: 'gpt-5.5', effort: 'high', verifySec: 0 } as never,
      {} as never,
    );
    const p = parse(res);

    expect(p).toMatchObject({
      ok: true,
      fleet: SLUG,
      oldMember: MEMBER,
      launched: expect.stringContaining('Launched su-new'),
      verification: 'skipped',
    });
    expect(p.killed).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(killHandler).toHaveBeenCalledWith(expect.objectContaining({ owner: MEMBER }), expect.anything());
    expect(launchHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [expect.objectContaining({ agent: 'codex', model: 'gpt-5.5', effort: 'high' })],
      }),
      expect.anything(),
    );
  });

  it('still refuses an unrecognized model id before killing the old member', async () => {
    const res = await tool.handler(
      { member: MEMBER, agent: 'codex', model: 'unknown-full-id', effort: 'high' } as never,
      {} as never,
    );
    const p = parse(res);

    expect(p).toMatchObject({
      ok: false,
      error: 'saved_model_invalid',
      model: 'unknown-full-id:high',
      agent: 'codex',
      killed: false,
      launched: false,
    });
    expect(p.message).toMatch(/not registered in the effective model tiers or CLOUD_MODEL_MENU/);
    expect(killHandler).not.toHaveBeenCalled();
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('accepts an explicit role override so stale saved-role recovery can be repaired before launch', async () => {
    persistedRole = 'implementer';
    const roleError = new Error('assembleRolePrompt: no prompt file found for role "implementer"');
    assembleRolePrompt.mockImplementationOnce(() => {
      throw roleError;
    });

    const res = await tool.handler({ member: MEMBER, role: 'su', model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({
      ok: true,
      fleet: SLUG,
      oldMember: MEMBER,
      changed: expect.arrayContaining(['model', 'role']),
    });
    expect(resolveSavedFleetLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: expect.objectContaining({ role: 'su' }),
        allowDeltas: expect.arrayContaining(['role']),
      }),
    );
    expect(killHandler).toHaveBeenCalledWith(expect.objectContaining({ owner: MEMBER }), expect.anything());
    expect(launchHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [expect.objectContaining({ role: 'su' })],
      }),
      expect.anything(),
    );
  });

  it('correlates the exact replacement when concurrent respawns add multiple fresh rows', async () => {
    const result = await awaitReplacementMember({
      before: new Set([LEADER, 'old-member-a', 'old-member-b']),
      expectedOwnerId: 'su-respawn-b',
      list: async () => [
        row(LEADER),
        row('su-respawn-a'),
        row('su-respawn-b'),
      ],
      timeoutMs: 1_000,
      now: () => Date.now(),
    });

    expect(result).toMatchObject({ verified: true, newMemberOwnerId: 'su-respawn-b' });
  });

  it('keeps concurrent respawn responses attributed to their own pre-pinned replacement', async () => {
    const members = ['old-member-a', 'old-member-b'];
    const launchKeys = ['respawn-key-a', 'respawn-key-b'];
    let rosterReads = 0;

    resolveFleetMemberTarget.mockImplementation(async (_ctx: unknown, member: string) => ({
      ok: true,
      callerId: LEADER,
      workspaceId: 'ws',
      identity: { ownerId: LEADER },
      slug: SLUG,
      fleet: { fleetSlug: SLUG, leaderOwnerId: LEADER },
      memberOwnerId: member,
      memberRole: 'member',
      invokedAs: 'leader',
    }));
    listFleetPresence.mockImplementation(async () => {
      rosterReads += 1;
      if (rosterReads <= members.length) return [row(LEADER), ...members.map((member) => row(member))];
      const launchedOwners = launchHandler.mock.calls.map((call, index) => {
        const launchArgs = call[0] as { __respawnOwnerId?: string };
        // The fallback names model the pre-fix launch path, which minted both
        // identities inside bootstrap and gave the verifier no correlation key.
        return launchArgs.__respawnOwnerId ?? `su-replacement-${index + 1}`;
      });
      return [row(LEADER), ...launchedOwners.map((owner) => row(owner))];
    });

    const responses = await Promise.all(
      members.map((member, index) =>
        tool.handler(
          { member, model: 'opus[1m]', idempotencyKey: launchKeys[index], verifySec: 1 } as never,
          {} as never,
        ),
      ),
    );
    const payloads = responses.map(parse);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ ok: true, oldMember: members[0], verified: true });
    expect(payloads[1]).toMatchObject({ ok: true, oldMember: members[1], verified: true });
    expect(payloads[0].replacementOwner).not.toBe(payloads[1].replacementOwner);
    expect(payloads[0].newMember).toBe(payloads[0].replacementOwner);
    expect(payloads[1].newMember).toBe(payloads[1].replacementOwner);
    expect(launchHandler.mock.calls.map((call) => (call[0] as { __respawnOwnerId?: string }).__respawnOwnerId)).toEqual(
      expect.arrayContaining(payloads.map((payload) => payload.replacementOwner)),
    );
  });

  it('uses the audited respawn door to correct a saved visible member to headless while preserving the rest of its profile', async () => {
    resolveSavedFleetLaunchSpec.mockResolvedValueOnce({
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
        headless: false,
        carry: 'warm',
        contextSize: 'trimmed',
        role: 'su',
      },
      saved: {
        plan: 'byoc-plan',
        harness: 'papercusp',
        member: {
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          account: 'default',
          headless: false,
          carry: 'warm',
          contextSize: 'trimmed',
          role: 'su',
        },
      },
      effective: {
        plan: 'byoc-plan',
        harness: 'papercusp',
        member: {
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          account: 'default',
          headless: true,
          carry: 'warm',
          contextSize: 'trimmed',
          role: 'su',
        },
      },
      preservedFields: ['plan', 'harness', 'agent', 'model', 'account', 'carry', 'role', 'contextSize'],
      overrides: [
        {
          field: 'headless',
          saved: false,
          requested: true,
          provenance: {
            source: 'fleet:headcount-target',
            workspaceId: 'ws',
            fleetSlug: SLUG,
            target: 16,
          },
          reusePath: 'fleet:respawn-member -> capability:launch-agent',
        },
      ],
      provenance: {
        source: 'fleet:headcount-target',
        workspaceId: 'ws',
        fleetSlug: SLUG,
        target: 16,
      },
      reusePath: 'fleet:respawn-member -> capability:launch-agent',
    });

    const res = await tool.handler(
      { member: MEMBER, headless: true, reason: 'correct saved fleet placement' } as never,
      {} as never,
    );
    const p = parse(res);
    const launchArgs = launchHandler.mock.calls[0][0] as Record<string, unknown> & {
      members: Array<Record<string, unknown>>;
    };

    expect(p).toMatchObject({
      ok: true,
      changed: ['headless'],
      launchSpec: {
        provenance: { source: 'fleet:headcount-target', fleetSlug: SLUG },
        reusePath: 'fleet:respawn-member -> capability:launch-agent',
        overrides: [{ field: 'headless', saved: false, requested: true }],
      },
    });
    expect(launchArgs).toMatchObject({
      fleet: SLUG,
      count: 1,
      plan: 'byoc-plan',
      harness: 'papercusp',
      __savedLaunchCarry: 'warm',
      members: [
        {
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          account: 'default',
          headless: true,
          carry: 'warm',
          contextSize: 'trimmed',
          role: 'su',
        },
      ],
    });
  });

  it('threads trusted legacy fallbacks and omits plan when respawning a planless member', async () => {
    getPresence.mockResolvedValueOnce(null);
    getSessionBrief.mockResolvedValueOnce({ harnessSlug: 'papercusp' });
    resolveSavedFleetLaunchSpec.mockResolvedValueOnce({
      ok: true,
      found: true,
      target: 1,
      config: {
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
      saved: {
        harness: 'papercusp',
        member: {
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          account: 'default',
          headless: true,
          carry: 'warm',
          contextSize: 'trimmed',
          role: 'su',
        },
      },
      effective: {
        harness: 'papercusp',
        member: {
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          account: 'default',
          headless: true,
          carry: 'warm',
          contextSize: 'trimmed',
          role: 'su',
        },
      },
      preservedFields: ['harness', 'agent', 'model', 'account', 'headless', 'carry', 'contextSize', 'role'],
      overrides: [],
      provenance: { source: 'adv_sessions.launch_spec', workspaceId: 'ws', fleetSlug: SLUG, target: null },
      reusePath: 'fleet:respawn-member -> capability:launch-agent',
    });

    const res = await tool.handler(
      { member: MEMBER, agent: 'codex', model: 'gpt-5.6-sol', headless: true } as never,
      { harnessSlug: 'papercusp' } as never,
    );
    const p = parse(res);
    const launchArgs = launchHandler.mock.calls[0][0] as Record<string, unknown> & {
      members: Array<Record<string, unknown>>;
    };

    expect(p).toMatchObject({ ok: true, launchSpec: { provenance: { source: 'adv_sessions.launch_spec' } } });
    expect(resolveSavedFleetLaunchSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyFallbacks: { agent: 'codex', harness: 'papercusp' },
      }),
    );
    expect(getSessionBrief).toHaveBeenCalledWith({ ownerId: MEMBER });
    expect(launchArgs).toMatchObject({ fleet: SLUG, count: 1, harness: 'papercusp', members: [{ agent: 'codex' }] });
    expect(launchArgs).not.toHaveProperty('plan');
  });

  it('ABORTS (no relaunch) when the kill fails — never double-runs the lane', async () => {
    killHandler.mockResolvedValue({ data: { ok: true, results: [{ ok: false, target: MEMBER, error: 'no host' }], counts: { ok: 0, failed: 1 } } });
    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: false, error: 'kill_failed' });
    expect(launchHandler).not.toHaveBeenCalled();
  });

  it('cooperatively drains a live_unmanaged member, wakes it, and launches only after disappearance', async () => {
    killHandler.mockResolvedValue({
      data: {
        ok: true,
        results: [{ ok: false, target: MEMBER, kind: 'unmanaged', code: 'live_unmanaged' }],
        counts: { ok: 0, failed: 1 },
      },
    });
    listFleetPresence.mockReset()
      .mockResolvedValueOnce([row(LEADER), row(MEMBER)])
      .mockResolvedValueOnce([row(LEADER)]);

    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high', drainVerifySec: 1, verifySec: 0 } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({ ok: true, drainOutcome: 'cooperatively-drained', verified: false });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: LEADER }),
      expect.objectContaining({ to: [MEMBER], kind: 'yield', body: expect.stringContaining('release any claims and file locks') }),
    );
    expect(wakeRecipients).toHaveBeenCalledWith([MEMBER], expect.objectContaining({ source: 'fleet:respawn-member', workspaceId: 'ws' }));
    expect(launchHandler).toHaveBeenCalledTimes(1);
    expect(p.cooperativeRequest).toMatchObject({ msgId: 'yield-1', wake: { woken: 1 } });
    expect(p.cooperativeDrain).toMatchObject({ verified: true, terminal: 'absent' });
  });

  it('fails closed when a live_unmanaged member never reaches a terminal state', async () => {
    killHandler.mockResolvedValue({
      data: {
        ok: true,
        results: [{ ok: false, target: MEMBER, kind: 'unmanaged', code: 'live_unmanaged' }],
        counts: { ok: 0, failed: 1 },
      },
    });
    listFleetPresence.mockReset().mockResolvedValue([row(LEADER), row(MEMBER)]);
    resolveSessionStates.mockResolvedValue(new Map([[MEMBER, { sessionState: 'parked' }]]));

    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high', drainVerifySec: 1 } as never, {} as never);
    const p = parse(res);

    expect(p).toMatchObject({ ok: false, error: 'cooperative_drain_unverified' });
    expect(p.verification).toMatchObject({ verified: false, sessionState: 'parked' });
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

  it('reports the under-strength failure when the relaunch fails after a successful kill', async () => {
    persistedTarget = 3;
    listFleetPresence.mockReset()
      .mockResolvedValueOnce([row(LEADER), row(MEMBER)])
      .mockResolvedValueOnce([row(LEADER), row('surviving-member')]);
    launchHandler.mockResolvedValue({ content: [{ type: 'text', text: 'launch failed: no capacity' }], isError: true });
    const res = await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never);
    const p = parse(res);
    expect(p.ok).toBe(false);
    expect(p.headcount).toMatchObject({
      target: 3,
      current: 1,
      shortfall: 2,
      underStrength: true,
      verdict: 'under-strength',
      memberOwnerIds: ['surviving-member'],
    });
    expect(p.message).toMatch(/under-strength/);
    expect(p.message).toMatch(/SHORT BY 2/);
    expect(p.message).toMatch(/retry the replacement launch/);
    expect(killHandler).toHaveBeenCalledTimes(1); // the kill DID happen
  });

  it('reports at-target evidence without prescribing a relaunch after a capacity failure', async () => {
    persistedTarget = 2;
    listFleetPresence.mockReset()
      .mockResolvedValueOnce([row(LEADER), row(MEMBER)])
      .mockResolvedValueOnce([row(LEADER), row('surviving-member-a'), row('surviving-member-b')]);
    launchHandler.mockResolvedValue({ content: [{ type: 'text', text: 'launch failed: no capacity' }], isError: true });

    const p = parse(await tool.handler({ member: MEMBER, model: 'sonnet:high' } as never, {} as never));

    expect(p).toMatchObject({
      ok: false,
      verified: false,
      headcount: {
        target: 2,
        current: 2,
        shortfall: 0,
        underStrength: false,
        verdict: 'at-target',
        memberOwnerIds: ['surviving-member-a', 'surviving-member-b'],
      },
    });
    expect(p.message).toMatch(/remains at target/);
    expect(p.message).toMatch(/do not relaunch/);
    expect(p.message).not.toMatch(/down one member|retry the replacement launch/);
    expect(killHandler).toHaveBeenCalledTimes(1);
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
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction() });
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: true, newMember: expect.stringMatching(/^su-respawn-/) });
    expect(p.launchTransactionPersistence).toEqual({ status: 'persisted', attempts: 1, transactionId: 'tx-respawn' });
    expect(setFleetLaunchTransaction).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: { transactionId: 'tx-respawn', updatedAt: 2_000 },
      transaction: expect.objectContaining({
        state: 'verified',
        requestedMemberIds: [p.replacementOwner],
        verifiedMemberIds: [p.replacementOwner],
      }),
    }));
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
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction() });
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]', verifySec: 0 } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: false, verification: 'skipped' });
    expect(p.launchTransactionPersistence).toEqual({ status: 'persisted', attempts: 1, transactionId: 'tx-respawn' });
    expect(setFleetLaunchTransaction).toHaveBeenCalledWith(expect.objectContaining({
      transaction: expect.objectContaining({
        state: 'partial',
        unconfirmedMemberIds: [p.replacementOwner],
        recovery: { retryOwnerIds: [p.replacementOwner], nextAction: expect.stringContaining('skipped') },
      }),
    }));
    expect(p.message).toMatch(/NOT verified/);
    expect(p.message).toMatch(/leader-brief/);
  });

  it('degrades to unverified (not a false success) when the roster cannot be read', async () => {
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction() });
    listFleetPresence.mockReset();
    listFleetPresence.mockRejectedValue(new Error('pg down'));
    const res = await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never);
    const p = parse(res);
    expect(p).toMatchObject({ ok: true, verified: false, verification: 'unavailable' });
    expect(p.launchTransactionPersistence).toEqual({ status: 'persisted', attempts: 1, transactionId: 'tx-respawn' });
  });

  it('leaves the launch-failed path reporting unverified too', async () => {
    getFleet.mockResolvedValue({ lastLaunchTransaction: launchTransaction() });
    launchHandler.mockResolvedValue({ content: [{ type: 'text', text: 'launch failed' }], isError: true });
    const p = parse(await tool.handler({ member: MEMBER, model: 'opus[1m]' } as never, {} as never));
    expect(p).toMatchObject({ ok: false, verified: false });
    expect(p.launchTransactionPersistence).toEqual({ status: 'persisted', attempts: 1, transactionId: 'tx-respawn' });
    expect(setFleetLaunchTransaction).toHaveBeenCalledWith(expect.objectContaining({
      transaction: expect.objectContaining({
        state: 'partial',
        failed: [expect.objectContaining({ ownerId: p.replacementOwner, phase: 'spawn' })],
        recovery: { retryOwnerIds: [p.replacementOwner], nextAction: expect.stringContaining('launch failed') },
      }),
    }));
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

describe('awaitMemberDrain', () => {
  it('accepts the shared oracle ended verdict when presence is retained', async () => {
    let state = 'parked';
    let t = 0;
    const res = await awaitMemberDrain({
      memberOwnerId: MEMBER,
      list: async () => [row(LEADER), row(MEMBER)],
      resolveState: async () => state,
      timeoutMs: 5_000,
      intervalMs: 1_000,
      now: () => t,
      sleep: async (ms: number) => { t += ms; state = 'ended'; },
    });
    expect(res).toMatchObject({ verified: true, terminal: 'ended', sessionState: 'ended' });
  });
});
