// dev.* live-ops glance resolvers for the dev admin rail (plan
// dev-admin-sidebar-2026-06-05, P-005..P-008). Verifies each is registered and
// projects its underlying data source into the useSyncQuery contract: snapshot
// reads wrap in a 1-element array (client reads data[0]); list reads stay flat.
// Each underlying source module is mocked at its boundary so no HTTP/PG/git runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knownQueryNamesV2 } from './index';

describe('dev.* glance resolvers', () => {
  it('registers all six dev.* query names', () => {
    const names = knownQueryNamesV2();
    for (const n of [
      'dev.serviceHealth',
      'dev.deployState',
      'dev.pgHealth',
      'dev.pgActiveQueries',
      'dev.coordPresence',
      'dev.fleetGovernor',
    ]) {
      expect(names).toContain(n);
    }
  });

  describe('resolver projection shapes', () => {
    beforeEach(() => {
      vi.resetModules();
    });
    afterEach(() => {
      vi.resetModules();
    });

    it('dev.serviceHealth wraps probeAll() as [{ services }]', async () => {
      const services = [{ name: 'operator', up: true, status: 200, latencyMs: 4 }];
      vi.doMock('../service-health', () => ({ probeAll: vi.fn(async () => services) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.serviceHealth', {})) as Array<{ services: unknown[] }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].services).toEqual(services);
      vi.doUnmock('../service-health');
    });

    it('dev.deployState wraps devDeployState() as a 1-element snapshot', async () => {
      const snap = { mainHead: { sha: 'abc' }, deployedBehindMain: 7, errors: [] };
      vi.doMock('../dev-deploy-state', () => ({ devDeployState: vi.fn(async () => snap) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.deployState', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(snap);
      vi.doUnmock('../dev-deploy-state');
    });

    it('dev.pgHealth wraps pgHealth() as a 1-element snapshot', async () => {
      const health = { version: 'PostgreSQL 17', totalConnections: 3, activeConnections: 1, idleConnections: 2 };
      vi.doMock('../dev-data', () => ({
        pgHealth: vi.fn(async () => health),
        pgActiveQueries: vi.fn(async () => ({ queries: [] })),
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.pgHealth', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(health);
      vi.doUnmock('../dev-data');
    });

    it('dev.pgActiveQueries returns the flat queries array (honours the limit arg)', async () => {
      const queries = [{ pid: 1, state: 'active', query: 'SELECT 1', duration_seconds: 0.1 }];
      const pgActiveQueries = vi.fn(async () => ({ queries }));
      vi.doMock('../dev-data', () => ({ pgActiveQueries, pgHealth: vi.fn() }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.pgActiveQueries', { limit: 10 })) as unknown[];
      expect(rows).toEqual(queries);
      expect(pgActiveQueries).toHaveBeenCalledWith(10);
      vi.doUnmock('../dev-data');
    });

    it('dev.pgActiveQueries rejects an out-of-range limit (zod)', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('dev.pgActiveQueries', { limit: 9999 })).rejects.toThrow();
    });

    it('dev.coordPresence returns the flat presence array (passes workspace through)', async () => {
      const records = [{ ownerId: 'a', ownerLabel: 'A', stale: false, intent: 'x' }];
      const listPresence = vi.fn(async () => records);
      vi.doMock('../agent-tools/coordination/presence', () => ({ listPresence }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.coordPresence', { workspace: 'ws1' })) as unknown[];
      expect(rows).toEqual(records);
      expect(listPresence).toHaveBeenCalledWith({ workspaceId: 'ws1' });
      vi.doUnmock('../agent-tools/coordination/presence');
    });

    it('dev.fleetGovernor wraps buildFleetRateStatus() as a 1-element snapshot', async () => {
      const status = { ok: true, fleet: { cap: 8, inFlight: 2, effective: 8, floor: 1 }, buckets: [] };
      vi.doMock('../fleet-rate-status', () => ({ buildFleetRateStatus: vi.fn(async () => status) }));
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('dev.fleetGovernor', {})) as unknown[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(status);
      vi.doUnmock('../fleet-rate-status');
    });
  });
});
