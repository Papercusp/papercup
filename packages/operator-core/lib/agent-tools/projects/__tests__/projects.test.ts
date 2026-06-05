/**
 * projects:* tools — list, get, spec_revisions, spec_revision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../projects-data');
});

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('projects:list', () => {
  it('returns harnessSlug + projects', async () => {
    const projects = [{ id: 'PROJ-1', name: 'P1' }];
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(async () => projects),
      getProjectDetail: vi.fn(),
      listProjectSpecRevisions: vi.fn(),
      getProjectSpecRevision: vi.fn(),
    }));
    const { default: tool } = await import('../list');
    const result = await tool.handler({ harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ harnessSlug: 'sheets', projects });
  });

  it('returns an isError envelope when no slug available', async () => {
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(),
      getProjectDetail: vi.fn(),
      listProjectSpecRevisions: vi.fn(),
      getProjectSpecRevision: vi.fn(),
    }));
    const { default: tool } = await import('../list');
    // The tool now returns the canonical MCP {isError:true} envelope instead of
    // throwing, so the dispatcher surfaces the guidance text to the caller.
    const res = await tool.handler({}, MAKE_CTX({ harnessSlug: undefined }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/slug_required|needs a specific harness/i);
  });
});

describe('projects:get', () => {
  it('returns found:true with project', async () => {
    const project = { id: 'PROJ-1', name: 'P1', feature_counts: {}, last_spec_revision: null };
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(),
      getProjectDetail: vi.fn(async () => project),
      listProjectSpecRevisions: vi.fn(),
      getProjectSpecRevision: vi.fn(),
    }));
    const { default: tool } = await import('../get');
    const result = await tool.handler(
      { harnessSlug: 'sheets', id: 'PROJ-1' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      harnessSlug: 'sheets',
      id: 'PROJ-1',
      found: true,
      project,
    });
  });

  it('returns found:false when getProjectDetail returns null', async () => {
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(),
      getProjectDetail: vi.fn(async () => null),
      listProjectSpecRevisions: vi.fn(),
      getProjectSpecRevision: vi.fn(),
    }));
    const { default: tool } = await import('../get');
    const result = await tool.handler(
      { harnessSlug: 'sheets', id: 'PROJ-FAKE' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.found).toBe(false);
    expect(payload.project).toBeNull();
  });
});

describe('projects:spec_revisions', () => {
  it('returns revisions list', async () => {
    const revisions = [{ id: 1, summary: 's' }];
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(),
      getProjectDetail: vi.fn(),
      listProjectSpecRevisions: vi.fn(async () => revisions),
      getProjectSpecRevision: vi.fn(),
    }));
    const { default: tool } = await import('../spec_revisions');
    const result = await tool.handler(
      { harnessSlug: 'sheets', projectId: 'PROJ-1', limit: 5 },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ harnessSlug: 'sheets', projectId: 'PROJ-1', revisions });
  });
});

describe('projects:spec_revision', () => {
  it('returns found:true with full revision body', async () => {
    const revision = { id: 1, spec: '## body', summary: 's' };
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(),
      getProjectDetail: vi.fn(),
      listProjectSpecRevisions: vi.fn(),
      getProjectSpecRevision: vi.fn(async () => revision),
    }));
    const { default: tool } = await import('../spec_revision');
    const result = await tool.handler(
      { harnessSlug: 'sheets', projectId: 'PROJ-1', revId: 1 },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.found).toBe(true);
    expect((payload.revision as Record<string, unknown>).spec).toBe('## body');
  });

  it('returns found:false when revision is null', async () => {
    vi.doMock('../../../projects-data', () => ({
      listProjectsForHarness: vi.fn(),
      getProjectDetail: vi.fn(),
      listProjectSpecRevisions: vi.fn(),
      getProjectSpecRevision: vi.fn(async () => null),
    }));
    const { default: tool } = await import('../spec_revision');
    const result = await tool.handler(
      { harnessSlug: 'sheets', projectId: 'PROJ-1', revId: 999 },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.found).toBe(false);
    expect(payload.revision).toBeNull();
  });
});
