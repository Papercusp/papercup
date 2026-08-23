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

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('./work-items', () => ({ releaseWorkItem: h.release }));
vi.mock('./work-item-claims', () => ({ releaseAllClaimsForOwner: h.claims }));
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
  h.release.mockClear();
  h.sql.mockClear();
});

describe('releaseAllWorkItemLeasesForOwner flight-record ordering', () => {
  it('queries held rows and awaits capture before clearing claims or releasing either lease family', async () => {
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
    expect(result).toEqual({ releasedIds: ['WI-F', 'EI-I'], claimsCleared: 1 });
  });
});
