import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    capture: vi.fn(async () => {
      events.push('capture');
      return { capturedIds: ['WI-F', 'EI-I'] };
    }),
    claims: vi.fn(async () => {
      events.push('claims');
      return 1;
    }),
    planClaims: vi.fn(async () => {
      events.push('plan-claims');
      return 0;
    }),
    release: vi.fn(async (id: string) => {
      events.push(`release:${id}`);
      return true;
    }),
    sql: vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('harness_features_consolidated')) return [{ id: 'WI-F', harness: 'papercusp' }];
      if (text.includes('engineer_issues')) return [{ id: 'EI-I', scope: 'harness:papercusp' }];
      return [];
    }),
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./work-items', () => ({ releaseWorkItem: h.release }));
vi.mock('./work-item-claims', () => ({ releaseAllClaimsForOwner: h.claims }));
vi.mock('./plan-items/claims', () => ({ releaseAllClaimsForOwner: h.planClaims }));
vi.mock('./issues-engineer', () => ({ issuesScopeWorkspace: () => 'ws' }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('./work-item-flight-record', () => ({
  captureWorkItemFlightRecordsForItems: h.capture,
  harnessFromIssueScope: (scope: string) => scope.replace(/^harness:/, ''),
}));

const { releaseAllWorkItemLeasesForOwner } = await import('./work-item-lease-release');

beforeEach(() => {
  h.events.length = 0;
  h.capture.mockClear();
  h.claims.mockClear();
  h.planClaims.mockClear();
  h.release.mockClear();
  h.sql.mockClear();
});

describe('releaseAllWorkItemLeasesForOwner flight-record ordering', () => {
  it('captures held rows, then releases each item before sweeping orphan claims', async () => {
    const result = await releaseAllWorkItemLeasesForOwner('su-dead');

    expect(h.capture).toHaveBeenCalledWith({
      ownerId: 'su-dead',
      workspaceId: 'ws',
      cause: 'lease-release',
      items: [
        { id: 'WI-F', harness: 'papercusp' },
        { id: 'EI-I', harness: 'papercusp' },
      ],
    });
    expect(h.events[0]).toBe('capture');
    expect(h.events.indexOf('capture')).toBeLessThan(h.events.indexOf('claims'));
    expect(h.events.indexOf('capture')).toBeLessThan(h.events.indexOf('release:WI-F'));
    expect(h.events.indexOf('capture')).toBeLessThan(h.events.indexOf('release:EI-I'));
    expect(h.events.indexOf('release:EI-I')).toBeLessThan(h.events.indexOf('claims'));
    expect(result).toEqual({ releasedIds: ['WI-F', 'EI-I'], claimsCleared: 1 });
  });

  it('sweeps orphaned plan-item lane claims after successful work-item releases', async () => {
    h.planClaims.mockImplementationOnce(async () => {
      h.events.push('plan-claims');
      return 2;
    });

    const result = await releaseAllWorkItemLeasesForOwner('su-dead');

    expect(h.planClaims).toHaveBeenCalledWith('ws', 'su-dead');
    expect(h.events.indexOf('capture')).toBeLessThan(h.events.indexOf('plan-claims'));
    expect(h.events.indexOf('plan-claims')).toBeGreaterThan(h.events.indexOf('release:WI-F'));
    expect(h.events.indexOf('plan-claims')).toBeGreaterThan(h.events.indexOf('release:EI-I'));
    expect(result).toEqual({ releasedIds: ['WI-F', 'EI-I'], claimsCleared: 3 });
  });

  it.each(['refused', 'throws'])('retains unswept claims after a release %s and continues other items', async (failure) => {
    h.release.mockImplementationOnce(async () => {
      if (failure === 'throws') throw new Error('capture rejected');
      return false;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await releaseAllWorkItemLeasesForOwner('su-dead');
      expect(result).toEqual({ releasedIds: ['EI-I'], claimsCleared: 0 });
      expect(h.release).toHaveBeenCalledTimes(2);
      expect(h.claims).not.toHaveBeenCalled();
      expect(h.planClaims).not.toHaveBeenCalled();
      if (failure === 'throws') expect(warning).toHaveBeenCalledWith(
        '[work-item-lease-release] release failed for WI-F (su-dead):', 'capture rejected');
      else expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
});
