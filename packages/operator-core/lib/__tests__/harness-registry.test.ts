import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable fixtures the mocks read/write.
let prevState: { projects: unknown[] } | null = null;
const writes: Array<{ table: string; payload: { projects: unknown[] }; ws?: string }> = [];
const auditParams: unknown[][] = [];

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => prevState,
  writeOperatorState: async (table: string, payload: { projects: unknown[] }, ws?: string) => {
    writes.push({ table, payload, ws });
  },
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: {
      unsafe: async (_q: string, params: unknown[]) => {
        auditParams.push(params);
      },
    },
  }),
}));

import { saveHarnessRegistry } from '../harness-registry';

beforeEach(() => {
  prevState = null;
  writes.length = 0;
  auditParams.length = 0;
});

describe('saveHarnessRegistry — catastrophic-empty guard', () => {
  it('throws (and never writes) when emptying a populated registry without allowEmpty', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }, { slug: 'b', path: '/b' }] };
    await expect(saveHarnessRegistry({ projects: [] })).rejects.toThrow(/allowEmpty/);
    expect(writes).toHaveLength(0);
  });

  it('allows emptying with { allowEmpty: true }', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({ projects: [] }, undefined, { allowEmpty: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.projects).toHaveLength(0);
  });

  it('allows growing a registry (guard only targets populated→empty)', async () => {
    prevState = { projects: [] };
    await saveHarnessRegistry({ projects: [{ slug: 'a', path: '/a' }] });
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.projects).toHaveLength(1);
  });

  it('allows an already-empty registry to stay empty', async () => {
    prevState = { projects: [] };
    await saveHarnessRegistry({ projects: [] });
    expect(writes).toHaveLength(1);
  });
});

describe('saveHarnessRegistry — audit trail', () => {
  it('emits a harness_registry.write audit row when the count changes', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({
      projects: [{ slug: 'a', path: '/a' }, { slug: 'b', path: '/b' }],
    });
    expect(auditParams).toHaveLength(1);
    // params order: [id, ts, actor, action, subject, detailsJson, ws]
    const p = auditParams[0];
    expect(p[3]).toBe('harness_registry.write');
    expect(p[6]).toBe('default');
    const details = JSON.parse(p[5] as string) as Record<string, number>;
    expect(details).toMatchObject({ prevCount: 1, nextCount: 2, delta: 1 });
  });

  it('does not audit when the project count is unchanged', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({ projects: [{ slug: 'a', path: '/moved' }] });
    expect(writes).toHaveLength(1);
    expect(auditParams).toHaveLength(0);
  });
});
