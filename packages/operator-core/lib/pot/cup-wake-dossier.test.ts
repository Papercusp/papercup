import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderCupDossier,
  computeCupWakeDossier,
  presenceToRosterPeer,
  type CupRosterPeer,
} from './cup-wake-dossier';
import type { WorkItem, WorkItemDetail } from '../work-items';

// L1d mem0 background recall: mocked at the top so every computeCupWakeDossier
// call in this file gets a deterministic result instead of hitting the real
// (unavailable-in-test) mem0 backend. Defaults to "no hits" (null) so the
// pre-existing tests below — which don't care about the recall section — see
// no extra content; individual tests reconfigure via mockResolvedValueOnce /
// mockRejectedValueOnce.
const mockBuildMemoryContextBlock = vi.fn().mockResolvedValue(null);
vi.mock('../memory/injection', () => ({ buildMemoryContextBlock: mockBuildMemoryContextBlock }));

// EI-20089384158051187: the standing-facts fold's `role` leg must be the SPAWNING
// role, never a hardcoded one. We capture the selectors `foldFactsWithCensus` is
// called with (P-004/D-006 moved computeCupWakeDossier off the plain `foldFacts`
// wrapper onto `foldFactsWithCensus` so the dossier can render the per-selector
// census — this mock must intercept whichever one production actually calls, or
// the real (unmocked) function runs against no live DB, silently fails soft via
// its own .catch(() => ''), and every assertion on the captured selectors sees
// an empty call list instead of a real mismatch).
// The factory SPREADS the original module rather than returning only these two
// exports — returning a partial factory is how a mock strands some other consumer
// of the same module and turns a green typecheck into a red tree.
const mockFoldFacts = vi.fn().mockResolvedValue({ facts: [], census: [] });
vi.mock('../agent-facts/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-facts/store')>()),
  foldFactsWithCensus: mockFoldFacts,
  renderFactsFold: () => '',
}));

function wi(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-1',
    kind: 'feature',
    family: 'feature',
    harness: 'papercup',
    title: 'Add the thing',
    summary: 'Build the thing per the spec.',
    state: 'todo',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: null,
    goalId: null,
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
    closedAt: null,
    ...over,
  };
}

function detail(
  over: {
    topics?: string[];
    links?: { rel: string; dst: unknown }[];
    posts?: { author_id: string | null; body: string }[];
  } = {},
): WorkItemDetail {
  return {
    ...wi(),
    topics: over.topics ?? [],
    posts: (over.posts ?? []) as unknown as WorkItemDetail['posts'],
    links: (over.links ?? []) as unknown as WorkItemDetail['links'],
  };
}

