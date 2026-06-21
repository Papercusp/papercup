import { describe, expect, it } from 'vitest';
import {
  renderBeeDossier,
  computeBeeWakeDossier,
  presenceToRosterPeer,
  type BeeRosterPeer,
} from './bee-wake-dossier';
import type { WorkItem, WorkItemDetail } from '../work-items';

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
    severity: null,
    parent: null,
    payload: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
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

describe('renderBeeDossier (pure)', () => {
  it('renders the item header + summary', () => {
    const s = renderBeeDossier({ item: wi() });
    expect(s).toContain('WI-1');
    expect(s).toContain('Add the thing');
    expect(s).toContain('Build the thing per the spec.');
    expect(s).toContain('[feature · todo]');
  });

  it('flags remote work with its audit verdict + verified author', () => {
    const s = renderBeeDossier({
      item: wi({ origin: 'remote', auditVerdict: 'pending', verifiedAuthorGithubUserId: 42 }),
    });
    expect(s).toContain('remote work');
    expect(s).toContain('pending');
    expect(s).toContain('gh:42');
  });

  it('renders plan, blocks, topics, and the roster', () => {
    const roster: BeeRosterPeer[] = [{ id: 'su-a', label: 'su · a', role: 'bee', doing: 'WI-2', alive: true }];
    const s = renderBeeDossier({
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
    expect(s).toContain('### Hive peers');
    expect(s).toContain('su · a');
    expect(s).toContain('(bee)');
  });

  it('renders recent comments (newest-first list)', () => {
    const s = renderBeeDossier({ item: wi(), comments: ['su-b: did Y', 'su-a: did X'] });
    expect(s).toContain('### Recent comments');
    expect(s).toContain('su-b: did Y');
    expect(s).toContain('su-a: did X');
  });

  it('omits empty sections (no plan/blocks/topics/comments/roster ⇒ just the item)', () => {
    const s = renderBeeDossier({ item: wi() });
    expect(s).not.toContain('### Plan');
    expect(s).not.toContain('### Blocks');
    expect(s).not.toContain('### Topics');
    expect(s).not.toContain('### Recent comments');
    expect(s).not.toContain('### Hive peers');
  });

  it('caps the roster + flags the overflow', () => {
    const roster: BeeRosterPeer[] = Array.from({ length: 25 }, (_, i) => ({ id: `su-${i}`, alive: true }));
    const s = renderBeeDossier({ item: wi(), roster, caps: { roster: 5 } });
    expect(s).toContain('…+20 more');
  });
});

describe('computeBeeWakeDossier (fail-soft, injected deps)', () => {
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
    const s = await computeBeeWakeDossier({
      ...base,
      deps: {
        getDetail: async () => d,
        getItem: async () => wi(),
        listRoster: async () => [{ id: 'su-a', label: 'a', role: 'bee', doing: null, alive: true }],
      },
    });
    expect(s).toContain('WI-1');
    expect(s).toContain('WI-9'); // outgoing blocks edge
    expect(s).toContain('pl/P-003'); // plan_item edge → the Plan section
    expect(s).toContain('cache'); // topic
    expect(s).toContain('su-new: latest note'); // comment, newest-first
    expect(s!.indexOf('su-new: latest note')).toBeLessThan(s!.indexOf('su-old: first note')); // newest before oldest
    expect(s).toContain('Hive peers');
  });

  it('null core (both reads null) → null dossier — bee falls back to its tools (D-004)', async () => {
    const s = await computeBeeWakeDossier({
      ...base,
      deps: { getDetail: async () => null, getItem: async () => null, listRoster: async () => [] },
    });
    expect(s).toBeNull();
  });

  it('detail read THROWS → falls back to the bare item (core renders; link/topic sections degrade)', async () => {
    const s = await computeBeeWakeDossier({
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
    const s = await computeBeeWakeDossier({
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
    expect(s).not.toContain('### Hive peers');
  });
});

describe('presenceToRosterPeer (defensive presence projection)', () => {
  it('projects the stable fields + maps stale→!alive', () => {
    expect(
      presenceToRosterPeer({ ownerId: 'su-x', ownerLabel: 'su · x', agentRole: 'bee', intent: 'doing WI-2', stale: false }),
    ).toEqual({ id: 'su-x', label: 'su · x', role: 'bee', doing: 'doing WI-2', alive: true });
    expect(presenceToRosterPeer({ ownerId: 'su-y', stale: true }).alive).toBe(false);
    // missing fields degrade to null, never throw
    expect(presenceToRosterPeer({ ownerId: 'su-z' })).toEqual({ id: 'su-z', label: null, role: null, doing: null, alive: true });
  });
});
