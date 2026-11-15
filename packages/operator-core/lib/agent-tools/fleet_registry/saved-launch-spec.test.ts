import { describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import type { AdvSessionLaunchRecord } from '../../adv-sessions';
import type { FleetHeadcountTarget } from '../../agent-fleets-store';
import {
  LEGACY_FLEET_LAUNCH_SPEC_SOURCE,
  normalizePersistedFleetLaunchConfig,
  normalizePersistedFleetLaunchRole,
  resolveLoadedSavedFleetLaunchSpec,
  resolveSavedFleetLaunchSpec,
  savedFleetLaunchSpecFromLegacyRecord,
  savedFleetLaunchSpecFromConfig,
  savedOriginalMemberLaunchSpec,
} from './saved-launch-spec';

const target: FleetHeadcountTarget = {
  workspaceId: 'ws-test',
  fleetSlug: 'byoc',
  enabled: true,
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
    role: 'su',
    brief: 'drain the plan',
    launchContext: '/tmp/byoc.md',
    contextSize: 'trimmed',
    compactionLimit: 400_000,
    extraArgs: ['--safe-flag'],
  },
  nextAttemptAt: null,
  backoffMs: 0,
  lastError: null,
};

const base = {
  target,
  workspaceId: 'ws-test',
  fleetSlug: 'byoc',
  reusePath: 'fleet:respawn-member -> capability:launch-agent',
};

const legacyRecord: AdvSessionLaunchRecord = {
  workspaceId: 'ws-test',
  agent: 'codex',
  launchSpec: {
    v: 1,
    agent: 'codex',
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: 'fleet',
    model: 'gpt-5.6-sol:xhigh',
    planSlug: 'byoc-plan',
    launchedBy: 'su-leader',
    autoMode: true,
    drainMode: false,
    loopArmed: true,
    fleet: { slug: 'byoc', role: 'member' },
  },
  launchArgv: [
    'psu',
    '--no-picker',
    '--fleet=byoc',
    '--agent=codex',
    '--harness=papercusp',
    '--plan=byoc-plan',
    '--headless',
    '--carry=warm',
    '--account=default',
    '--model=gpt-5.6-sol:xhigh',
    '--compaction-limit=400000',
    '--role=su',
    '--launch-context=/tmp/byoc.md',
    '--context-size=trimmed',
    '--profile=engineer',
    '--brain',
    '--add-dir=/tmp/shared',
  ],
};

const incompleteLegacyRecord: AdvSessionLaunchRecord = {
  workspaceId: 'ws-test',
  agent: 'codex',
  launchSpec: {
    ...(legacyRecord.launchSpec as Record<string, unknown>),
    agent: undefined,
    harnessSlug: null,
    planSlug: null,
  },
  launchArgv: [
    'psu',
    '--no-picker',
    '--fleet=byoc',
    '--headless',
    '--carry=warm',
    '--account=default',
    '--model=gpt-5.6-sol:xhigh',
    '--compaction-limit=400000',
    '--role=su',
    '--launch-context=/tmp/byoc.md',
    '--context-size=trimmed',
    '--profile=engineer',
    '--brain',
    '--add-dir=/tmp/shared',
  ],
};

