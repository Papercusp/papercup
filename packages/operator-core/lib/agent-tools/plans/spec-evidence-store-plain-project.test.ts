import { describe, expect, it, vi } from 'vitest';

// A project in no Hive holds no plans, so no spec clause can be linked to its work items:
// `listWorkItemSpecRevisionEdges` answers an empty set for it, as `plans:list` answers an
// empty plan list. Before, it threw `resolvePlanScope`'s "not a Hive home" refusal, and the
// spec-test-adequacy close gate, which reads these edges first, refused every terminal close
// of such a project's items (measured: a fleet in a plain project could close nothing with
// proof). A registry READ FAULT is not an absence and still throws.

const h = vi.hoisted(() => ({
  scopeError: null as Error | null,
  queried: 0,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      h.queried += 1;
      const tx = (() =>
        Promise.resolve([
          { work_item_id: 'WI-1', plan_slug: 'plan-one', spec_id: 'SPEC-001', spec_revision: 2, spec_fingerprint: 'sha256:x' },
        ])) as unknown;
      return fn(tx);
    },
  };
});

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async () => {
      if (h.scopeError) throw h.scopeError;
      return { workspaceId: 'workspace-test', harnessSlug: 'hive-home' };
    },
  };
});

const { listWorkItemSpecRevisionEdges } = await import('./spec-evidence-store');
const { RegistryReadUnavailableError } = await import('../../harness-core');

describe('listWorkItemSpecRevisionEdges for a project in no Hive', () => {
  it('answers no edges for a registered project that is not a Hive home, without reading the edge table', async () => {
    h.scopeError = new Error(
      "resolvePlanScope: plans are Hive-scoped, but 'plain-project' is not a Hive home and does not belong to one in workspace 'w'.",
    );
    h.queried = 0;

    await expect(listWorkItemSpecRevisionEdges({ harnessSlug: 'plain-project', workItemId: 'WI-1' })).resolves.toEqual([]);
    expect(h.queried).toBe(0);
  });

  it('still reads the edges of a Hive member', async () => {
    h.scopeError = null;

    const edges = await listWorkItemSpecRevisionEdges({ harnessSlug: 'hive-member', workItemId: 'WI-1' });

    expect(edges.map((edge) => [edge.planSlug, edge.specId, edge.specRevision])).toEqual([['plan-one', 'SPEC-001', 2]]);
  });

  it('still throws when the registry could not be read: a failed read is never an absence', async () => {
    // Its message carries the cause's text, which may even read like an absence.
    h.scopeError = new RegistryReadUnavailableError('plain-project', new Error('plain-project is not a Hive home'));

    await expect(listWorkItemSpecRevisionEdges({ harnessSlug: 'plain-project', workItemId: 'WI-1' })).rejects.toThrow(
      'could not READ the harness registry',
    );
  });
});
