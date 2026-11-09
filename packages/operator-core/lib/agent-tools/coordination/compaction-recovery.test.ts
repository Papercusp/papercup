/**
 * compaction-recovery — unit tests (EI-19952485326105760).
 *
 * The post-compaction recovery fold's held-item checkpoint render used to do
 * a PLAIN head-only `.slice(0, CHECKPOINT_CAP)` — the exact same defect the
 * carry-brief cold-extras render already fixed via `capPreservingOperative`
 * (see carry-brief.test.ts's own EI-19952485326105760 describe block). This
 * file is the surface the incident's own bug report named
 * (`payload.paths: ["packages/operator-core/lib/agent-tools/coordination"]`)
 * and it was left unpatched when the carry-brief fix landed. Guard both
 * surfaces independently so they can't silently diverge again.
 *
 * Dependencies are dynamically imported inside buildCompactionRecovery, so
 * every leg is mocked at the module boundary and made to fail/resolve-empty
 * except the one under test (held-item checkpoints) — every leg is
 * best-effort in the implementation, so a failing mock never throws.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ControlAnchor } from './control-anchor';
import type { PlanRow } from '../plans/source';

const frozenPlanSource = vi.hoisted((): { row: PlanRow | null } => ({ row: null }));

vi.mock('../../session-brief-mission', () => ({
  readCurrentMissionContinuity: vi.fn(async () => ({ availability: 'absent' as const })),
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  listAllProjectedTools: () => [{
    expose: { mcp: { name: 'state:read' } },
    inputSchema: { type: 'object', properties: { cell: { type: 'string' } }, additionalProperties: false },
    capabilities: [],
    effect: 'read',
  }],
  projectedToolRegistryRevision: () => 'compaction-recovery-read-only-test-registry',
}));

vi.mock('../../search/self-session', () => ({
  resolveSelfSession: vi.fn(async () => null),
}));
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: vi.fn(async () => null),
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleetHeadcountTarget: vi.fn(async () => null),
}));
vi.mock('./control-anchor', () => ({
  buildAndPersistControlAnchor: vi.fn(async () => {
    throw new Error('not exercised by this test');
  }),
  controlStateHash: vi.fn(() => 'control-state-hash'),
}));
vi.mock('../../memory/session-epoch-ledger', () => ({
  currentSessionEpoch: vi.fn(async () => 23),
}));
vi.mock('../../carry-probe-eval', () => ({
  carriedProbeBlockForDelivery: vi.fn(async () => null),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));
vi.mock('../mode/set', () => ({
  wakeSourceLostWarning: vi.fn(() => undefined),
}));
vi.mock('../plans/source', () => ({
  getPlanRow: vi.fn(async (slug: string, opts: { workspaceId?: string; harnessSlug?: string }) => frozenPlanSource.row ?? ({
    workspaceId: opts.workspaceId ?? 'ws-1',
    harnessSlug: opts.harnessSlug ?? 'h',
    planSlug: slug,
    content: `---\ntitle: Current authority\nslug: ${slug}\nstatus: ready\ncreated: 2026-08-25\nupdated: 2026-08-25\n---\n\n## Decisions\n\n### D-001 — newest rule\nDate: 2026-08-25\nCurrent authority wins.\n\n## Phase 1\n\n- **P-017** \`wip\` current task\n`,
    contentHash: 'plan-hash-17',
    version: 17,
    status: 'ready',
  })),
}));
vi.mock('../plans/spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/spec-clauses-store')>()),
  listSpecClauses: vi.fn(async () => [{
    specId: 'SPEC-P-017',
    revision: 4,
    contentHash: 'spec-hash-4',
    planItemId: 'P-017',
  }]),
}));

const CONTROL: ControlAnchor = {
  schemaVersion: 'ctrl-v1',
  generation: 17,
  state: {
    modes: ['auto'],
    loop: { active: true, intervalSec: 60 },
    wakeSource: 'loop',
    carry: 'warm',
    route: { kind: 'self' },
    scope: {
      workspace: 'ws-1',
      harness: 'h',
      plan: 'fleet-deltas-leader-primitives-2026-07-10',
      items: ['P-017'],
    },
  },
  provenance: {
    source: 'harness_shared.session_briefs.control_state',
    ownerId: 'owner-x',
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  resync: {
    on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
    verb: 'coord:orient',
    args: { afterCompaction: true },
    rule: 'replace-full-never-merge-behind',
  },
  budget: { estimatedTokens: 100, maxTokens: 384 },
};

const OLDER_PLAN =
  'the owner report is artifact https://claude.ai/example-artifact-url; republish that path to keep the URL. ' +
  `${'filler context '.repeat(90)}`;
const SUPERSEDING_BLOCK =
  '## ⛔ SUPERSEDING OWNER DIRECTIVE — NO MORE STATUS-REPORT ARTIFACTS\n' +
  `[owner 2026-08-09] "i dont need the live reports stop that"`;
const CHECKPOINT = `${OLDER_PLAN}\n\n${SUPERSEDING_BLOCK}`;

vi.mock('../../carry-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../carry-brief')>()),
  readHeldWorkItems: vi.fn(async () => [
    {
      id: 'WI-37110',
      title: 'republish the report',
      body: null,
      harness: 'h',
      checkpoint: CHECKPOINT,
      holderProof: { ownerId: 'owner-x', workspaceId: 'ws-1' },
    },
  ]),
}));

// Complete the partial mock's real imports before any case installs a one-shot
// control/source response. A first selected case must not inherit initialization
// from a preceding test or have its response consumed by a transitive import.
beforeAll(async () => {
  const { buildCompactionRecovery } = await import('./compaction-recovery');
  const initialized = await buildCompactionRecovery('owner-x', 'ws-1', { sessionRole: 'judge' });
  // Entering the partial carry-brief mock directly can expose its real store to
  // a circular importer. Initialize through the subject's dependency order and
  // fail setup if its store seam was not installed; never hide that as no items.
  expect(initialized.coverage.heldItems).toBe(true);
  expect(initialized.checkpoints?.[0]?.id).toBe('WI-37110');
});

describe('buildCompactionRecovery — held-item checkpoint fold', () => {
  it('routes judge recovery through authorized work-item and self-transcript reads', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', { sessionRole: 'judge' });

    expect(recovery.selfRecall).toContain("work_items:list { mine:true, notTerminal:true }");
    expect(recovery.selfRecall).toContain('work_items:get { id, harness }');
    expect(recovery.selfRecall).toContain("sessions:read { session:'self', tail:40 }");
    expect(recovery.selfRecall).not.toContain('sessions:search {');
  });

  it.each(['ready', 'blocked', 'transferred', 'unknown'] as const)(
    'recovers the remaining mission without replacing the selected route: %s', async disposition => {
      const [{ readCurrentMissionContinuity }, { buildAndPersistControlAnchor }, { buildCompactionRecovery }] =
        await Promise.all([import('../../session-brief-mission'), import('./control-anchor'), import('./compaction-recovery')]);
      vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce(CONTROL);
      const projection = {
        assignmentRef: 'plan:unfinished', ownerDirectiveRef: 'order:31', objectiveRefs: ['plan:unfinished'],
        completionCriteriaRefs: ['plan:unfinished#Requirements'], accountableOwner: 'owner-x',
        custodyGeneration: 1, assignmentRevision: 7, currentWorkRef: 'review:closed',
        stateAvailability: disposition === 'unknown' ? 'unknown' as const : 'available' as const,
        disposition, blockerRef: disposition === 'blocked' ? 'explicit-pause' : null,
        nextActionRef: disposition === 'ready' ? 'plan:unfinished' : null,
        interruptionFrames: [], omittedFrames: [], unknownReason: disposition === 'unknown' ? 'no-successor-receipt' : null,
      };
      vi.mocked(readCurrentMissionContinuity).mockResolvedValueOnce({ availability: 'available', revision: 4, projection });
      const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
      expect(readCurrentMissionContinuity).toHaveBeenLastCalledWith({ ownerId: 'owner-x', workspaceId: 'ws-1' });
      expect(recovery.mission).toEqual({ availability: 'available', revision: 4, projection });
      expect(recovery.control?.state.route).toEqual(CONTROL.state.route);
    },
  );

  it('sanity: the incident shape exceeds CHECKPOINT_CAP(1200) and a plain cut lands before the superseding block', () => {
    expect(CHECKPOINT.length).toBeGreaterThan(1200);
    expect(CHECKPOINT.slice(0, 1199)).not.toContain('SUPERSEDING');
  });

  it('preserves a superseding owner directive past the CHECKPOINT_CAP cut', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
    expect(recovery.checkpoints).toBeDefined();
    const ckpt = recovery.checkpoints?.[0]?.checkpoint ?? '';
    expect(ckpt).toContain('⚠ OPERATIVE:');
    expect(ckpt).toContain('NO MORE STATUS-REPORT ARTIFACTS');
    expect(ckpt).toContain('i dont need the live reports stop that');
  });

  it('still truncates — this is preservation, not a budget bypass', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
    const ckpt = recovery.checkpoints?.[0]?.checkpoint ?? '';
    // Bounded well under the raw checkpoint length; not the full ~1.4KB body.
    expect(ckpt.length).toBeLessThan(CHECKPOINT.length);
    expect(ckpt).toContain('…');
  });

  // EI-20451119672468393: the fold re-delivers held items ACROSS harnesses, so
  // each row must name its CANONICAL harness and the re-fetch hint must be
  // harness-qualified — an unqualified `work_items:get { id }` from a
  // differently-scoped successor session made a real carried item (WI-3496,
  // harness papercusp, read from a sb-devboard-hive session) look GONE.
  it('folds the canonical harness + a harness-qualified re-fetch hint (EI-20451119672468393)', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
    const row = recovery.checkpoints?.[0];
    expect(row?.harness).toBe('h');
    expect(row?.checkpointTruncated?.more).toBe("work_items:get { id: 'WI-37110', harness: 'h' }");
    // No session harness supplied ⇒ no cross-harness verdict either way.
    expect(row?.crossHarnessNote).toBeUndefined();
  });

  it('flags a held item whose canonical harness contradicts the session harness', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'sb-devboard-hive',
    });
    const note = recovery.checkpoints?.[0]?.crossHarnessNote ?? '';
    expect(note).toContain("'h'");
    expect(note).toContain("'sb-devboard-hive'");
    expect(note).toContain('NOT gone');
  });

  it('emits no cross-harness note when the session harness matches', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', { sessionHarness: 'h' });
    expect(recovery.checkpoints?.[0]?.crossHarnessNote).toBeUndefined();
  });

  it('suppresses a missing-proof item to a read-only ownership warning', async () => {
    const { renderHeldItemOwnershipWarning } = await import('../../carry-brief');
    expect(renderHeldItemOwnershipWarning('owner-x', 'ws-1', { id: 'WI-unverified', harness: 'h' }))
      .toContain('no holder proof');
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', {
      heldItems: [{
        id: 'WI-unverified',
        title: 'private title',
        body: 'private body',
        harness: 'h',
        checkpoint: 'private checkpoint',
      }],
    });
    const row = recovery.checkpoints?.[0];
    expect(row).toMatchObject({
      id: 'WI-unverified',
      harness: 'h',
      checkpoint: null,
    });
    expect(row?.ownershipWarning).toContain('no holder proof');
    expect(row).not.toHaveProperty('title');
    expect(row).not.toHaveProperty('body');
    expect(row).not.toHaveProperty('checkpointTruncated');
  });

  it('suppresses an owner-mismatched item to a read-only ownership warning', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', {
      heldItems: [{
        id: 'WI-mismatched',
        title: 'private title',
        body: 'private body',
        harness: 'h',
        checkpoint: 'private checkpoint',
        holderProof: { ownerId: 'other-owner', workspaceId: 'ws-1' },
      }],
    });
    const row = recovery.checkpoints?.[0];
    expect(row).toMatchObject({
      id: 'WI-mismatched',
      harness: 'h',
      checkpoint: null,
    });
    expect(row?.ownershipWarning).toContain("holder proof names owner 'other-owner'");
    expect(row).not.toHaveProperty('title');
    expect(row).not.toHaveProperty('body');
  });
});

describe('buildAutomaticCompactionRecovery — deterministic boundary marker (D-017/P-017)', () => {
  it('publishes the marker-aware success/fallback contract with coord:declare-intent live field names (D-018)', async () => {
    const { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } = await import('./compaction-recovery');
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).toContain('⟦post-compaction-recovery⟧');
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).toContain('do not call coord:orient');
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).toContain(
      'coord:declare-intent { intent, current_plan_slug, items }',
    );
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).toContain('content-mismatched');
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).toContain(
      'legacy marker/CTRL pair has no stateHash and its generation mismatches',
    );
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).not.toContain('planItems');
  });

  it('stamps a complete recovery with the current memory epoch + control generation and reuses supplied held items', async () => {
    const [{ buildAndPersistControlAnchor }, { readHeldWorkItems }, { buildAutomaticCompactionRecovery }] =
      await Promise.all([
        import('./control-anchor'),
        import('../../carry-brief'),
        import('./compaction-recovery'),
      ]);
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce(CONTROL);
    vi.mocked(readHeldWorkItems).mockClear();

    const supplied = [
      {
        id: 'WI-41558',
        title: 'automatic recovery',
        body: 'reuse the carry surface',
        harness: 'h',
        checkpoint: 'P-017 in progress',
        checkpointUpdatedAtMs: Date.parse('2026-08-25T00:00:00.000Z'),
        holderProof: { ownerId: 'owner-x', workspaceId: 'ws-1' },
      },
    ];
    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'h',
      heldItems: supplied,
    });

    expect(readHeldWorkItems).not.toHaveBeenCalled();
    expect(delivery.marker).toEqual({
      schemaVersion: 'post-compaction-recovery-v1',
      complete: true,
      memoryEpoch: 23,
      controlGeneration: 17,
      controlStateHash: expect.any(String),
      fallback: {
        verb: 'coord:orient',
        args: { afterCompaction: true },
        when: [
          'marker-absent',
          'marker-incomplete',
          'control-state-mismatch',
          'legacy-control-generation-mismatch',
        ],
      },
    });
    expect(delivery.recovery.control).toEqual(CONTROL);
    expect(delivery.recovery.loop).toEqual({ active: true, intervalSec: 60 });
    expect(delivery.recovery.checkpoints?.[0]).toMatchObject({
      id: 'WI-41558',
      harness: 'h',
      checkpoint: 'P-017 in progress',
    });
    expect(delivery.recovery.coverage.planAuthority).toBe(true);
    expect(delivery.recovery.planAuthority).toMatchObject({
      resolution: 'current',
      controlGeneration: 17,
      workspaceId: 'ws-1',
      harness: 'h',
      planSlug: 'fleet-deltas-leader-primitives-2026-07-10',
      version: 17,
      contentHash: 'plan-hash-17',
      items: [{ id: 'P-017', status: 'wip', missing: false }],
      specs: [{ specId: 'SPEC-P-017', revision: 4, contentHash: 'spec-hash-4' }],
    });
    expect(delivery.marker.controlStateHash).toBeTruthy();
  });

  it.each(['older-task', 'all-task', 'no-task'])('keeps bounded task-applicable recovery authority: %s', async mode => {
    const [{ getPlanRow }, { buildAndPersistControlAnchor }, { buildAutomaticCompactionRecovery }] =
      await Promise.all([import('../plans/source'), import('./control-anchor'), import('./compaction-recovery')]);
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce(CONTROL);
    const decisions = Array.from({ length: 9 }, (_, index) => {
      const id = `D-${String(index + 1).padStart(3, '0')}`;
      const task = mode === 'all-task' || (mode === 'older-task' && index === 0);
      return `### ${id} — ruling\nDate: 2026-08-25\n${'Historical context. '.repeat(40)}\n\n${task ? 'P-017 remains paused until the original author releases it.' : 'Unrelated preparation.'}`;
    }).join('\n\n');
    vi.mocked(getPlanRow).mockResolvedValueOnce({
      workspaceId: 'ws-1', harnessSlug: 'h', planSlug: CONTROL.state.scope.plan!,
      content: `---\ntitle: scoped authority\nslug: scoped-authority\nstatus: ready\n---\n\n## Decisions\n\n${decisions}`,
      contentHash: 'scoped-hash', version: 18, status: 'ready',
    } as Awaited<ReturnType<typeof getPlanRow>>);
    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { sessionHarness: 'h', heldItems: [] });
    const authority = delivery.recovery.planAuthority;
    expect(authority?.resolution).toBe('current');
    if (authority?.resolution !== 'current') throw new Error('missing authority');
    expect(authority.decisions.map(d => d.id)).toEqual(mode === 'older-task'
      ? ['D-001', 'D-005', 'D-006', 'D-007', 'D-008', 'D-009']
      : ['D-004', 'D-005', 'D-006', 'D-007', 'D-008', 'D-009']);
    expect(authority.decisionsMore).toBe(3);
    expect(authority.omittedDecisionRefs).toEqual((mode === 'older-task'
      ? ['D-002', 'D-003', 'D-004'] : ['D-001', 'D-002', 'D-003']).map(id => `${CONTROL.state.scope.plan}#${id}`));
    if (mode !== 'no-task') {
      expect(authority.decisions[0].body).toContain('P-017 remains paused');
      expect(authority.decisions[0].truncated).toBe(true);
      expect(authority.taskLinkedDecisions).toBe(mode === 'older-task' ? 1 : 6);
    }
    expect(delivery.marker.complete).toBe(true);
  });

  it('uses the matching fleet launch plan only when the control scope has no plan', async () => {
    const [
      { getFleetHeadcountTarget },
      { getPlanRow },
      { buildAndPersistControlAnchor },
      { buildAutomaticCompactionRecovery },
    ] = await Promise.all([
      import('../../agent-fleets-store'),
      import('../plans/source'),
      import('./control-anchor'),
      import('./compaction-recovery'),
    ]);
    const fleetControl: ControlAnchor = {
      ...CONTROL,
      state: {
        ...CONTROL.state,
        route: { kind: 'fleet', fleet: 'feature-drain', role: 'member' },
        scope: { ...CONTROL.state.scope, harness: null, plan: null, items: [] },
      },
    };
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce(fleetControl);
    vi.mocked(getFleetHeadcountTarget).mockClear().mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'feature-drain',
      enabled: false,
      target: 1,
      config: { plan: 'feature-plan', harness: 'h', agent: 'codex' },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    vi.mocked(getPlanRow).mockClear();

    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { heldItems: [] });

    expect(getFleetHeadcountTarget).toHaveBeenCalledWith('ws-1', 'feature-drain');
    expect(getPlanRow).toHaveBeenCalledWith('feature-plan', {
      workspaceId: 'ws-1',
      harnessSlug: 'h',
    });
    expect(delivery.marker.complete).toBe(true);
    expect(delivery.recovery.coverage.planAuthority).toBe(true);
    expect(delivery.recovery.planAuthority).toMatchObject({
      resolution: 'current',
      planSlug: 'feature-plan',
      harness: 'h',
    });
  });

  it('keeps plan authority not-applicable for a planless claim-spec fleet profile', async () => {
    const [
      { getFleetHeadcountTarget },
      { getPlanRow },
      { buildAndPersistControlAnchor },
      { buildAutomaticCompactionRecovery },
    ] = await Promise.all([
      import('../../agent-fleets-store'),
      import('../plans/source'),
      import('./control-anchor'),
      import('./compaction-recovery'),
    ]);
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce({
      ...CONTROL,
      state: {
        ...CONTROL.state,
        route: { kind: 'fleet', fleet: 'claim-spec-drain', role: 'member' },
        scope: { ...CONTROL.state.scope, plan: null, items: [] },
      },
    });
    vi.mocked(getFleetHeadcountTarget).mockClear().mockResolvedValueOnce({
      workspaceId: 'ws-1',
      fleetSlug: 'claim-spec-drain',
      enabled: false,
      target: 1,
      config: { harness: 'h', agent: 'codex' },
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    vi.mocked(getPlanRow).mockClear();

    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { heldItems: [] });

    expect(getFleetHeadcountTarget).toHaveBeenCalledWith('ws-1', 'claim-spec-drain');
    expect(getPlanRow).not.toHaveBeenCalled();
    expect(delivery.marker.complete).toBe(true);
    expect(delivery.recovery.coverage.planAuthority).toBeNull();
    expect(delivery.recovery.planAuthority).toBeNull();
  });

  it('keeps recovery incomplete when a fleet launch profile needed for plan scope is unreadable', async () => {
    const [{ getFleetHeadcountTarget }, { buildAndPersistControlAnchor }, { buildAutomaticCompactionRecovery }] =
      await Promise.all([
        import('../../agent-fleets-store'),
        import('./control-anchor'),
        import('./compaction-recovery'),
      ]);
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce({
      ...CONTROL,
      state: {
        ...CONTROL.state,
        route: { kind: 'fleet', fleet: 'unknown-profile', role: 'member' },
        scope: { ...CONTROL.state.scope, plan: null, items: [] },
      },
    });
    vi.mocked(getFleetHeadcountTarget).mockRejectedValueOnce(new Error('profile store unavailable'));

    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { heldItems: [] });

    expect(delivery.marker.complete).toBe(false);
    expect(delivery.recovery.coverage.planAuthority).toBe(false);
  });

  it('keeps the marker incomplete when the control-scoped plan is absent in that harness', async () => {
    const [{ getPlanRow }, { buildAndPersistControlAnchor }, { buildAutomaticCompactionRecovery }] =
      await Promise.all([
        import('../plans/source'),
        import('./control-anchor'),
        import('./compaction-recovery'),
      ]);
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce({
      ...CONTROL,
      state: { ...CONTROL.state, scope: { ...CONTROL.state.scope, harness: 'wrong-harness' } },
    });
    vi.mocked(getPlanRow).mockResolvedValueOnce(null);

    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { heldItems: [] });

    expect(getPlanRow).toHaveBeenCalledWith(CONTROL.state.scope.plan, {
      workspaceId: 'ws-1',
      harnessSlug: 'wrong-harness',
    });
    expect(delivery.marker.complete).toBe(false);
    expect(delivery.recovery.coverage.planAuthority).toBe(false);
    expect(delivery.recovery.planAuthority).toMatchObject({
      resolution: 'unavailable',
      reason: 'not-found-in-control-harness',
      harness: 'wrong-harness',
      controlGeneration: 17,
    });
  });

  it('keeps the marker incomplete when current spec authority is unreadable', async () => {
    const [{ listSpecClauses }, { buildAndPersistControlAnchor }, { buildAutomaticCompactionRecovery }] =
      await Promise.all([
        import('../plans/spec-clauses-store'),
        import('./control-anchor'),
        import('./compaction-recovery'),
      ]);
    vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce(CONTROL);
    vi.mocked(listSpecClauses).mockRejectedValueOnce(new Error('spec store unavailable'));

    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { heldItems: [] });

    expect(delivery.marker.complete).toBe(false);
    expect(delivery.recovery.coverage.planAuthority).toBe(false);
    expect(delivery.recovery.planAuthority).toMatchObject({
      resolution: 'unavailable',
      reason: 'spec-read-failed',
      detail: 'spec store unavailable',
    });
  });

  it('keeps the marker incomplete when the authoritative control read fails', async () => {
    const [{ buildAndPersistControlAnchor }, { buildAutomaticCompactionRecovery }] =
      await Promise.all([import('./control-anchor'), import('./compaction-recovery')]);
    vi.mocked(buildAndPersistControlAnchor).mockRejectedValueOnce(new Error('control unavailable'));

    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      heldItems: [],
    });

    expect(delivery.marker.complete).toBe(false);
    expect(delivery.marker.memoryEpoch).toBe(23);
    expect(delivery.marker.controlGeneration).toBeNull();
    expect(delivery.recovery.coverage).toMatchObject({
      control: false,
      heldItems: true,
      planAuthority: null,
    });
    expect(delivery.marker.fallback.when).toEqual([
      'marker-absent',
      'marker-incomplete',
      'control-state-mismatch',
      'legacy-control-generation-mismatch',
    ]);
  });
});

// P-001 (carry-recheck-and-governed-memory-2026-10-14, R-1): compaction recovery RUNS the carried
// probes the successor inherits, instead of only handing it their text.
describe('automatic compaction recovery — carried probes run at recovery', () => {
  const BLOCK = '🧪 CARRIED PROBES re-run at delivery — 0 hold · 1 changed · 0 could not run:\n  ✗ CHANGED — gate is green [WI-1 #g]: observed "red"';

  it('renders a changed carried probe at compaction recovery', async () => {
    const [{ buildAutomaticCompactionRecovery }, { carriedProbeBlockForDelivery }, { renderCarryNote }, { continuityProbeRevision }] =
      await Promise.all([
        import('./compaction-recovery'),
        import('../../carry-probe-eval'),
        import('../../carry-note'),
        import('../../continuity-probes'),
      ]);
    const actual = await vi.importActual<typeof import('../../carry-probe-eval')>('../../carry-probe-eval');
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ value: 'red' }) }] }));
    let capturedSources: Parameters<typeof actual.carriedProbeBlockForDelivery>[0] | undefined;
    vi.mocked(carriedProbeBlockForDelivery).mockImplementationOnce((sources, deps) => {
      capturedSources = sources;
      return actual.carriedProbeBlockForDelivery(sources, { ...deps, dispatchTool });
    });
    const checkpoint = renderCarryNote({ checks: [{
      id: 'changed-probe',
      claim: 'the carried value is green',
      recheck: 'state:read',
      probe: {
        kind: 'tool', tool: 'state:read', args: { cell: 'test.carriedValue' },
        schemaRevision: continuityProbeRevision('state:read')!,
        expect: { path: '$.value', op: 'eq', value: 'green' },
      },
    }] });
    const adapterCallsBefore = vi.mocked(carriedProbeBlockForDelivery).mock.calls.length;
    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'h',
      heldItems: [{ id: 'WI-1', harness: 'h', checkpoint } as never],
      carriedRefChangesFn: async () => null,
    });
    const adapterCallsThisInvocation = vi.mocked(carriedProbeBlockForDelivery).mock.calls.length - adapterCallsBefore;
    const dispatchCalls = dispatchTool.mock.calls as unknown as unknown[][];
    expect({
      adapterCalls: adapterCallsThisInvocation,
      parsedSources: capturedSources?.map(({ source, checkIndex, check }) => ({
        source: source.kind === 'work-item' ? `${source.kind}:${source.id}` : `${source.kind}:${source.ownerId}`,
        checkIndex,
        checkId: check.id,
        probeTool: check.probe?.kind === 'tool' ? check.probe.tool : null,
      })),
      dispatchCalls: dispatchCalls.map((call) => ({
        tool: call[0],
        args: call[1],
        hasAbortSignal: call[2] instanceof AbortSignal,
      })),
    }).toMatchObject({
      adapterCalls: 1,
      parsedSources: [{
        source: 'work-item:WI-1',
        checkIndex: 0,
        checkId: 'changed-probe',
        probeTool: 'state:read',
      }],
      dispatchCalls: [{
        tool: 'state:read',
        args: { cell: 'test.carriedValue' },
        hasAbortSignal: true,
      }],
    });
    expect(delivery.recovery.carriedProbes).toContain(
      '✗ CHANGED — the carried value is green [WI-1 #changed-probe]: observed "red"',
    );
    expect(delivery.recovery.carriedProbes).not.toContain('COULD NOT RUN');
  });

  it('renders a could-not-run carried probe with its reason at compaction recovery', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [{ buildAutomaticCompactionRecovery }, { carriedProbeBlockForDelivery }, { renderCarryNote }, { continuityProbeRevision }] =
      await Promise.all([
        import('./compaction-recovery'),
        import('../../carry-probe-eval'),
        import('../../carry-note'),
        import('../../continuity-probes'),
      ]);
    const actual = await vi.importActual<typeof import('../../carry-probe-eval')>('../../carry-probe-eval');
    const dispatchTool = vi.fn(async () => { throw new Error('carried state unavailable'); });
    vi.mocked(carriedProbeBlockForDelivery).mockImplementationOnce((sources, deps) =>
      actual.carriedProbeBlockForDelivery(sources, { ...deps, dispatchTool }),
    );
    const checkpoint = renderCarryNote({ checks: [{
      id: 'unavailable-probe',
      claim: 'the carried value is green',
      recheck: 'state:read',
      probe: {
        kind: 'tool', tool: 'state:read', args: { cell: 'test.carriedValue' },
        schemaRevision: continuityProbeRevision('state:read')!,
        expect: { path: '$.value', op: 'eq', value: 'green' },
      },
    }] });
    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'h',
      heldItems: [{ id: 'WI-1', harness: 'h', checkpoint } as never],
      carriedRefChangesFn: async () => null,
    });
    expect(dispatchTool).toHaveBeenCalledExactlyOnceWith(
      'state:read', { cell: 'test.carriedValue' }, expect.any(AbortSignal),
    );
    expect(delivery.recovery.carriedProbes).toContain(
      '? COULD NOT RUN — the carried value is green [WI-1 #unavailable-probe]:',
    );
    expect(delivery.recovery.carriedProbes).toContain('carried state unavailable');
    expect(delivery.recovery.carriedProbes).not.toContain('✗ CHANGED');
    expect(delivery.recovery.carriedProbes).not.toContain('✓ HOLDS');
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[bounded-timeout] continuity-probe:state:read failed: carried state unavailable — degrading to fallback',
    );
  });

  it('attaches the probe block to the recovery and passes the already-read held items through', async () => {
    const { buildAutomaticCompactionRecovery } = await import('./compaction-recovery');
    const carriedProbesFn = vi.fn(async () => BLOCK);
    const heldItems = [{ id: 'WI-1', title: 't', harness: 'h', checkpoint: 'c', holderProof: { ownerId: 'owner-x', workspaceId: 'ws-1' } }];
    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'h',
      heldItems: heldItems as never,
      carriedProbesFn,
    });
    expect(carriedProbesFn).toHaveBeenCalledWith('owner-x', 'ws-1', { sessionHarness: 'h', heldItems });
    expect(delivery.recovery.carriedProbes).toBe(BLOCK);
  });

  it('omits the field when there is nothing to run, and never lets a probe failure break recovery', async () => {
    const { buildAutomaticCompactionRecovery } = await import('./compaction-recovery');
    const none = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', { heldItems: [], carriedProbesFn: async () => null });
    expect('carriedProbes' in none.recovery).toBe(false);
    const thrown = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      heldItems: [],
      carriedProbesFn: async () => {
        throw new Error('boom');
      },
    });
    expect('carriedProbes' in thrown.recovery).toBe(false);
    expect(thrown.recovery.coverage.heldItems).toBe(true);
  });

  it('the default collector probes held-item checks from the supplied rows without re-reading them', async () => {
    const [{ defaultRecoveryCarriedProbes }, { carriedProbeBlockForDelivery }, { readHeldWorkItems }, { renderCarryNote }] =
      await Promise.all([
        import('./compaction-recovery'),
        import('../../carry-probe-eval'),
        import('../../carry-brief'),
        import('../../carry-note'),
      ]);
    vi.mocked(readHeldWorkItems).mockClear();
    vi.mocked(carriedProbeBlockForDelivery).mockResolvedValueOnce(BLOCK);
    const probe = { kind: 'state-cell', cell: 'gate.greenCheckpoint.verdict', schemaRevision: 'r', expect: { path: '$.value', op: 'eq', value: 'green' } };
    const checkpoint = renderCarryNote({ checks: [{ id: 'g', claim: 'gate is green', recheck: 'state:read', probe: probe as never }] });
    const out = await defaultRecoveryCarriedProbes('owner-x', 'ws-1', {
      sessionHarness: 'h',
      heldItems: [{ id: 'WI-1', harness: 'h', checkpoint } as never],
    });
    expect(out).toBe(BLOCK);
    expect(readHeldWorkItems).not.toHaveBeenCalled();
    const [sources, deps] = vi.mocked(carriedProbeBlockForDelivery).mock.calls.at(-1)! as unknown as [Array<Record<string, any>>, Record<string, any>];
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ source: { kind: 'work-item', id: 'WI-1', harness: 'h' }, checkIndex: 0 });
    expect(sources[0]!.check.claim).toBe('gate is green');
    expect(sources[0]!.check.probe).toMatchObject({ kind: 'state-cell', cell: 'gate.greenCheckpoint.verdict' });
    expect(deps).toMatchObject({ harness: 'h', workspaceId: 'ws-1', readAtIso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });

  it('the carry document renders the probe block for a successor, but not for a judge', async () => {
    const { renderAutomaticCompactionRecovery } = await import('../../carry-doc');
    const delivery = {
      marker: {
        schemaVersion: 'post-compaction-recovery-v1',
        complete: false,
        memoryEpoch: 1,
        controlGeneration: null,
        controlStateHash: null,
        fallback: { verb: 'coord:orient', args: { afterCompaction: true }, when: [] },
      },
      recovery: {
        selfRecall: 'recall',
        coverage: { selfSession: false, control: false, heldItems: true, staleness: null },
        carriedProbes: BLOCK,
      },
    } as never;
    expect(renderAutomaticCompactionRecovery(delivery)).toContain('✗ CHANGED — gate is green [WI-1 #g]: observed "red"');
    expect(renderAutomaticCompactionRecovery(delivery, 'judge')).not.toContain('CARRIED PROBES');
  });
});

// P-002 (carry-recheck-and-governed-memory-2026-10-14, R-11 / R-20 / R-22): compaction recovery
// re-checks the carried references' version stamps and renders only the ones that moved.
describe('automatic compaction recovery — carried references re-checked at recovery', () => {
  const REFS =
    '🔗 CARRIED REFERENCES re-checked at compaction recovery — 1 reference has moved since the checkpoint was written:\n' +
    '  ✗ GONE — work-item:WI-2 [WI-1 checkpoint]: stamped open@1';

  it('attaches the reference block and passes the already-read held items through', async () => {
    const { buildAutomaticCompactionRecovery } = await import('./compaction-recovery');
    const carriedRefChangesFn = vi.fn(async () => REFS);
    const heldItems = [{ id: 'WI-1', title: 't', harness: 'h', checkpoint: 'see WI-2', holderProof: { ownerId: 'owner-x', workspaceId: 'ws-1' } }];
    const delivery = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'h',
      heldItems: heldItems as never,
      carriedProbesFn: async () => null,
      carriedRefChangesFn,
    });
    expect(carriedRefChangesFn).toHaveBeenCalledWith('owner-x', 'ws-1', { sessionHarness: 'h', heldItems });
    expect(delivery.recovery.carriedRefChanges).toBe(REFS);
  });

  it('omits the field when nothing moved, and never lets a re-check failure break recovery', async () => {
    const { buildAutomaticCompactionRecovery } = await import('./compaction-recovery');
    const none = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      heldItems: [],
      carriedProbesFn: async () => null,
      carriedRefChangesFn: async () => null,
    });
    expect('carriedRefChanges' in none.recovery).toBe(false);
    const thrown = await buildAutomaticCompactionRecovery('owner-x', 'ws-1', {
      heldItems: [],
      carriedProbesFn: async () => null,
      carriedRefChangesFn: async () => {
        throw new Error('boom');
      },
    });
    expect('carriedRefChanges' in thrown.recovery).toBe(false);
    expect(thrown.recovery.coverage.heldItems).toBe(true);
  });

  it('the carry document renders the reference block for a successor, but not for a judge', async () => {
    const { renderAutomaticCompactionRecovery } = await import('../../carry-doc');
    const delivery = {
      marker: {
        schemaVersion: 'post-compaction-recovery-v1',
        complete: false,
        memoryEpoch: 1,
        controlGeneration: null,
        controlStateHash: null,
        fallback: { verb: 'coord:orient', args: { afterCompaction: true }, when: [] },
      },
      recovery: {
        selfRecall: 'recall',
        coverage: { selfSession: false, control: false, heldItems: true, staleness: null },
        carriedRefChanges: REFS,
      },
    } as never;
    expect(renderAutomaticCompactionRecovery(delivery)).toContain('✗ GONE — work-item:WI-2 [WI-1 checkpoint]');
    expect(renderAutomaticCompactionRecovery(delivery, 'judge')).not.toContain('CARRIED REFERENCES');
  });
});

it('matches the complete paperwork authority history and omission manifest in compaction recovery', async () => {
  const [{ getPlanRow }, { buildAndPersistControlAnchor }, { buildCompactionRecovery }] = await Promise.all([
    import('../plans/source'), import('./control-anchor'), import('./compaction-recovery'),
  ]);
  vi.mocked(buildAndPersistControlAnchor).mockResolvedValueOnce(CONTROL);
  const baseline = await getPlanRow('fleet-deltas-leader-primitives-2026-07-10', { workspaceId: 'ws-1', harnessSlug: 'h' });
  if (!baseline) throw new Error('fixture requires a current plan');
  frozenPlanSource.row = {
    ...baseline,
    workspaceId: 'ws-1', harnessSlug: 'h', planSlug: 'fleet-deltas-leader-primitives-2026-07-10',
    contentHash: 'frozen-r19-plan', version: 18, status: 'ready',
    content: '## Decisions\n\n' + [
      '### D-001 — Current restriction\nP-017 remains paused. Retraction: old proof invalid; retain test-run:42.',
      ...[2, 3, 4, 5, 6, 7, 8].map(n => `### D-00${n} — History ${n}\nHistorical detail ${n}.`),
    ].join('\n\n') + '\n\n## Phase 1\n\n- **P-017** `wip` current task\n',
  };
  // Recovery also reads the plan while collecting held-item context. Keep the
  // same frozen source for every read, then restore the surrounding suite's seam.
  let recovery: Awaited<ReturnType<typeof buildCompactionRecovery>>;
  try {
    recovery = await buildCompactionRecovery('owner-x', 'ws-1', { heldItems: [] });
  } finally {
    frozenPlanSource.row = null;
  }
  expect(recovery.control).toEqual(CONTROL);
  const actual = recovery.planAuthority;
  const expected = {
    resolution: 'current', controlGeneration: 17, workspaceId: 'ws-1', harness: 'h',
    planSlug: 'fleet-deltas-leader-primitives-2026-07-10', version: 18, contentHash: 'frozen-r19-plan', planStatus: 'ready',
    decisions: [
      { id: 'D-001', title: 'Current restriction', body: 'P-017 remains paused. Retraction: old proof invalid; retain test-run:42.', truncated: false },
      { id: 'D-004', title: 'History 4', body: 'Historical detail 4.', truncated: false },
      { id: 'D-005', title: 'History 5', body: 'Historical detail 5.', truncated: false },
      { id: 'D-006', title: 'History 6', body: 'Historical detail 6.', truncated: false },
      { id: 'D-007', title: 'History 7', body: 'Historical detail 7.', truncated: false },
      { id: 'D-008', title: 'History 8', body: 'Historical detail 8.', truncated: false },
    ], taskLinkedDecisions: 1, decisionsMore: 2,
    omittedDecisionRefs: ['fleet-deltas-leader-primitives-2026-07-10#D-002', 'fleet-deltas-leader-primitives-2026-07-10#D-003'],
    items: [{ id: 'P-017', status: 'wip', text: 'current task', missing: false }],
    specs: [{ specId: 'SPEC-P-017', revision: 4, contentHash: 'spec-hash-4', planItemId: 'P-017' }],
  };
  const check = (candidate: typeof actual) => expect(candidate).toEqual(expected);
  check(actual);
  if (actual?.resolution !== 'current') throw new Error('expected current fixture authority');
  const missing = structuredClone(actual); missing.decisions.shift();
  const extra = structuredClone(actual); extra.decisions.push({ id: 'D-999', title: 'Unrelated', body: 'Other task.', truncated: false });
  const clipped = structuredClone(actual); clipped.decisions[0].body = 'P-017 remains paused.';
  const reordered = structuredClone(actual); reordered.decisions.reverse();
  for (const mutant of [missing, extra, clipped, reordered]) expect(() => check(mutant)).toThrow();
});
