import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { WorkItem } from '../work-items';
import { dreamCorpusFromFragments, readDreamSources, readDreamProblemContext, type DreamSourceDeps } from './dream-sources';
import { activeWorkspaceId } from '../workspace-registry';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const sql = (() => Promise.resolve([])) as unknown as Sql;

describe('bounded attributable Dream problem sources', () => {
  it('uses the requested workspace and exact pot, excludes unowned/foreign reports and preserves requirement provenance', async () => {
    const d = deps();
    const report = { id: 'EI-1', kind: 'bug' as const, scope: 'harness:member', title: 'State disappears', createdBy: 'reporter', createdAt: new Date(NOW).toISOString() };
    d.readObservations = vi.fn(async () => {
      expect(activeWorkspaceId()).toBe('ws-problem');
      return [report, { ...report, id: 'EI-foreign', scope: 'harness:elsewhere' }, { ...report, id: 'EI-unowned', createdBy: null }];
    });
    d.readWorkItems = vi.fn(async () => [workItem({ id: 'WI-request', kind: 'feature', state: 'open', createdBy: 'requester', closedAt: null }), workItem({ id: 'WI-done', kind: 'feature', createdBy: 'requester' })]);
    const result = await readDreamProblemContext({ workspaceId: 'ws-problem', potSlug: 'member' }, d);
    expect(result.evidence.map(p => p.ref)).toEqual(['observation:EI-1', 'wi:WI-request']);
    expect(result.evidence.every(p => p.workspaceId === 'ws-problem' && p.potSlug === 'member')).toBe(true);
    expect(d.readObservations).toHaveBeenCalledWith({ harnessScopes: ['harness:member'], state: 'open', limit: 12 });
    expect(d.readWorkItems).toHaveBeenCalledWith({ harness: 'member', kind: 'feature', notTerminal: true, limit: 12 });
  });
  it('retains open exploration when no attributable context exists', async () => {
    const d = deps();
    expect(await readDreamProblemContext({ workspaceId: 'ws', potSlug: 'member' }, d)).toMatchObject({ mode: 'open-exploration', evidence: [] });
  });
});

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-DONE',
    kind: 'change',
    family: 'issue',
    harness: 'member',
    title: 'Terminal work with evidence',
    summary: 'A measured completion signal',
    state: 'resolved',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    goalId: null,
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    terminalCompletionRef: 'vitest proved the fix',
    terminalCompletionEvidence: true,
    closedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
    ...overrides,
  } as WorkItem;
}

function deps(): DreamSourceDeps {
  return {
    loadRegistry: vi.fn(async () => ({
      projects: [
        { slug: 'papercusp', path: '/repo' },
        { slug: 'member', path: '/member', hive_slug: 'papercusp' },
        { slug: 'elsewhere', path: '/elsewhere' },
      ],
    })),
    readObservations: vi.fn(async () => [
      {
        id: 'EI-1',
        kind: 'bug' as const,
        scope: 'harness:member',
        title: 'Recent observation',
        body: 'A live sensor reading',
        severity: 'major' as const,
        createdAt: new Date(NOW - DAY_MS).toISOString(),
      },
    ]),
    readWorkItems: vi.fn(async () => [
      workItem(),
      workItem({ id: 'WI-NO-EVIDENCE', terminalCompletionRef: null, terminalCompletionEvidence: null }),
      workItem({
        id: 'WI-NEEDS-HUMAN',
        payload: { needsHuman: true, _completionEvidence: { summary: 'parked' } },
      }),
    ]),
    listMemories: vi.fn(async () => [
      {
        id: 'MEM-1',
        scope: 'hive:papercusp',
        text: 'A remote durable mechanism',
        metadata: { createdAt: new Date(NOW - 30 * DAY_MS).toISOString(), salience: 2 },
      },
    ]),
    readAnalyze: vi.fn(async () => ({
      generatedAt: new Date(NOW).toISOString(),
      cycles: [
        {
          cycleId: 'analyze-1',
          at: new Date(NOW - DAY_MS).toISOString(),
          ideasCount: 4,
          proposalsCount: 2,
          routedCount: 1,
          verdicts: ['keep', 'reject'],
          tick: null,
        },
      ],
    })),
    resolveEmbedder: vi.fn(async () => ({
      mode: 'test-embedder',
      dims: 2,
      embed: vi.fn(async (text: string) => [text.length, 1]),
    })),
  };
}

describe('readDreamSources', () => {
  it('reads the four established strata, filters weak terminal rows, and embeds each indexed fragment once', async () => {
    const d = deps();
    const snapshot = await readDreamSources(
      { sql, workspaceId: 'ws-1', potSlug: 'papercusp', now: NOW, embedConcurrency: 2 },
      d,
    );

    expect(d.readObservations).toHaveBeenCalledWith({
      harnessScopes: ['harness:papercusp', 'harness:member'],
      limit: 2_000,
    });
    expect(d.readWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ harnesses: ['papercusp', 'member'], includeChildren: true, limit: 2_000 }),
    );
    expect(d.listMemories).toHaveBeenCalledWith('hive:papercusp');
    expect(snapshot).toMatchObject({
      harnessScopes: ['harness:papercusp', 'harness:member'],
      embeddingMode: 'test-embedder',
      census: { observations: 1, workItems: 2, memories: 1, stats: 1, indexed: 5, embedded: 5 },
    });
    expect(snapshot.fragments.map((fragment) => fragment.ref).sort()).toEqual([
      'analyze-cycle:analyze-1',
      'memory:MEM-1',
      'observation:EI-1',
      'wi:WI-DONE',
      'wi:WI-NEEDS-HUMAN',
    ]);
    expect(snapshot.fragments.every((fragment) => fragment.embedding?.length === 2)).toBe(true);
  });

  it('fails closed when the shared prose embedder is unavailable or returns invalid vectors', async () => {
    await expect(
      readDreamSources(
        { sql, workspaceId: 'ws-1', potSlug: 'papercusp', now: NOW },
        {
          ...deps(),
          resolveEmbedder: vi.fn(async () => ({ mode: 'disabled' as const, reason: 'provider unavailable' })),
        },
      ),
    ).rejects.toThrow('provider unavailable');

    await expect(
      readDreamSources(
        { sql, workspaceId: 'ws-1', potSlug: 'papercusp', now: NOW },
        {
          ...deps(),
          resolveEmbedder: vi.fn(async () => ({ mode: 'bad', dims: 1, embed: vi.fn(async () => [Number.NaN]) })),
        },
      ),
    ).rejects.toThrow('invalid embedding');
  });
});

describe('dreamCorpusFromFragments', () => {
  it('adapts existing fragments to the shared novelty-corpus vocabulary', () => {
    expect(
      dreamCorpusFromFragments([
        {
          id: 'm',
          kind: 'memory',
          ref: 'memory:m',
          text: 'memory',
          createdAt: new Date(NOW).toISOString(),
          harness: 'papercusp',
        },
        {
          id: 's',
          kind: 'stat',
          ref: 'analyze:s',
          text: 'stat',
          createdAt: new Date(NOW).toISOString(),
          harness: 'papercusp',
        },
      ]),
    ).toEqual([
      { ref: 'memory:m', kind: 'memory', text: 'memory' },
      { ref: 'analyze:s', kind: 'digest-pattern', text: 'stat' },
    ]);
  });
});
