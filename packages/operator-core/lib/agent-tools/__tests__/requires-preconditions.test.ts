/**
 * requires: precondition conformance for the migrated harness-slug guards
 * (adopt-event-rules-engines-2026-06-04, the requires:-half — D-012).
 *
 * Five tools' former in-handler `if (!slug) throw` guards are lifted into a
 * declarative `requires:` precondition (the autoloop:status proof-migration
 * pattern). Each test asserts the SAME contract: (a) the tool declares the
 * `harness-slug` spec, (b) the dispatcher rejects `precondition_failed`
 * BEFORE the handler runs when neither the arg nor ctx carries a slug, and
 * (c) a ctx-scoped slug lets the handler run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../cross-harness-data');
  vi.doUnmock('../../projects-data');
});

/** Run one tool through the projected dispatcher with and without a slug. */
async function expectSlugPrecondition(opts: {
  importTool: () => Promise<{ default: { requires?: Array<{ id?: string }> } }>;
  mcpName: string;
  args: Record<string, unknown>;
}): Promise<void> {
  const { default: tool } = await opts.importTool();
  const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/tooldef');
  // (a) the tool declares the precondition…
  expect(tool.requires?.[0]?.id).toBe('harness-slug');
  const projected = lookupByMcpName(opts.mcpName);
  expect(projected).toBeDefined();
  // (b) …the dispatcher enforces it: no arg, no ctx slug → precondition_failed.
  const denied = await dispatchProjectedTool(
    projected!,
    opts.mcpName,
    opts.args,
    MAKE_CTX({ harnessSlug: undefined }),
    {},
  );
  expect(denied.ok).toBe(false);
  expect(denied.error?.code).toBe('precondition_failed');
  expect(denied.error?.message).toMatch(/slug required/i);
  // (c) a ctx-scoped slug satisfies it (the handler then runs).
  const allowed = await dispatchProjectedTool(projected!, opts.mcpName, opts.args, MAKE_CTX(), {});
  expect(allowed.ok).toBe(true);
}

describe('cross_harness:* harness-slug requires: preconditions', () => {
  const mockCrossHarnessData = () =>
    vi.doMock('../../cross-harness-data', () => ({
      readInbox: vi.fn(async () => []),
      readOutbox: vi.fn(async () => []),
      readSupervisorNotes: vi.fn(async () => []),
      readRecentActivity: vi.fn(async () => []),
    }));

  it('cross_harness:inbox rejects precondition_failed without a slug; ctx slug passes', async () => {
    mockCrossHarnessData();
    await expectSlugPrecondition({
      importTool: () => import('../cross_harness/inbox'),
      mcpName: 'cross_harness:inbox',
      args: {},
    });
  });

  it('cross_harness:outbox rejects precondition_failed without a slug; ctx slug passes', async () => {
    mockCrossHarnessData();
    await expectSlugPrecondition({
      importTool: () => import('../cross_harness/outbox'),
      mcpName: 'cross_harness:outbox',
      args: {},
    });
  });

  it('cross_harness:supervisor_notes rejects precondition_failed without a slug; ctx slug passes', async () => {
    mockCrossHarnessData();
    await expectSlugPrecondition({
      importTool: () => import('../cross_harness/supervisor_notes'),
      mcpName: 'cross_harness:supervisor_notes',
      args: {},
    });
  });
});

describe('projects:spec_revision* harness-slug requires: preconditions', () => {
  const mockProjectsData = () =>
    vi.doMock('../../projects-data', () => ({
      listProjectSpecRevisions: vi.fn(async () => []),
      getProjectSpecRevision: vi.fn(async () => null),
    }));

  it('projects:spec_revisions rejects precondition_failed without a slug; ctx slug passes', async () => {
    mockProjectsData();
    await expectSlugPrecondition({
      importTool: () => import('../projects/spec_revisions'),
      mcpName: 'projects:spec_revisions',
      args: { projectId: 'P-1' },
    });
  });

  it('projects:spec_revision rejects precondition_failed without a slug; ctx slug passes', async () => {
    mockProjectsData();
    await expectSlugPrecondition({
      importTool: () => import('../projects/spec_revision'),
      mcpName: 'projects:spec_revision',
      args: { projectId: 'P-1', revId: 1 },
    });
  });
});
