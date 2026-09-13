/** Real-Postgres association, stale recovery and milestone views for BYOC P-007/P-008. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { readLinkedByocReleaseCarries, renderByocReleaseCarry } from './byoc-release-carry';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
const WS = 'byoc-carry-integration';
let db: FreshPgDb;

function release(operationId: string, state: 'intent' | 'unknown' | 'committed') {
  const requestIdentity = `${operationId}-request`;
  return {
    schemaVersion: 1,
    operationId,
    source: { sha: 'a'.repeat(40), gitlinks: { desktop: 'b'.repeat(40) } },
    artifactIdentity: { kind: 'papercusp-desktop-release', version: '0.0.19', channel: 'nightly' },
    credential: { generation: 'credential-7', expiresAt: '2026-09-13T00:00:00.000Z' },
    cursor: 1,
    currentStage: 'publish.manifest',
    currentState: state,
    spentOperationIds: [requestIdentity],
    receipts: [{
      sequence: 0, operationId, requestIdentity, stage: 'publish.manifest', state,
      inputHash: 'c'.repeat(64), inputIdentity: { source: 'immutable' },
      evidenceRefs: [state === 'unknown' ? 'provider-response:lost' : 'manifest:verified'],
      credentialGeneration: 'credential-7', credentialExpiresAt: '2026-09-13T00:00:00.000Z',
      recordedAt: '2026-09-12T18:00:00.000Z',
    }],
  };
}

async function insertTask(input: {
  id: string;
  workItemId?: string | null;
  ownerId?: string | null;
  release: unknown;
}) {
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv, launched_by,
      work_item_id, confined, state, detail
    ) VALUES (
      ${input.id}, ${WS}, ${input.id}, 'deploy', ${input.id}, '[]'::jsonb, 'test',
      ${input.workItemId ?? null}, true, 'running',
      jsonb_build_object(
        'release', ${JSON.stringify(input.release)}::text::jsonb,
        'coordOwnerId', ${input.ownerId ?? null}::text
      )
    )
  `;
}

beforeAll(async () => {
  db = await createFreshPgDb('byoc-release-carry');
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '696-task-ledger.sql'));
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.task_ledger`;
});

describe('BYOC release carry real task ledger', () => {
  it('isolates explicit associations and replaces an interrupted stale operation from the live journal', async () => {
    await insertTask({ id: 'linkedtask01', workItemId: 'WI-7', release: release('operation-old', 'unknown') });
    await insertTask({ id: 'ownertask001', ownerId: 'su-owner', release: release('operation-owner', 'committed') });
    await insertTask({ id: 'unrelated01', workItemId: 'WI-OTHER', ownerId: 'su-other', release: release('operation-other', 'committed') });
    await insertTask({ id: 'malformed01', workItemId: 'WI-7', release: { cursor: 0 } });

    const first = await readLinkedByocReleaseCarries({
      ownerId: 'su-owner', workspaceId: WS, heldWorkItemIds: ['WI-7'],
    }, db.sql);
    expect(first.map((snapshot) => snapshot.taskId).sort()).toEqual(['linkedtask01', 'ownertask001']);
    expect(first.find((snapshot) => snapshot.taskId === 'linkedtask01')).toMatchObject({
      operationId: 'operation-old', currentState: 'unknown',
      nextAction: expect.stringMatching(/Reconcile request/),
    });

    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_set(detail, '{release}', ${JSON.stringify(release('operation-current', 'committed'))}::text::jsonb),
             updated_at = now()
       WHERE task_id = 'linkedtask01'
    `;
    const recovered = await readLinkedByocReleaseCarries({
      ownerId: 'su-owner', workspaceId: WS, heldWorkItemIds: ['WI-7'],
    }, db.sql);
    expect(recovered.find((snapshot) => snapshot.taskId === 'linkedtask01')).toMatchObject({
      operationId: 'operation-current', currentState: 'committed',
      spentRequestIdentities: ['operation-current-request'],
      nextAction: expect.stringMatching(/without rerunning committed stage/),
    });
    expect(recovered.some((snapshot) => snapshot.taskId === 'unrelated01')).toBe(false);
    expect(recovered.some((snapshot) => snapshot.taskId === 'malformed01')).toBe(false);
  });

  it('renders a published release with refused fixed-agent initialization as blocked, never customer-ready', async () => {
    const operationId = 'operation-contradictory';
    const receipt = (
      sequence: number,
      stage: string,
      state: 'committed' | 'refused',
      evidence: string,
    ) => ({
      sequence, operationId, requestIdentity: `request-${sequence}`, stage, state,
      inputHash: String(sequence).repeat(64), inputIdentity: { stage }, evidenceRefs: [evidence],
      credentialGeneration: 'credential-7', credentialExpiresAt: '2026-09-13T00:00:00.000Z',
      recordedAt: `2026-09-12T1${sequence}:00:00.000Z`,
    });
    const receipts = [
      receipt(0, 'release.build.linux', 'committed', 'build:verified'),
      receipt(1, 'publish.finalize', 'committed', 'publication:verified'),
      receipt(2, 'workspace.root-bootstrap', 'committed', 'bootstrap:verified'),
      receipt(3, 'workspace.fixed-agent-initialization', 'refused', 'initialization:failed'),
      receipt(4, 'desktop-session.customer-acceptance', 'committed', 'acceptance:claimed'),
    ];
    await insertTask({
      id: 'contradictory01', workItemId: 'WI-8',
      release: {
        ...release(operationId, 'committed'),
        cursor: receipts.length,
        currentStage: 'desktop-session.customer-acceptance',
        spentOperationIds: receipts.map((item) => item.requestIdentity),
        receipts,
      },
    });

    const [snapshot] = await readLinkedByocReleaseCarries({
      ownerId: 'su-owner', workspaceId: WS, heldWorkItemIds: ['WI-8'],
    }, db.sql);
    expect(snapshot?.milestoneProjection).toMatchObject({
      current: 'root-bootstrap', customerReady: false, shipped: false,
    });
    expect(snapshot?.milestoneProjection.milestones.find(({ key }) => key === 'fixed-agent-initialization'))
      .toMatchObject({ status: 'failed', evidenceRefs: ['initialization:failed'] });
    expect(snapshot?.milestoneProjection.milestones.find(({ key }) => key === 'customer-acceptance'))
      .toMatchObject({ status: 'blocked', evidenceRefs: ['acceptance:claimed'] });
    const rendered = renderByocReleaseCarry(snapshot!);
    expect(rendered).toContain('customer-ready=false; shipped=false');
    expect(rendered).toContain('fixed-agent initialization=failed [initialization:failed]');
    expect(rendered).toContain('DesktopSession/customer acceptance=blocked [acceptance:claimed]');
    expect(rendered).toContain('⚠ receipt contradictions:');
  });
});
