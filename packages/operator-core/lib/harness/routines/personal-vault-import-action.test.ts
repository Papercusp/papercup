import { describe, expect, it, vi } from 'vitest';
import { getSystemAction } from './system-actions';
import { runPersonalVaultImportAction } from './personal-vault-import-action';

describe('personal-vault-import system action', () => {
  it('passes one bounded batch and a stable workspace worker identity to the job store', async () => {
    const runBatch = vi.fn(async () => ({
      claimed: true,
      jobId: '11111111-1111-4111-8111-111111111111',
      status: 'queued' as const,
      documentsSeen: 25,
      documentsImported: 25,
      warnings: 0,
      error: null,
    }));

    await expect(runPersonalVaultImportAction({
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
      triggerConfig: { batch_size: 25, lease_seconds: 90 },
      payloadTemplate: null,
    }, {
      sql: {} as never,
      runBatch,
    })).resolves.toMatchObject({ claimed: true, status: 'queued', documentsImported: 25 });

    expect(runBatch).toHaveBeenCalledWith(
      expect.anything(),
      'papercusp-workspace',
      {
        batchSize: 25,
        leaseSeconds: 90,
        leaseOwner: 'system:personal-vault-import:papercusp',
      },
    );
  });

  it('falls back to safe batch and lease bounds for invalid routine config', async () => {
    const runBatch = vi.fn(async () => ({
      claimed: false,
      jobId: null,
      status: 'idle' as const,
      documentsSeen: 0,
      documentsImported: 0,
      warnings: 0,
      error: null,
    }));

    await runPersonalVaultImportAction({
      workspaceId: 'workspace-a',
      installSlug: 'harness-a',
      triggerConfig: { batch_size: 0, lease_seconds: 100_000 },
      payloadTemplate: null,
    }, { sql: {} as never, runBatch });

    expect(runBatch).toHaveBeenCalledWith(expect.anything(), 'workspace-a', {
      batchSize: 100,
      leaseSeconds: 600,
      leaseOwner: 'system:personal-vault-import:harness-a',
    });
  });

  it('registers the durable handler', () => {
    expect(getSystemAction('personal-vault-import')).toBeTypeOf('function');
  });
});
