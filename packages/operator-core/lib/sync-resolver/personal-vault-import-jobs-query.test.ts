import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  listJobs: vi.fn(),
  publicJob: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

vi.mock('../personal-vault/import-jobs', () => ({
  listPersonalVaultImportJobs: mocks.listJobs,
  publicPersonalVaultImportJob: mocks.publicJob,
}));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { TABLE_TO_QUERY_NAMES, queryNamesForTriggerEvent } from './table-to-query-names';

describe('personalVault.importJobs named query (WI-42203)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listJobs.mockResolvedValue([{ id: 'job-1', storagePath: '/private/archive' }]);
    mocks.publicJob.mockImplementation((job: { id: string }) => ({ id: job.id, status: 'queued' }));
  });

  it('derives workspace server-side, clamps the window, and returns only public job rows', async () => {
    expect(knownQueryNamesV2()).toContain('personalVault.importJobs');

    await expect(
      resolveNamedQueryV2('personalVault.importJobs', { userId: '  user-1  ', limit: 1_000 }),
    ).resolves.toEqual([{ id: 'job-1', status: 'queued' }]);
    expect(mocks.listJobs).toHaveBeenCalledWith(mocks.sql, 'ws-test', 'user-1', 100);
    expect(mocks.publicJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', storagePath: '/private/archive' }),
      0,
      expect.any(Array),
    );
  });

  it('rejects a blank user id before touching storage', async () => {
    await expect(
      resolveNamedQueryV2('personalVault.importJobs', { userId: '   ' }),
    ).rejects.toBeTruthy();
    expect(mocks.listJobs).not.toHaveBeenCalled();
  });

  it('bridges both reservation and durable-job writes to the live Settings queue', () => {
    expect(TABLE_TO_QUERY_NAMES['harness_shared.personal_vault_import_jobs']).toEqual([
      'personalVault.importJobs',
    ]);
    expect(TABLE_TO_QUERY_NAMES['harness_shared.personal_vault_import_uploads']).toEqual([
      'personalVault.importJobs',
    ]);
    expect(
      queryNamesForTriggerEvent('harness_shared.personal_vault_import_jobs.changed', { id: 'job-1' }),
    ).toEqual(['personalVault.importJobs']);
    expect(
      queryNamesForTriggerEvent('harness_shared.personal_vault_import_uploads.changed', { id: 'upload-1' }),
    ).toEqual(['personalVault.importJobs']);
  });
});