describe('saved fleet launch spec resolver (agent-launch-unification P-043)', () => {
  describe('D019 original member provenance', () => {
    const binding = { advSessionId: 71, ownerId: 'su-original', sessionId: 'native-original' };
    const receipt = { v: 1, ...binding, ...legacyRecord };
    const record = { ...legacyRecord, launchArgv: ['psu', '--account=auto'],
      launchSpec: { ...(legacyRecord.launchSpec as object), originalMemberLaunch: receipt } };

    it('restores original default/model/effort/placement/carry from the immutable receipt, not current auto argv', () => {
      const result = savedOriginalMemberLaunchSpec(record, binding, 'ws-test', 'byoc');
      expect(result).toMatchObject({ ok: true, config: {
        agent: 'codex', account: 'default', model: 'gpt-5.6-sol', effort: 'xhigh',
        headless: true, carry: 'warm',
      } });
    });

    it.each(['advSessionId', 'ownerId', 'sessionId'] as const)('refuses a changed original %s', (field) => {
      const changed = { ...record, launchSpec: { originalMemberLaunch: { ...receipt, [field]: 'changed' } } };
      expect(savedOriginalMemberLaunchSpec(changed, binding, 'ws-test', 'byoc').ok).toBe(false);
    });

    it('refuses missing original provenance instead of trusting a current owner launch', () => {
      expect(savedOriginalMemberLaunchSpec(legacyRecord, binding, 'ws-test', 'byoc').ok).toBe(false);
    });

    it('retains the immutable route after a lifecycle-proven native reanchor', () => {
      const current = { ...binding, sessionId: 'native-successor' };
      const custody = { workspaceId: 'ws-test', advSessionId: 71, ownerId: binding.ownerId,
        originalSessionId: binding.sessionId, currentSessionId: current.sessionId,
        originalEventId: '101', reanchorEventId: '102' };
      expect(savedOriginalMemberLaunchSpec({ ...record, originalMemberNativeCustody: custody }, current, 'ws-test', 'byoc'))
        .toMatchObject({ ok: true, config: { account: 'default', model: 'gpt-5.6-sol', carry: 'warm' } });
      for (const field of ['workspaceId', 'advSessionId', 'ownerId', 'originalSessionId', 'currentSessionId',
        'originalEventId', 'reanchorEventId'] as const) {
        const changed = { ...custody, [field]: field.endsWith('EventId') ? '' : 'unrelated' };
        expect(savedOriginalMemberLaunchSpec({ ...record, originalMemberNativeCustody: changed }, current, 'ws-test', 'byoc').ok,
          field).toBe(false);
      }
      expect(savedOriginalMemberLaunchSpec(record, current, 'ws-test', 'byoc').ok).toBe(false);
    });
  });

  describe('retained original invocation and artifact recovery', () => {
    function fixture() {
      const binding = { advSessionId: 71, ownerId: 'su-original', sessionId: 'native-successor', harnessSlug: 'papercusp' };
      const compile = (revision: string, profile = 'engineer') => compileAgentSpecification({
        source: { id: 'original-launch', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
        prompt: { role: 'su', text: `Retained ${revision} prompt.` }, inputClosure: [],
        mutableState: { ref: 'launch-state-v1', revision, value: {
          schemaVersion: 1, principal: { kind: 'su', role: 'su', profile },
          policy: { mcp: 'superuser', contextSize: 'trimmed', personaTier: 'fleet' }, stack: [],
        } },
      });
      const original = compile('state-original');
      const later = compile('state-current');
      const receipt = { specificationRevision: original.specificationRevision, stateRevision: 'state-original',
        specificationArtifact: original, stack: [] as string[], selectedIdentity: null as unknown };
      const args: Record<string, unknown> = { name: 'byoc', plan: 'byoc-plan', harness: 'papercusp', count: 1,
        agent: 'codex', model: 'gpt-6.1-sol:xhigh', account: 'auto', carry: 'warm', headless: true };
      const transaction = { version: 1, transactionId: 'original-epoch', launcherOwnerId: 'su-leader',
        requestedMemberIds: [binding.ownerId], openedMemberIds: [binding.ownerId], verifiedMemberIds: [binding.ownerId],
        requestedMembers: [{ index: 0, ownerId: binding.ownerId, agent: 'codex', model: 'gpt-6.1-sol:xhigh',
          account: 'auto', carry: 'warm', headless: true }] };
      const record = { workspaceId: 'ws-test', agent: 'codex' as const,
        launchArgv: ['psu', '--account=default', '--model=attractive-later-model'],
        launchSpec: { ...(legacyRecord.launchSpec as Record<string, unknown>), principalId: 'system:superuser',
          specificationRevision: later.specificationRevision, stateRevision: 'state-current', specificationArtifact: later,
          identityHistory: [receipt] },
        originalMemberHistoricalSource: { workspaceId: 'ws-test', fleetSlug: 'byoc', ...binding,
          originalSessionId: 'native-original', currentSessionId: binding.sessionId, transaction,
          invocation: { id: '201', actor: 'su-leader', harnessSlug: 'papercusp', args },
          originalApplied: { id: '101', specificationRevision: original.specificationRevision,
            stateRevision: 'state-original', actorId: binding.ownerId, principalId: 'system:superuser',
            sessionId: binding.ownerId, stack: [] as string[] },
          currentApplied: { id: '102', specificationRevision: later.specificationRevision,
            stateRevision: 'state-current', actorId: binding.ownerId, principalId: 'system:superuser',
            sessionId: binding.ownerId, stack: [] as string[] } },
      } satisfies AdvSessionLaunchRecord;
      const resolve = () => savedOriginalMemberLaunchSpec(record, binding, 'ws-test', 'byoc');
      return { record, binding, args, transaction, receipt, compile, resolve };
    }

    it('replays the exact original artifact and retains the complete source snapshot without backfilling', () => {
      const f = fixture();
      const before = structuredClone(f.record);
      const result = f.resolve();
      expect(result).toMatchObject({ ok: true, config: { account: 'auto', model: 'gpt-6.1-sol',
        effort: 'xhigh', carry: 'warm', headless: true }, saved: { member: { profile: 'engineer', stack: [] } } });
      expect(f.record).toEqual(before);
      if (!result.ok) throw new Error(result.message);
      expect(result.originalEvidence?.snapshot).toEqual(before);
      expect(result.originalEvidence?.receipt).toEqual(f.receipt);
      result.originalEvidence!.snapshot.launchArgv = [];
      expect(f.record).toEqual(before);
    });

    it('uses the original producer normalization to bind a fleet name to its slug', () => {
      const f = fixture();
      f.args.name = '  BYOC  ';
      expect(f.resolve()).toMatchObject({ ok: true });
    });

    it('preserves explicit visible placement, member precedence and supported profile/passthrough fields', () => {
      const f = fixture();
      f.args.account = 'default';
      f.args.profile = 'wrong-top-profile';
      f.args.members = [{ account: 'auto', headless: false, profile: 'engineer', contextSize: 'trimmed',
        compactionLimit: 400000, addDir: ["/tmp/Avi's work"], allowSubagents: false, brain: true,
        feature: 'exact-feature', display: ':110', extraArgs: ['--add-dir=/tmp/extra'], brief: 'Original first turn' }];
      f.args.launchContext = '/tmp/original-kickoff.md';
      f.args.supervise = false;
      f.args.confirmRouteSwitch = true;
      f.transaction.requestedMembers[0].headless = false;
      expect(f.resolve()).toMatchObject({ ok: true, saved: { member: { headless: false, account: 'auto',
        profile: 'engineer', compactionLimit: 400000, addDir: ["/tmp/Avi's work"], allowSubagents: false,
        brain: true, feature: 'exact-feature', display: ':110',
        extraArgs: ['--add-dir=/tmp/extra', '--no-subagents', '--persona-tier=fleet'] } },
        originalEvidence: { fieldDispositions: { launchContext: 'launch-only', supervise: 'launch-only',
          confirmRouteSwitch: 'guard', 'members[0].brief': 'launch-only' } } });
      const result = f.resolve();
      if (!result.ok) throw new Error(result.message);
      expect(result.saved.member).not.toHaveProperty('brief');
      expect(result.saved.member).not.toHaveProperty('launchContext');
    });

    const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
      ['wrong workspace', f => { f.record.originalMemberHistoricalSource.workspaceId = 'other'; }],
      ['wrong fleet', f => { f.record.originalMemberHistoricalSource.fleetSlug = 'other'; }],
      ['different original request fleet', f => { f.args.name = 'other-fleet'; }],
      ['wrong owner', f => { f.record.originalMemberHistoricalSource.ownerId = 'other'; }],
      ['wrong ADV', f => { f.record.originalMemberHistoricalSource.advSessionId++; }],
      ['wrong current native', f => { f.record.originalMemberHistoricalSource.currentSessionId = 'other'; }],
      ['missing original native (original307)', f => { f.record.originalMemberHistoricalSource.originalSessionId = ''; }],
      ['wrong invocation harness', f => { f.record.originalMemberHistoricalSource.invocation.harnessSlug = 'other'; }],
      ['wrong invocation actor', f => { f.record.originalMemberHistoricalSource.invocation.actor = 'other'; }],
      ['successor transaction', f => { Object.assign(f.transaction, { previousTransactionId: 'older' }); }],
      ['unopened member', f => { f.transaction.openedMemberIds = []; }],
      ['unverified member', f => { f.transaction.verifiedMemberIds = []; }],
      ['duplicate requested identity', f => { f.transaction.requestedMemberIds.push(f.binding.ownerId); }],
      ['duplicate member slot', f => { f.transaction.requestedMembers.push(f.transaction.requestedMembers[0]); }],
      ['wrong slot index', f => { f.transaction.requestedMembers[0].index = 1; }],
      ['wrong slot owner', f => { f.transaction.requestedMembers[0].ownerId = 'sibling'; }],
      ['missing original carry (original307)', f => { Object.assign(f.transaction.requestedMembers[0], { carry: null }); }],
      ['auto/default contradiction (original307)', f => { f.transaction.requestedMembers[0].account = 'default'; }],
      ['route effort mismatch', f => { f.args.effort = 'low'; }],
      ['unknown request key', f => { f.args.unknownControl = true; }],
      ['unknown member key', f => { f.args.members = [{ unknownControl: true }]; }],
      ['unsupported delegated seat', f => { f.args.fromSeats = true; }],
      ['different original request harness', f => { f.args.harness = 'other'; }],
      ['partial cohort count', f => { f.args.count = 2; }],
      ['unrepresentable extra argument', f => { f.args.extraArgs = ['--undocumented-control']; }],
      ['route override in extraArgs', f => { f.args.extraArgs = ['--account=default']; }],
      ['duplicate feature control', f => { f.args.feature = 'a'; f.args.extraArgs = ['--feature=b']; }],
      ['duplicate extra control', f => { f.args.extraArgs = ['--feature=a', '--feature=b']; }],
      ['wrong applied principal', f => { f.record.originalMemberHistoricalSource.originalApplied.principalId = 'other'; }],
      ['wrong applied actor', f => { f.record.originalMemberHistoricalSource.originalApplied.actorId = 'sibling'; }],
      ['wrong applied owner session', f => { f.record.originalMemberHistoricalSource.originalApplied.sessionId = 'sibling'; }],
      ['reversed custody', f => { f.record.originalMemberHistoricalSource.originalApplied.id = '999'; }],
      ['stale current applied pair', f => { f.record.originalMemberHistoricalSource.currentApplied.stateRevision = 'other'; }],
      ['missing exact original state pair', f => { f.receipt.stateRevision = 'other'; }],
      ['duplicate exact artifact pair', f => { f.record.launchSpec.identityHistory.push(structuredClone(f.receipt)); }],
      ['sibling valid artifact', f => { f.receipt.specificationArtifact = f.compile('state-sibling'); }],
      ['tampered artifact closure', f => { f.receipt.specificationArtifact = {
        ...structuredClone(f.receipt.specificationArtifact), specificationRevision: 'f'.repeat(64) }; }],
      ['unbound selected identity', f => { f.receipt.selectedIdentity = { ref: 'identity:sibling', sourceRevision: 'f'.repeat(64) }; }],
      ['valid artifact layer misrepresented as original selected root', f => {
        const layer = f.receipt.specificationArtifact.inputs.find(input => input.kind === 'blueprint-layer')!;
        f.receipt.selectedIdentity = { ref: `identity:${layer.ref}`, sourceRevision: layer.contentHash };
      }],
      ['applied stack mismatch', f => { f.record.originalMemberHistoricalSource.originalApplied.stack = ['identity:sibling']; }],
      ['request profile mismatch', f => { f.args.profile = 'sibling'; }],
      ['request policy mismatch', f => { f.args.contextSize = 'steward'; }],
      ['malformed present receipt', f => { Object.assign(f.record.launchSpec, { originalMemberLaunch: null }); }],
    ];
    it.each(mutations)('refuses %s with an independently passing control', (_name, mutate) => {
      const f = fixture();
      expect(f.resolve()).toMatchObject({ ok: true });
      mutate(f);
      expect(f.resolve()).toMatchObject({ ok: false, message: expect.any(String) });
    });
  });

  it('materializes the canonical command-neutral spec and defaults saved visibility to headless', () => {
    expect(savedFleetLaunchSpecFromConfig({ ...target.config, headless: undefined })).toMatchObject({
      plan: 'byoc-plan',
      harness: 'papercusp',
      member: {
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        headless: true,
        carry: 'warm',
      },
    });
  });

  it('normalizes the legacy fleet membership label without changing explicit personas', () => {
    expect(normalizePersistedFleetLaunchRole(' member ')).toBeUndefined();
    expect(normalizePersistedFleetLaunchRole('su')).toBe('su');
    expect(normalizePersistedFleetLaunchRole('builder')).toBe('builder');

    expect(
      normalizePersistedFleetLaunchConfig({ ...target.config, role: ' member ' }),
    ).not.toHaveProperty('role');
    expect(
      normalizePersistedFleetLaunchConfig({ ...target.config, role: 'builder' }),
    ).toMatchObject({ role: 'builder' });
  });

  it('normalizes a legacy membership role across config, saved, and effective recovery specs', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      target: { ...target, config: { ...target.config, role: 'member' } },
    });

    expect(result).toMatchObject({ ok: true, found: true });
    if (!result.ok || !result.found) throw new Error('expected saved resolution');
    expect(result.config).not.toHaveProperty('role');
    expect(result.saved.member).not.toHaveProperty('role');
    expect(result.effective.member).not.toHaveProperty('role');
  });

  it('preserves every omitted saved field and records provenance + reuse path', () => {
    const result = resolveLoadedSavedFleetLaunchSpec(base);
    expect(result).toMatchObject({
      ok: true,
      found: true,
      target: 16,
      effective: { plan: 'byoc-plan', harness: 'papercusp', member: { agent: 'codex', headless: true } },
      overrides: [],
      provenance: { source: 'fleet:headcount-target', workspaceId: 'ws-test', fleetSlug: 'byoc', target: 16 },
      reusePath: 'fleet:respawn-member -> capability:launch-agent',
    });
    if (!result.ok || !result.found) throw new Error('expected saved resolution');
    expect(result.preservedFields).toEqual([
      'plan',
      'harness',
      'agent',
      'model',
      'account',
      'headless',
      'carry',
      'role',
      'brief',
      'launchContext',
      'contextSize',
      'compactionLimit',
      'extraArgs',
    ]);
  });

  it('normalizes a repeated composed model spec instead of reporting a false conflict', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: { model: 'gpt-5.6-sol:xhigh', headless: true },
    });
    expect(result).toMatchObject({ ok: true, found: true, overrides: [] });
  });

  it('applies only allowlisted deltas and preserves an omitted effort across a bare model change', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: { model: 'gpt-5.6-terra', headless: false, brief: 'resume the held lane' },
      allowDeltas: ['model', 'headless', 'brief'],
    });
    expect(result).toMatchObject({
      ok: true,
      found: true,
      effective: {
        member: {
          model: 'gpt-5.6-terra',
          effort: 'xhigh',
          headless: false,
          brief: 'resume the held lane',
          carry: 'warm',
        },
      },
    });
    if (!result.ok || !result.found) throw new Error('expected saved resolution');
    expect(result.overrides.map((row) => row.field)).toEqual(['model', 'headless', 'brief']);
    expect(result.overrides[0]).toMatchObject({
      saved: 'gpt-5.6-sol:xhigh',
      requested: 'gpt-5.6-terra:xhigh',
      provenance: { source: 'fleet:headcount-target' },
      reusePath: base.reusePath,
    });
  });

  it('fails closed with saved/requested/provenance/reuse-path diagnostics for unaudited differences', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: { account: 'auto', headless: false },
    });
    expect(result).toMatchObject({ ok: false, found: true, error: 'saved_launch_spec_conflict' });
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflicts).toEqual([
      {
        field: 'account',
        saved: 'default',
        requested: 'auto',
        provenance: { source: 'fleet:headcount-target', workspaceId: 'ws-test', fleetSlug: 'byoc', target: 16 },
        reusePath: base.reusePath,
      },
      {
        field: 'headless',
        saved: true,
        requested: false,
        provenance: { source: 'fleet:headcount-target', workspaceId: 'ws-test', fleetSlug: 'byoc', target: 16 },
        reusePath: base.reusePath,
      },
    ]);
    expect(result.message).toContain('Saved launch spec conflict');
  });

  it('rejects per-member, launch-context, claim-kind, and unpersisted reconstruction', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      requested: {
        members: [{ model: 'gpt-5.6-terra' }],
        perMemberLaunchContext: ['/tmp/other.md'],
        claimKinds: ['bug'],
        allowSubagents: true,
      },
    });
    expect(result).toMatchObject({ ok: false, error: 'saved_launch_spec_conflict' });
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflicts.map((row) => row.field)).toEqual([
      'members',
      'perMemberLaunchContext',
      'claimKinds',
      'allowSubagents',
    ]);
  });

  it('distinguishes a fresh launch from a recovery that requires a saved spec', () => {
    expect(resolveLoadedSavedFleetLaunchSpec({ ...base, target: null })).toMatchObject({
      ok: true,
      found: false,
    });
    expect(resolveLoadedSavedFleetLaunchSpec({ ...base, target: null, requireSaved: true })).toMatchObject({
      ok: false,
      found: false,
      error: 'saved_launch_spec_missing',
    });
  });

  it('treats a preserved one-seat profile as canonical after auto-top-up is disabled', () => {
    const result = resolveLoadedSavedFleetLaunchSpec({
      ...base,
      target: { ...target, target: 1 },
      requireSaved: true,
      requested: { headless: true },
    });
    expect(result).toMatchObject({
      ok: true,
      found: true,
      target: 1,
      effective: { member: { headless: true } },
    });
  });

  it('fails closed when the canonical read or stored model/effort pair is invalid', async () => {
    const readTarget = vi.fn().mockRejectedValue(new Error('pg unavailable'));
    await expect(resolveSavedFleetLaunchSpec({ ...base, readTarget })).resolves.toMatchObject({
      ok: false,
      found: false,
      error: 'saved_launch_spec_read_failed',
    });

    expect(
      resolveLoadedSavedFleetLaunchSpec({
        ...base,
        target: { ...target, config: { ...target.config, model: undefined, effort: 'xhigh' } },
      }),
    ).toMatchObject({ ok: false, found: true, error: 'saved_launch_spec_invalid' });
  });
});

