/** Direct resolver wiring for the P-011 identity-management settings read. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  readSurface: vi.fn(async (_input: unknown) => ({ ownerId: 'su-target', identities: [] })),
}));

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../identity-management', () => ({ readIdentitySurface: H.readSurface }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';
import { TABLE_TO_QUERY_NAMES, queryNamesForTriggerEvent } from './table-to-query-names';

beforeEach(() => {
  vi.clearAllMocks();
  H.readSurface.mockResolvedValue({ ownerId: 'su-target', identities: [] });
});

describe('identities.surface named query', () => {
  it('is registered and resolves the bounded single-surface row for one owner', async () => {
    expect(knownQueryNamesV2()).toContain('identities.surface');

    await expect(resolveNamedQueryV2('identities.surface', { ownerId: '  su-target  ' })).resolves.toEqual([
      { ownerId: 'su-target', identities: [] },
    ]);
    expect(H.readSurface).toHaveBeenCalledWith({ workspaceId: 'ws-test', ownerId: 'su-target' });
  });

  it('supports the library-only read and rejects a blank owner before touching the service', async () => {
    await resolveNamedQueryV2('identities.surface', undefined);
    expect(H.readSurface).toHaveBeenLastCalledWith({ workspaceId: 'ws-test', ownerId: null });

    H.readSurface.mockClear();
    await expect(resolveNamedQueryV2('identities.surface', { ownerId: '   ' })).rejects.toBeTruthy();
    expect(H.readSurface).not.toHaveBeenCalled();
  });

  it('invalidates for every table that contributes activation truth', () => {
    for (const table of [
      'harness_shared.adv_sessions',
      'harness_shared.session_briefs',
      'harness_shared.session_identity_activation_events',
    ]) {
      expect(TABLE_TO_QUERY_NAMES[table]).toContain('identities.surface');
      expect(queryNamesForTriggerEvent(`${table}.changed`)).toContain('identities.surface');
    }
  });
});
