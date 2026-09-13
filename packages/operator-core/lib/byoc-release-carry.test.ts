import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { TaskReleaseJournal } from './task-manager/store';
import {
  BYOC_RELEASE_MILESTONES,
  projectByocReleaseCarry,
  projectByocReleaseMilestones,
  readLinkedByocReleaseCarries,
  renderByocReleaseCarry,
} from './byoc-release-carry';
import { buildCarryBrief, renderCarryBriefColdExtras, type CarryBrief } from './carry-brief';

function journal(overrides: Partial<TaskReleaseJournal> = {}): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: 'release-op-current',
    source: { sha: 'a'.repeat(40), gitlinks: { desktop: 'b'.repeat(40) } },
    artifactIdentity: { kind: 'papercusp-desktop-release', version: '0.0.19', channel: 'nightly' },
    credential: { generation: 'credential-7', expiresAt: '2026-09-13T00:00:00.000Z' },
    cursor: 2,
    currentStage: 'publish.multipart.initiate',
    currentState: 'unknown',
    spentOperationIds: ['request-spent-1'],
    receipts: [
      {
        sequence: 0, operationId: 'release-op-current', requestIdentity: 'request-spent-1',
        stage: 'publish.multipart.initiate', state: 'intent', inputHash: 'c'.repeat(64),
        inputIdentity: { longImmutableInput: 'x'.repeat(1600) },
        evidenceRefs: ['manifest:sha256:' + 'd'.repeat(64)],
        credentialGeneration: 'credential-7', credentialExpiresAt: '2026-09-13T00:00:00.000Z',
        recordedAt: '2026-09-12T18:00:00.000Z',
      },
      {
        sequence: 1, operationId: 'release-op-current', requestIdentity: 'request-spent-1',
        stage: 'publish.multipart.initiate', state: 'unknown', inputHash: 'c'.repeat(64),
        inputIdentity: { longImmutableInput: 'x'.repeat(1600) }, evidenceRefs: ['provider-response:lost'],
        credentialGeneration: 'credential-7', credentialExpiresAt: '2026-09-13T00:00:00.000Z',
        recordedAt: '2026-09-12T18:01:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('BYOC release carry adapter', () => {
  it('derives only a contiguous evidence-backed milestone prefix', () => {
    const receipts = BYOC_RELEASE_MILESTONES.slice(0, 5).map((milestone, sequence) => ({
      sequence,
      operationId: 'release-op-current',
      requestIdentity: `request-${sequence}`,
      stage: milestone.stages[0],
      state: 'committed' as const,
      inputHash: String(sequence).repeat(64),
      evidenceRefs: [`receipt:${milestone.key}`],
      recordedAt: `2026-09-12T1${sequence}:00:00.000Z`,
    }));
    const projection = projectByocReleaseMilestones(journal({
      cursor: receipts.length,
      currentStage: receipts.at(-1)!.stage,
      currentState: 'committed',
      receipts,
    }));
    expect(projection.current).toBe('customer-acceptance');
    expect(projection.customerReady).toBe(true);
    expect(projection.shipped).toBe(false);
    expect(projection.milestones.map(({ status }) => status)).toEqual([
      'verified', 'verified', 'verified', 'verified', 'verified',
      'pending', 'pending', 'pending', 'pending', 'pending',
    ]);
  });

  it('flags a published-but-uninitialized chain and never displays it as customer-ready or shipped', () => {
    const source = journal({
      cursor: 5,
      currentStage: 'desktop-session.customer-acceptance',
      currentState: 'committed',
      receipts: [
        {
          sequence: 0, operationId: 'release-op-current', requestIdentity: 'build',
          stage: 'release.build.linux', state: 'committed', inputHash: 'a'.repeat(64),
          evidenceRefs: ['build:verified'], recordedAt: '2026-09-12T10:00:00.000Z',
        },
        {
          sequence: 1, operationId: 'release-op-current', requestIdentity: 'publish',
          stage: 'publish.finalize', state: 'committed', inputHash: 'b'.repeat(64),
          evidenceRefs: ['publication:verified'], recordedAt: '2026-09-12T11:00:00.000Z',
        },
        {
          sequence: 2, operationId: 'release-op-current', requestIdentity: 'bootstrap',
          stage: 'workspace.root-bootstrap', state: 'committed', inputHash: 'c'.repeat(64),
          evidenceRefs: ['bootstrap:verified'], recordedAt: '2026-09-12T12:00:00.000Z',
        },
        {
          sequence: 3, operationId: 'release-op-current', requestIdentity: 'initialize',
          stage: 'workspace.fixed-agent-initialization', state: 'refused', inputHash: 'd'.repeat(64),
          evidenceRefs: ['initialization:failed'], recordedAt: '2026-09-12T13:00:00.000Z',
        },
        {
          sequence: 4, operationId: 'release-op-current', requestIdentity: 'accept',
          stage: 'desktop-session.customer-acceptance', state: 'committed', inputHash: 'c'.repeat(64),
          evidenceRefs: ['acceptance:claimed'], recordedAt: '2026-09-12T14:00:00.000Z',
        },
      ],
    });
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', source);
    const rendered = renderByocReleaseCarry(snapshot);
    expect(snapshot.milestoneProjection.customerReady).toBe(false);
    expect(snapshot.milestoneProjection.shipped).toBe(false);
    expect(snapshot.milestoneProjection.milestones.find(({ key }) => key === 'fixed-agent-initialization')?.status).toBe('failed');
    expect(snapshot.milestoneProjection.milestones.find(({ key }) => key === 'customer-acceptance')?.status).toBe('blocked');
    expect(snapshot.milestoneProjection.contradictions).toContain(
      'DesktopSession/customer acceptance has a committed receipt but an earlier prerequisite is not verified',
    );
    expect(rendered).toContain('customer-ready=false; shipped=false');
    expect(rendered).toContain('⚠ receipt contradictions:');
    expect(rendered).toContain('acceptance:claimed');
  });

  it('does not regress a verified phase when a later receipt revisits an earlier stage', () => {
    const receipts = BYOC_RELEASE_MILESTONES.slice(0, 5).map((milestone, sequence) => ({
      sequence,
      operationId: 'release-op-current', requestIdentity: `request-${sequence}`,
      stage: milestone.stages[0], state: 'committed' as const,
      inputHash: String(sequence).repeat(64), evidenceRefs: [`receipt:${milestone.key}`],
      recordedAt: `2026-09-12T1${sequence}:00:00.000Z`,
    }));
    receipts.push({
      sequence: 5, operationId: 'release-op-current', requestIdentity: 'recheck-build',
      stage: 'release.build.linux', state: 'committed', inputHash: 'f'.repeat(64),
      evidenceRefs: ['build:reverified'], recordedAt: '2026-09-12T15:00:00.000Z',
    });
    const projection = projectByocReleaseMilestones(journal({
      cursor: receipts.length, currentStage: 'release.build.linux', currentState: 'committed', receipts,
    }));
    expect(projection.current).toBe('customer-acceptance');
    expect(projection.customerReady).toBe(true);
  });

  it('projects the live journal into a concise reconciliation-safe receipt', () => {
    const source = journal();
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', source);
    expect(snapshot).toMatchObject({
      taskId: 'taskrelease01', workItemId: 'WI-7', operationId: 'release-op-current', cursor: 2,
      currentStage: 'publish.multipart.initiate', currentState: 'unknown',
      spentRequestIdentities: ['request-spent-1'],
    });
    expect(snapshot.nextAction).toMatch(/Reconcile request request-spent-1.*before any further mutation/);
    expect(snapshot.evidenceRefs).toEqual(['manifest:sha256:' + 'd'.repeat(64), 'provider-response:lost']);
    expect(JSON.stringify(snapshot).length).toBeLessThan(JSON.stringify(source).length / 2);
  });

  it('rebuilds from current state instead of letting stale carry override a changed operation', () => {
    const stale = projectByocReleaseCarry('taskrelease01', 'WI-7', journal());
    const current = projectByocReleaseCarry('taskrelease01', 'WI-7', journal({
      operationId: 'release-op-retracted-and-replaced', cursor: 0, currentStage: null,
      currentState: null, spentOperationIds: [], receipts: [],
    }));
    expect(stale.operationId).toBe('release-op-current');
    expect(current).toMatchObject({ operationId: 'release-op-retracted-and-replaced', cursor: 0, currentStage: null, currentState: null, spentRequestIdentities: [] });
    expect(current.nextAction).toMatch(/Begin the first stage/);
  });

  it('keeps BYOC state, open walls and retraction liveness separate in the existing carry renderer', () => {
    const brief: CarryBrief = {
      ownerId: 'su-owner', workspaceId: 'workspace-1', loop: null, heldItems: [],
      byocReleases: [projectByocReleaseCarry('taskrelease01', 'WI-7', journal())], deferredItems: [],
      directives: [], directivesTotalOpen: 0,
      walls: [{ id: 'do-not-repeat', claim: 'Do not reuse the retracted credential.', recheck: 'Read credential generation 7', sinceMs: 1 }],
      checks: [], facts: [], factsStaleness: [], awaits: [], fleet: null,
      citedRefs: ['EI-7 [change/done]: "retracted stale diagnosis"'],
    };
    const rendered = renderCarryBriefColdExtras(brief);
    expect(rendered).toContain('AUTHORITATIVE BYOC RELEASE RECEIPTS');
    expect(rendered).toContain('Reconcile request request-spent-1');
    expect(rendered).toContain('Do not reuse the retracted credential.');
    expect(rendered).toContain('EI-7 [change/done]');
    expect(rendered).toContain('task:taskrelease01#release');
  });

  it('reads only explicitly owner/work-item-linked complete deploy journals', async () => {
    const sql = vi.fn(async () => [
      { task_id: 'linkedtask01', work_item_id: 'WI-7', detail: { release: journal() } },
      { task_id: 'malformedtask', work_item_id: 'WI-7', detail: { release: { cursor: 0 } } },
    ]) as unknown as Sql;
    Object.assign(sql, { array: (values: unknown[]) => values });
    const snapshots = await readLinkedByocReleaseCarries({ ownerId: 'su-owner', workspaceId: 'workspace-1', heldWorkItemIds: ['WI-7'] }, sql);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ taskId: 'linkedtask01', workItemId: 'WI-7' });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('wires the linked release projection into the shared carry builder', async () => {
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', journal());
    const built = await buildCarryBrief('su-owner', {
      workspaceId: 'workspace-1',
      listOpenDirectivesFn: async () => ({ rows: [], totalOpen: 0 }),
      getLoopStatusFn: async () => null,
      readHeldWorkItemsFn: async () => [{
        id: 'WI-7', title: 'BYOC release', body: null, harness: 'papercusp', checkpoint: null,
        holderProof: { ownerId: 'su-owner', workspaceId: 'workspace-1' },
      }],
      readByocReleaseCarriesFn: async (_ownerId, _workspaceId, heldIds) => {
        expect(heldIds).toEqual(['WI-7']);
        return [snapshot];
      },
      readDeferredWorkItemsFn: async () => [],
      listOwnerFactsFn: async () => [],
      listActiveAwaitsFn: async () => [],
      getFleetFn: async () => null,
    });
    expect(built.byocReleases).toEqual([snapshot]);
    expect(renderCarryBriefColdExtras(built)).toContain('operation=release-op-current');
  });

  it.each([
    { state: 'committed' as const, refs: ['artifact:verified'], action: /without rerunning committed stage/ },
    { state: 'refused' as const, refs: ['provider:denied'], action: /Stop at stage/ },
    { state: 'refused' as const, refs: ['reconcile:confirmed-absent'], action: /mint a new one-use request identity/ },
  ])('derives the next action from receipt state $state and evidence $refs', ({ state, refs, action }) => {
    const source = journal();
    const latest = { ...source.receipts.at(-1)!, state, evidenceRefs: refs };
    const snapshot = projectByocReleaseCarry('taskrelease01', 'WI-7', { ...source, currentState: state, receipts: [source.receipts[0]!, latest] });
    expect(renderByocReleaseCarry(snapshot)).toMatch(action);
  });
});