describe('legacy adv_sessions fleet launch-spec fallback', () => {
  it('normalizes the retired full spelling before merge and reports the deprecation', async () => {
    const fullRecord: AdvSessionLaunchRecord = {
      ...legacyRecord,
      launchSpec: {
        ...(legacyRecord.launchSpec as Record<string, unknown>),
        contextSize: 'full',
      },
      launchArgv: (legacyRecord.launchArgv as string[]).map((item) =>
        item === '--context-size=trimmed' ? '--context-size=full' : item,
      ),
    };
    const parsed = savedFleetLaunchSpecFromLegacyRecord(fullRecord, 'ws-test', 'byoc');
    expect(parsed).toMatchObject({
      ok: true,
      normalizedLegacyContextSize: true,
      config: { contextSize: 'trimmed' },
      saved: { member: { contextSize: 'trimmed' } },
    });
    const resolved = await resolveSavedFleetLaunchSpec({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      memberOwnerId: 'su-legacy-member',
      requireSaved: true,
      readTarget: vi.fn().mockResolvedValue(null),
      readLegacy: vi.fn().mockResolvedValue(fullRecord),
      reusePath: base.reusePath,
    });
    expect(resolved).toMatchObject({
      ok: true,
      effective: { member: { contextSize: 'trimmed' } },
      deprecations: [expect.stringMatching(/full.*deprecated.*trimmed/i)],
    });
  });

  it('reconstructs the command-neutral recipe from the durable launch record', () => {
    const result = savedFleetLaunchSpecFromLegacyRecord(legacyRecord, 'ws-test', 'byoc');
    expect(result).toMatchObject({
      ok: true,
      config: {
        plan: 'byoc-plan',
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        account: 'default',
        headless: true,
        carry: 'warm',
        role: 'su',
        launchContext: '/tmp/byoc.md',
        contextSize: 'trimmed',
        compactionLimit: 400000,
        extraArgs: ['--profile=engineer', '--brain', '--add-dir=/tmp/shared'],
      },
      saved: {
        plan: 'byoc-plan',
        harness: 'papercusp',
        member: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', headless: true },
      },
    });
  });

  it('prefers the retained owner record over the homogeneous fleet recipe', async () => {
    const leaderRecord: AdvSessionLaunchRecord = {
      ...legacyRecord,
      launchSpec: {
        ...(legacyRecord.launchSpec as Record<string, unknown>),
        model: 'gpt-6-astra:high',
        fleet: { slug: 'byoc', role: 'leader' },
      },
      launchArgv: (legacyRecord.launchArgv as string[]).map((item) =>
        item.startsWith('--model=') ? '--model=gpt-6-astra:high' : item,
      ),
    };
    const readTarget = vi.fn().mockResolvedValue(target);
    const resolved = await resolveSavedFleetLaunchSpec({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      memberOwnerId: 'su-leader',
      preferMemberRecord: true,
      readTarget,
      readLegacy: vi.fn().mockResolvedValue(leaderRecord),
      requireSaved: true,
      reusePath: 'fleet leader recovery -> capability:launch-agent resume',
    });
    expect(resolved).toMatchObject({
      ok: true,
      provenance: { source: LEGACY_FLEET_LAUNCH_SPEC_SOURCE },
      effective: { member: { model: 'gpt-6-astra', effort: 'high' } },
    });
    expect(readTarget).not.toHaveBeenCalled();
  });

  it('recovers a planless legacy record from the persisted backend plus a trusted harness fallback', () => {
    expect(savedFleetLaunchSpecFromLegacyRecord(incompleteLegacyRecord, 'ws-test', 'byoc')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/malformed|harness|agent/i),
    });

    const result = savedFleetLaunchSpecFromLegacyRecord(
      incompleteLegacyRecord,
      'ws-test',
      'byoc',
      { harness: 'papercusp' },
    );
    expect(result).toMatchObject({
      ok: true,
      config: {
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        account: 'default',
        headless: true,
        carry: 'warm',
        contextSize: 'trimmed',
        compactionLimit: 400_000,
        extraArgs: ['--profile=engineer', '--brain', '--add-dir=/tmp/shared'],
      },
      saved: {
        harness: 'papercusp',
        member: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', headless: true },
      },
    });
    if (!result.ok) throw new Error('expected legacy recovery');
    expect(result.config).not.toHaveProperty('plan');
    expect(result.saved).not.toHaveProperty('plan');
  });

  it('recovers a standalone source after its current fleet membership is attested', () => {
    const standalone: AdvSessionLaunchRecord = {
      ...legacyRecord,
      launchSpec: { ...(legacyRecord.launchSpec as Record<string, unknown>), fleet: null, harnessSlug: null },
      launchArgv: (legacyRecord.launchArgv as string[]).filter((arg) =>
        !arg.startsWith('--fleet=') && !arg.startsWith('--harness=')),
    };
    expect(savedFleetLaunchSpecFromLegacyRecord(standalone, 'ws-test', 'byoc', {
      harness: 'papercusp', postLaunchFleet: 'byoc',
    })).toMatchObject({ ok: true, config: {
      harness: 'papercusp', agent: 'codex', model: 'gpt-5.6-sol',
      account: 'default', headless: true, carry: 'warm',
    } });
    for (const postLaunchFleet of [undefined, 'another-fleet']) {
      expect(savedFleetLaunchSpecFromLegacyRecord(standalone, 'ws-test', 'byoc', {
        harness: 'papercusp', postLaunchFleet,
      })).toMatchObject({ ok: false, message: expect.stringContaining('fleet is missing') });
    }
    expect(savedFleetLaunchSpecFromLegacyRecord({
      ...standalone, launchArgv: [...standalone.launchArgv as string[], '--fleet=byoc'],
    }, 'ws-test', 'byoc', { harness: 'papercusp', postLaunchFleet: 'byoc' }))
      .toMatchObject({ ok: false, message: expect.stringContaining('fleet is missing') });
  });

  it('fails closed when adv_sessions.agent conflicts with the legacy launch record', () => {
    expect(
      savedFleetLaunchSpecFromLegacyRecord({ ...legacyRecord, agent: 'claude' }, 'ws-test', 'byoc'),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('adv_sessions.agent'),
    });
  });

  it('accepts a stale source fleet when launch_spec and launch_argv agree', () => {
    const historicalFleet = 'byoc-before-rejoin';
    const staleRecord: AdvSessionLaunchRecord = {
      ...legacyRecord,
      launchSpec: {
        ...(legacyRecord.launchSpec as Record<string, unknown>),
        fleet: { slug: historicalFleet, role: 'member' },
      },
      launchArgv: (legacyRecord.launchArgv as string[]).map((item) =>
        item === '--fleet=byoc' ? `--fleet=${historicalFleet}` : item,
      ),
    };

    expect(savedFleetLaunchSpecFromLegacyRecord(staleRecord, 'ws-test', 'byoc')).toMatchObject({
      ok: true,
      config: { harness: 'papercusp', agent: 'codex', model: 'gpt-5.6-sol' },
    });
  });

  it('fails closed when the two persisted source fleet fields disagree', () => {
    const mismatchedRecord: AdvSessionLaunchRecord = {
      ...legacyRecord,
      launchArgv: (legacyRecord.launchArgv as string[]).map((item) =>
        item === '--fleet=byoc' ? '--fleet=other-historical-fleet' : item,
      ),
    };

    expect(savedFleetLaunchSpecFromLegacyRecord(mismatchedRecord, 'ws-test', 'byoc')).toMatchObject({
      ok: false,
      message: expect.stringContaining('fleet differs between launch_spec'),
    });
  });

  it('threads trusted legacy fallbacks through the resolver without changing canonical behavior', async () => {
    const result = await resolveSavedFleetLaunchSpec({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      memberOwnerId: 'su-legacy-member',
      requireSaved: true,
      readTarget: vi.fn().mockResolvedValue(null),
      readLegacy: vi.fn().mockResolvedValue(incompleteLegacyRecord),
      legacyFallbacks: { harness: 'papercusp' },
      requested: { headless: false },
      allowDeltas: ['headless'],
      reusePath: base.reusePath,
    });
    expect(result).toMatchObject({
      ok: true,
      found: true,
      target: 1,
      effective: { plan: undefined, harness: 'papercusp', member: { agent: 'codex', headless: false } },
      provenance: { source: LEGACY_FLEET_LAUNCH_SPEC_SOURCE, target: null },
    });
  });

  it('uses the owner-scoped legacy record only when the canonical target is absent', async () => {
    const readTarget = vi.fn().mockResolvedValue(null);
    const readLegacy = vi.fn().mockResolvedValue(legacyRecord);
    const result = await resolveSavedFleetLaunchSpec({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      memberOwnerId: 'su-legacy-member',
      requireSaved: true,
      readTarget,
      readLegacy,
      reusePath: base.reusePath,
    });
    expect(result).toMatchObject({
      ok: true,
      found: true,
      target: 1,
      provenance: {
        source: LEGACY_FLEET_LAUNCH_SPEC_SOURCE,
        workspaceId: 'ws-test',
        fleetSlug: 'byoc',
        target: null,
      },
    });
    expect(readLegacy).toHaveBeenCalledWith('su-legacy-member', 'ws-test');

    const canonical = vi.fn().mockResolvedValue(target);
    const ignoredLegacy = vi.fn().mockResolvedValue(legacyRecord);
    const canonicalResult = await resolveSavedFleetLaunchSpec({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      memberOwnerId: 'su-legacy-member',
      requireSaved: true,
      readTarget: canonical,
      readLegacy: ignoredLegacy,
      reusePath: base.reusePath,
    });
    expect(canonicalResult).toMatchObject({ ok: true, found: true, target: 16, provenance: { source: 'fleet:headcount-target' } });
    expect(ignoredLegacy).not.toHaveBeenCalled();
  });

  it('fails closed for workspace/fleet mismatches, malformed records, and missing records', async () => {
    expect(savedFleetLaunchSpecFromLegacyRecord({ ...legacyRecord, workspaceId: 'other-workspace' }, 'ws-test', 'byoc')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/workspace/i),
    });
    expect(
      savedFleetLaunchSpecFromLegacyRecord(
        {
          ...legacyRecord,
          launchSpec: { ...(legacyRecord.launchSpec as Record<string, unknown>), fleet: { slug: 'other-fleet', role: 'member' } },
        },
        'ws-test',
        'byoc',
      ),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/fleet/i) });
    expect(savedFleetLaunchSpecFromLegacyRecord({ ...legacyRecord, launchSpec: null }, 'ws-test', 'byoc')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/missing or malformed/i),
    });

    const result = await resolveSavedFleetLaunchSpec({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      memberOwnerId: 'su-missing-member',
      requireSaved: true,
      readTarget: vi.fn().mockResolvedValue(null),
      readLegacy: vi.fn().mockResolvedValue(null),
      reusePath: base.reusePath,
    });
    expect(result).toMatchObject({ ok: false, found: false, error: 'saved_launch_spec_missing' });
  });
});
