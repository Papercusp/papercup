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
import { describe, expect, it, vi } from 'vitest';
import type { ControlAnchor } from './control-anchor';

vi.mock('../../search/self-session', () => ({
  resolveSelfSession: vi.fn(async () => null),
}));
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: vi.fn(async () => null),
}));
vi.mock('./control-anchor', () => ({
  buildAndPersistControlAnchor: vi.fn(async () => {
    throw new Error('not exercised by this test');
  }),
}));
vi.mock('../../memory/session-epoch-ledger', () => ({
  currentSessionEpoch: vi.fn(async () => 23),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));
vi.mock('../mode/set', () => ({
  wakeSourceLostWarning: vi.fn(() => undefined),
}));
vi.mock('../plans/source', () => ({
  getPlanRow: vi.fn(async (slug: string, opts: { workspaceId?: string; harnessSlug?: string }) => ({
    workspaceId: opts.workspaceId ?? 'ws-1',
    harnessSlug: opts.harnessSlug ?? 'h',
    planSlug: slug,
    content: `---\ntitle: Current authority\nslug: ${slug}\nstatus: ready\ncreated: 2026-08-25\nupdated: 2026-08-25\n---\n\n## Decisions\n\n### D-001 — newest rule\nDate: 2026-08-25\nCurrent authority wins.\n\n## Phase 1\n\n- **P-017** \`wip\` current task\n`,
    contentHash: 'plan-hash-17',
    version: 17,
    status: 'ready',
  })),
}));
vi.mock('../plans/spec-clauses-store', () => ({
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

describe('buildCompactionRecovery — held-item checkpoint fold', () => {
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
    expect(MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION).toContain(
      'exactly once only when the marker is absent, incomplete, generation-mismatched',
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
      fallback: {
        verb: 'coord:orient',
        args: { afterCompaction: true },
        when: ['marker-absent', 'marker-incomplete', 'control-generation-mismatch'],
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
      'control-generation-mismatch',
    ]);
  });
});
