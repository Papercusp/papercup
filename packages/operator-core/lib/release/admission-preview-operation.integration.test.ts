import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createRoutineMetadataAdmissionPreviewStore,
  recoverOrphanedAdmissionPreviewOperations,
  type AdmissionPreviewOperation,
} from './admission-preview-operation';

let org: OrgTestDb;
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: org.adminSql }),
}));

const workspaceId = 'ws-preview-recovery';
beforeAll(async () => {
  org = await createOrgTestDb();
  for (const slug of ['home', 'other']) {
    await org.adminSql`
      INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
      VALUES (${'rt-preview-' + slug}, ${slug}, 'green-checkpoint', 'cron', '{}'::jsonb,
              'system:green-checkpoint', false, ${workspaceId}, '{"keep":"unrelated"}'::jsonb)`;
  }
});
afterAll(async () => { await org?.cleanup(); });

it('settles the persisted preview once across concurrent restarts and preserves other previews', async () => {
  const store = createRoutineMetadataAdmissionPreviewStore({ workspaceId, installSlug: 'home' });
  const other = createRoutineMetadataAdmissionPreviewStore({ workspaceId, installSlug: 'other' });
  const orphan: AdmissionPreviewOperation = {
    schemaVersion: 1, operationId: 'arp-orphan', status: 'running',
    hostInstanceId: 'old-boot', hostPort: 3170, startedAtMs: 100, expiresAtMs: 1000,
    settledAtMs: null, paths: ['first.ts', 'second.ts'], verdict: null, verdictTruncated: false, error: null,
  };
  const sameHost = { ...orphan, operationId: 'arp-current', hostInstanceId: 'new-boot' };
  const otherPort = { ...orphan, operationId: 'arp-other-port', hostPort: 3070 };
  const settled: AdmissionPreviewOperation = {
    ...orphan, operationId: 'arp-finished', status: 'settled', settledAtMs: 150, verdict: { ok: true },
  };
  for (const record of [orphan, sameHost, otherPort, settled]) await store.put(record);
  await other.put(orphan);

  const emitted: AdmissionPreviewOperation[] = [];
  const recover = () => recoverOrphanedAdmissionPreviewOperations({
    store, hostInstanceId: 'new-boot', hostPort: 3170, nowMs: 500,
    emitSettled: async (operation) => { emitted.push(operation); },
  });
  const recovered = (await Promise.all([recover(), recover()])).flat();
  const expected = {
    ...orphan, status: 'interrupted', settledAtMs: 500, error: 'host restarted before preview settled',
    verdict: { verdict: 'interrupted', reason: 'host-restarted' },
  };
  expect(recovered).toEqual([expected]);
  expect(emitted).toEqual([expected]);
  expect(await store.get(orphan.operationId)).toEqual(expected);
  for (const record of [sameHost, otherPort, settled]) expect(await store.get(record.operationId)).toEqual(record);
  expect(await other.get(orphan.operationId)).toEqual(orphan);
  const [row] = await org.adminSql`SELECT metadata->>'keep' AS keep FROM harness_shared.routines
    WHERE workspace_id = ${workspaceId} AND install_slug = 'home' AND target_role = 'system:green-checkpoint'`;
  expect(row?.keep).toBe('unrelated');
});
