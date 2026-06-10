import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable fixtures the mocks read/write.
type RegistryPayload = { projects: unknown[] } & Record<string, unknown>;
let prevState: RegistryPayload | null = null;
const writes: Array<{ table: string; payload: RegistryPayload; ws?: string }> = [];
const auditParams: unknown[][] = [];

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => prevState,
  writeOperatorState: async (table: string, payload: RegistryPayload, ws?: string) => {
    writes.push({ table, payload, ws });
  },
  // Emulates the FOR UPDATE read-mutate-upsert tx: mutate the committed
  // value, commit the result, surface it as a write.
  updateOperatorState: async (
    table: string,
    defaultValue: RegistryPayload,
    mutator: (cur: RegistryPayload) => RegistryPayload,
    ws?: string,
  ) => {
    const next = mutator(prevState ?? defaultValue);
    prevState = next;
    writes.push({ table, payload: next, ws });
    return next;
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

import { mutateHarnessRegistry, saveHarnessRegistry } from '../harness-registry';

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

describe('saveHarnessRegistry — sibling-field preservation', () => {
  it('persists hiveDirectoryMeta (was silently dropped on every save)', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({
      projects: [{ slug: 'a', path: '/a' }],
      hiveDirectoryMeta: { h1: { hiveId: 'h1', title: 'Hive', description: '', visibility: 'public', memberTopics: [], createdAt: 1 } },
    } as never);
    expect(writes[0].payload.hiveDirectoryMeta).toBeTruthy();
  });
});

describe('mutateHarnessRegistry — atomic RMW (audit P-006 / EI-82)', () => {
  it('mutates from the CURRENT committed value, not a stale snapshot', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    // First mutator adds b; second removes a. Each must see the prior commit —
    // the lost-update shape would leave a in place or drop b.
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: [...reg.projects, { slug: 'b', path: '/b' }],
    }));
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: reg.projects.filter((p) => p.slug !== 'a'),
    }));
    expect(prevState!.projects).toEqual([{ slug: 'b', path: '/b' }]);
  });

  it('enforces the catastrophic-empty guard inside the transaction', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    const before = writes.length;
    await expect(
      mutateHarnessRegistry(() => ({ projects: [] })),
    ).rejects.toThrow(/allowEmpty/);
    // The throwing mutator still ran through updateOperatorState's mutator,
    // but a real PG tx rolls back — here we just assert it threw before any
    // post-commit bookkeeping (no audit row).
    expect(auditParams).toHaveLength(0);
    expect(writes.length).toBe(before); // mock writes only after mutator returns
  });

  it('allows emptying with { allowEmpty: true } and audits the change', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await mutateHarnessRegistry(() => ({ projects: [] }), undefined, { allowEmpty: true });
    expect(prevState!.projects).toHaveLength(0);
    expect(auditParams).toHaveLength(1);
    const details = JSON.parse(auditParams[0][5] as string) as Record<string, number>;
    expect(details).toMatchObject({ prevCount: 1, nextCount: 0, delta: -1 });
  });

  it('preserves hiveControlFrames + hiveDirectoryMeta through a projects-only mutation', async () => {
    prevState = {
      projects: [{ slug: 'a', path: '/a' }],
      hiveControlFrames: { hv: { id: 'f1' } },
      hiveDirectoryMeta: { hv: { hiveId: 'hv', createdAt: 1 } },
    };
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: [...reg.projects, { slug: 'b', path: '/b' }],
    }));
    expect(prevState!.hiveControlFrames).toBeTruthy();
    expect(prevState!.hiveDirectoryMeta).toBeTruthy();
    expect(prevState!.projects).toHaveLength(2);
  });
});
