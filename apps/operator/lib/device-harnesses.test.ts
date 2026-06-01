/**
 * Tests for device-harnesses. Mocks `@papercusp/db-org` so the registry
 * lookup, status merge, and lane/escalation rollups are exercised
 * without a live Postgres.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// `readHarnessRegistryFor` reads via Drizzle `getOrgPg().db.select(...)`; the
// status rollups use a raw `tx\`\`` template inside `withWorkspace`. So the mock
// feeds the registry read from `dbSelectQueue` (fake `db`) and the status reads
// from `txQueue` (raw tx). Real `generated` is kept (importActual) so
// `eq(hr.workspaceId, …)` resolves real columns.
const dbSelectQueue: unknown[][] = [];
const txQueue: unknown[][] = [];

function thenable(result: unknown): any {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(result);
      return () => thenable(result);
    },
  });
}
const fakeDb = { select: () => thenable(dbSelectQueue.shift() ?? []) };

vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as object),
  getOrgPg: () => ({ db: fakeDb }),
  withWorkspace: vi.fn(async (workspaceId: string, fn: (tx: any) => Promise<unknown>) => {
    (globalThis as any).__lastWs = workspaceId;
    const tx = (_strings: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(txQueue.shift() ?? []);
    return fn(tx);
  }),
}));

import { harnessExistsInWorkspace, listHarnessesFor, harnessStatusFor } from './device-harnesses';

beforeEach(() => {
  dbSelectQueue.length = 0;
  txQueue.length = 0;
});

describe('harnessExistsInWorkspace', () => {
  it('returns true when slug is in the registry', async () => {
    dbSelectQueue.push([{ payload: { projects: [{ slug: 'foo', path: '/x' }, { slug: 'bar', path: '/y' }] } }]);
    expect(await harnessExistsInWorkspace('ws-A', 'foo')).toBe(true);
  });
  it('returns false when slug is not present', async () => {
    dbSelectQueue.push([{ payload: { projects: [{ slug: 'foo', path: '/x' }] } }]);
    expect(await harnessExistsInWorkspace('ws-A', 'bar')).toBe(false);
  });
  it('returns false on empty registry row', async () => {
    dbSelectQueue.push([]);
    expect(await harnessExistsInWorkspace('ws-A', 'foo')).toBe(false);
  });
  it('returns false when payload.projects is null', async () => {
    dbSelectQueue.push([{ payload: null }]);
    expect(await harnessExistsInWorkspace('ws-A', 'foo')).toBe(false);
  });
});

describe('listHarnessesFor', () => {
  it('returns [] when registry has no projects', async () => {
    dbSelectQueue.push([]);
    expect(await listHarnessesFor('ws-X')).toEqual([]);
  });

  it('merges status into project rows; missing status → has_state=false', async () => {
    dbSelectQueue.push([{ payload: { projects: [
      { slug: 'a', path: '/a', harness_kind: 'next' },
      { slug: 'b', path: '/b' }, // no status row
    ] } }]);
    txQueue.push([
      { harness_slug: 'a', status: 'iterating', iteration: 3, last_active_ts: 1000 },
    ]);

    const out = await listHarnessesFor('ws-X');
    expect((globalThis as any).__lastWs).toBe('ws-X');
    expect(out).toHaveLength(2);

    const a = out.find((h) => h.slug === 'a')!;
    expect(a).toMatchObject({
      slug: 'a', path: '/a', harness_kind: 'next',
      has_state: true, status: 'iterating', iteration: 3, last_active_ts: 1000,
    });

    const b = out.find((h) => h.slug === 'b')!;
    expect(b).toMatchObject({
      slug: 'b', path: '/b', harness_kind: null,
      has_state: false, status: null, iteration: null, last_active_ts: null,
    });
  });
});

describe('harnessStatusFor', () => {
  it('returns null when slug has no status row', async () => {
    txQueue.push([]); // status query
    expect(await harnessStatusFor('ws-Y', 'missing')).toBeNull();
  });

  it('rolls up status + lane roles + escalation', async () => {
    txQueue.push([{
      phase: 'staging', status: 'iterating', iteration: 2,
      total_features: 5, passed_count: 3, todo_count: 1, blocked_count: 0,
      last_active_ts: 999, cost_usd: 0.1,
    }]);
    txQueue.push([{ role: 'worker' }, { role: 'reviewer' }]);
    txQueue.push([{ escalation: 'needs-human' }]);

    const out = await harnessStatusFor('ws-Y', 'foo');
    expect(out).toMatchObject({
      slug: 'foo',
      phase: 'staging',
      status: 'iterating',
      active_roles: ['worker', 'reviewer'],
      escalation: 'needs-human',
    });
  });

  it('escalation defaults to null when none recorded', async () => {
    txQueue.push([{
      phase: 'staging', status: 'running', iteration: 1,
      total_features: 0, passed_count: 0, todo_count: 0, blocked_count: 0,
      last_active_ts: null, cost_usd: null,
    }]);
    txQueue.push([]); // lanes
    txQueue.push([]); // escalations

    const out = await harnessStatusFor('ws-Y', 'foo');
    expect(out!.escalation).toBeNull();
    expect(out!.active_roles).toEqual([]);
  });
});