describe('renderCupDossier (pure)', () => {
  it('renders the item header + summary', () => {
    const s = renderCupDossier({ item: wi() });
    expect(s).toContain('WI-1');
    expect(s).toContain('Add the thing');
    expect(s).toContain('Build the thing per the spec.');
    expect(s).toContain('[feature · todo]');
  });

  it('flags remote work with its audit verdict + verified author', () => {
    const s = renderCupDossier({
      item: wi({ origin: 'remote', auditVerdict: 'pending', verifiedAuthorGithubUserId: 42 }),
    });
    expect(s).toContain('remote work');
    expect(s).toContain('pending');
    expect(s).toContain('gh:42');
  });

  it('renders plan, blocks, topics, and the roster', () => {
    const roster: CupRosterPeer[] = [{ id: 'su-a', label: 'su · a', role: 'cup', doing: 'WI-2', alive: true }];
    const s = renderCupDossier({
      item: wi(),
      planItem: 'my-plan / P-003',
      blocks: ['WI-9'],
      topics: ['hive', 'cache'],
      roster,
    });
    expect(s).toContain('### Plan');
    expect(s).toContain('my-plan / P-003');
    expect(s).toContain('### Blocks downstream');
    expect(s).toContain('WI-9');
    expect(s).toContain('### Topics');
    expect(s).toContain('hive, cache');
    expect(s).toContain('### Pot peers');
    expect(s).toContain('su · a');
    expect(s).toContain('(cup)');
  });

  it('renders recent comments (newest-first list)', () => {
    const s = renderCupDossier({ item: wi(), comments: ['su-b: did Y', 'su-a: did X'] });
    expect(s).toContain('### Recent comments');
    expect(s).toContain('su-b: did Y');
    expect(s).toContain('su-a: did X');
  });

  it('omits empty sections (no plan/blocks/topics/comments/roster ⇒ just the item)', () => {
    const s = renderCupDossier({ item: wi() });
    expect(s).not.toContain('### Plan');
    expect(s).not.toContain('### Blocks');
    expect(s).not.toContain('### Topics');
    expect(s).not.toContain('### Recent comments');
    expect(s).not.toContain('### Pot peers');
  });

  it('caps the roster + flags the overflow', () => {
    const roster: CupRosterPeer[] = Array.from({ length: 25 }, (_, i) => ({ id: `su-${i}`, alive: true }));
    const s = renderCupDossier({ item: wi(), roster, caps: { roster: 5 } });
    expect(s).toContain('…+20 more');
  });

  it('renders the memoryFold (L1d background recall) verbatim, after the facts fold', () => {
    const s = renderCupDossier({
      item: wi(),
      factsFold: '## Standing facts\n\n- a fact',
      memoryFold: '## Background recall (fuzzy memory — may be stale)\n\n- a memory hit',
    });
    expect(s).toContain('a fact');
    expect(s).toContain('a memory hit');
    expect(s!.indexOf('a fact')).toBeLessThan(s!.indexOf('a memory hit'));
  });

  it('omits the memoryFold section when absent (no empty heading)', () => {
    const s = renderCupDossier({ item: wi() });
    expect(s).not.toContain('Background recall');
  });
});

describe('standing-facts role leg (EI-20089384158051187)', () => {
  const base = { workspaceId: 'ws', harness: 'papercup', workItemId: 'WI-1' };
  const liveDeps = {
    getDetail: async () => null,
    getItem: async () => wi(),
    listRoster: async () => [] as CupRosterPeer[],
  };
  const roleLegs = () =>
    (mockFoldFacts.mock.calls.at(-1)?.[0] ?? []).filter(
      (s: { scope: string }) => s.scope === 'role',
    );

  afterEach(() => mockFoldFacts.mockClear());

  it('folds the SPAWNING role, not a hardcoded one', async () => {
    await computeCupWakeDossier({ ...base, role: 'su', deps: liveDeps });
    expect(roleLegs()).toEqual([{ scope: 'role', scopeRef: 'su' }]);
  });

  it('OMITS the role leg entirely when the role is unknown (never guesses)', async () => {
    await computeCupWakeDossier({ ...base, deps: liveDeps });
    expect(roleLegs()).toEqual([]);
  });

  it('still folds the workspace / harness / work_item legs regardless of role', async () => {
    await computeCupWakeDossier({ ...base, role: 'mug', deps: liveDeps });
    const scopes = (mockFoldFacts.mock.calls.at(-1)?.[0] ?? []).map(
      (s: { scope: string }) => s.scope,
    );
    expect(scopes).toEqual(['workspace', 'role', 'harness', 'work_item']);
  });
});

