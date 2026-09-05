import { describe, expect, it } from 'vitest';

import {
  resolveOperationBoundaryProfile,
  type BoundaryProfileDeps,
} from './boundary-profile';
import type { SessionToolConfinement } from '../../capability-envelope/session-confinement';

const none: BoundaryProfileDeps = {
  declaredConfinement: async () => null,
};

const declared: SessionToolConfinement = {
  denyTools: ['work_items:complete'],
  reason: 'directed implementation',
  imposedBy: 'pair-director su-director',
};

describe('resolveOperationBoundaryProfile', () => {
  it('keeps an ordinary authenticated superuser operation trusted', async () => {
    await expect(
      resolveOperationBoundaryProfile({ isSuperuser: true, role: 'operator' }, none),
    ).resolves.toEqual({ kind: 'trusted', reason: 'superuser' });
  });

  it('keeps the legacy direct-handler su context trusted without admitting a signed-spawn role', async () => {
    await expect(
      resolveOperationBoundaryProfile({ role: 'su' as never }, none),
    ).resolves.toEqual({ kind: 'trusted', reason: 'legacy-su-context' });
  });

  it('keeps the in-process system operator trusted', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        {
          principal: {
            kind: 'system',
            slug: 'system:operator',
            workspaceId: 'workspace-a',
          },
          role: 'operator',
        },
        none,
      ),
    ).resolves.toEqual({ kind: 'trusted', reason: 'system-operator' });
  });

  it('treats a signed autonomous caller as confined', async () => {
    const result = await resolveOperationBoundaryProfile(
      { role: 'worker', sigVerifiedSpawn: true, uiClientId: 's-worker' },
      none,
    );
    expect(result).toEqual({ kind: 'confined', reason: 'autonomous-caller' });
  });

  it('lets launch-declared confinement override superuser privilege', async () => {
    const result = await resolveOperationBoundaryProfile(
      { isSuperuser: true, role: 'operator', uiClientId: 'su-directed' },
      { declaredConfinement: async () => declared },
    );
    expect(result).toEqual({
      kind: 'confined',
      reason: 'session-confinement',
      confinement: declared,
    });
  });

  it('fails a resolver fault and an unattributed context toward confinement', async () => {
    await expect(
      resolveOperationBoundaryProfile(
        {},
        { declaredConfinement: async () => { throw new Error('store unavailable'); } },
      ),
    ).resolves.toEqual({ kind: 'confined', reason: 'unattributed-caller' });
    await expect(resolveOperationBoundaryProfile({}, none)).resolves.toEqual({
      kind: 'confined',
      reason: 'unattributed-caller',
    });
  });
});
