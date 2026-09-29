import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { applySessionPackageResources } from './session-package-resources';

describe('session package activation artifact requirement', () => {
  it('refuses an explicit attempt without its artifact before touching the activation transaction', async () => {
    const tx = vi.fn(() => { throw new Error('activation transaction must remain untouched'); });
    await expect(applySessionPackageResources(tx as unknown as TransactionSql, {
      ownerId: 'wearer', workspaceId: 'workspace',
      revision: { specificationRevision: 'spec', stateRevision: 'state' },
      artifact: null, attemptId: 'persisted-attempt',
    })).rejects.toThrow('package activation attempt requires a verified artifact');
    expect(tx).not.toHaveBeenCalled();
  });

  it('preserves the pre-attempt legacy null-artifact no-op', async () => {
    const tx = vi.fn(() => { throw new Error('legacy activation must not access package storage'); });
    await expect(applySessionPackageResources(tx as unknown as TransactionSql, {
      ownerId: 'wearer', workspaceId: 'workspace',
      revision: { specificationRevision: 'spec', stateRevision: 'state' }, artifact: null,
    })).resolves.toEqual({ superseded: [] });
    expect(tx).not.toHaveBeenCalled();
  });
});