describe('computeCupWakeDossier (fail-soft, injected deps)', () => {
  const base = { workspaceId: 'ws', harness: 'papercup', workItemId: 'WI-1' };

  it('renders from the detail (links → plan + blocks, topics) + the roster', async () => {
    const d = detail({
      topics: ['cache'],
      links: [
        { rel: 'blocks', dst: { kind: 'feature', id: 'WI-9' } },
        { rel: 'sourced-from', dst: { kind: 'plan_item', id: 'pl/P-003' } },
      ],
      // chronological; the dossier renders newest-first.
      posts: [
        { author_id: 'su-old', body: 'first note' },
        { author_id: 'su-new', body: 'latest note' },
      ],
    });
    const s = await computeCupWakeDossier({
      ...base,
      deps: {
        getDetail: async () => d,
        getItem: async () => wi(),
        listRoster: async () => [{ id: 'su-a', label: 'a', role: 'cup', doing: null, alive: true }],
      },
    });
    expect(s).toContain('WI-1');
    expect(s).toContain('WI-9'); // outgoing blocks edge
    expect(s).toContain('pl/P-003'); // plan_item edge → the Plan section
    expect(s).toContain('cache'); // topic
    expect(s).toContain('su-new: latest note'); // comment, newest-first
    expect(s!.indexOf('su-new: latest note')).toBeLessThan(s!.indexOf('su-old: first note')); // newest before oldest
    expect(s).toContain('Pot peers');
  });

  it('null core (both reads null) → null dossier — cup falls back to its tools (D-004)', async () => {
    const s = await computeCupWakeDossier({
      ...base,
      deps: { getDetail: async () => null, getItem: async () => null, listRoster: async () => [] },
    });
    expect(s).toBeNull();
  });

  it('detail read THROWS → falls back to the bare item (core renders; link/topic sections degrade)', async () => {
    const s = await computeCupWakeDossier({
      ...base,
      deps: {
        getDetail: async () => {
          throw new Error('pg down');
        },
        getItem: async () => wi(),
        listRoster: async () => [],
      },
    });
    expect(s).toContain('WI-1');
    expect(s).not.toContain('### Topics');
  });

  it('roster read THROWS → that section degrades, the rest renders', async () => {
    const s = await computeCupWakeDossier({
      ...base,
      deps: {
        getDetail: async () => detail({ topics: ['x'] }),
        getItem: async () => wi(),
        listRoster: async () => {
          throw new Error('presence down');
        },
      },
    });
    expect(s).toContain('WI-1');
    expect(s).toContain('### Topics');
    expect(s).not.toContain('### Pot peers');
  });
});

describe('computeCupWakeDossier — L1d mem0 background recall', () => {
  const base = { workspaceId: 'ws', harness: 'papercup', workItemId: 'WI-1' };

  afterEach(() => {
    mockBuildMemoryContextBlock.mockReset().mockResolvedValue(null);
  });

  it('a mem0 hit flows into the rendered dossier, queried on the item title + summary', async () => {
    mockBuildMemoryContextBlock.mockResolvedValueOnce(
      '## Background recall (fuzzy memory — may be stale)\n\n- [insight] watch out for X',
    );

    const s = await computeCupWakeDossier({
      ...base,
      deps: { getDetail: async () => null, getItem: async () => wi(), listRoster: async () => [] },
    });

    expect(s).toContain('watch out for X');
    expect(mockBuildMemoryContextBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws',
        harnessSlugs: ['papercup'],
        queryContext: 'Add the thing — Build the thing per the spec.',
        limit: 3,
      }),
    );
  });

  it('a mem0 read that THROWS degrades to no recall section — the rest of the dossier still renders (fail-soft)', async () => {
    mockBuildMemoryContextBlock.mockRejectedValueOnce(new Error('mem0 down'));

    const s = await computeCupWakeDossier({
      ...base,
      deps: { getDetail: async () => null, getItem: async () => wi(), listRoster: async () => [] },
    });

    expect(s).toContain('WI-1');
    expect(s).not.toContain('Background recall');
  });

  it('a null mem0 result (no hits) renders no recall section', async () => {
    mockBuildMemoryContextBlock.mockResolvedValueOnce(null);

    const s = await computeCupWakeDossier({
      ...base,
      deps: { getDetail: async () => null, getItem: async () => wi(), listRoster: async () => [] },
    });

    expect(s).not.toContain('Background recall');
  });
});

describe('presenceToRosterPeer (defensive presence projection)', () => {
  it('projects the stable fields + maps stale→!alive', () => {
    expect(
      presenceToRosterPeer({ ownerId: 'su-x', ownerLabel: 'su · x', agentRole: 'cup', intent: 'doing WI-2', stale: false }),
    ).toEqual({ id: 'su-x', label: 'su · x', role: 'cup', doing: 'doing WI-2', alive: true });
    expect(presenceToRosterPeer({ ownerId: 'su-y', stale: true }).alive).toBe(false);
    // missing fields degrade to null, never throw
    expect(presenceToRosterPeer({ ownerId: 'su-z' })).toEqual({ id: 'su-z', label: null, role: null, doing: null, alive: true });
  });
});
