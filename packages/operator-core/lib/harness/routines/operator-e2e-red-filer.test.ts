/**
 * WI-10006806 (plan operator-e2e-standing-isolated-run-2026-10-06 P-003): every red in the
 * standing operator e2e run gets exactly one owned work-item. The deps seam is injected, so these
 * tests exercise the real decision logic without a database.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../task-manager/store', () => ({ listTasks: vi.fn(async () => []) }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('../../agent-tools/work_items/_create-core', () => ({ createOneWorkItem: vi.fn() }));
vi.mock('../../work-items', () => ({ claimWorkItem: vi.fn() }));
vi.mock('../improvements/watchdog', () => ({
  normalizeRedTestPath: (p: string) => (p.includes('__synthetic__') ? null : p.replace(/^.*papercupai-workspace\/[^/]+\//, '')),
}));
vi.mock('../operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
vi.mock('./system-actions', () => ({ registerSystemAction: vi.fn() }));

import {
  classifyOwnership,
  fileOperatorE2eReds,
  namesSpec,
  redSpecsFromGroupRows,
  renderRedItem,
  specStem,
  type GroupSpecRow,
  type OwnershipCandidate,
  type RedFilerDeps,
} from './operator-e2e-red-filer';

const SPEC = 'apps/operator/e2e/home.spec.ts';

function row(filePath: string, status: string, finishedAt: string, extra: Partial<GroupSpecRow> = {}): GroupSpecRow {
  return { filePath, status, finishedAt, outputTail: 'boom', failedCaseTitles: [], ...extra };
}

describe('spec identity', () => {
  it('derives the stem and matches cluster-style and path-style mentions only as whole tokens', () => {
    expect(specStem(SPEC)).toBe('home');
    expect(namesSpec('failing test ids: home:15, home:20', SPEC)).toBe(true);
    expect(namesSpec('Operator e2e red: apps/operator/e2e/home.spec.ts', SPEC)).toBe(true);
    expect(namesSpec('workspace-home:12 failed', SPEC)).toBe(false);
    expect(namesSpec('the home page loads', SPEC)).toBe(false);
    expect(namesSpec(null, SPEC)).toBe(false);
  });
});

describe('redSpecsFromGroupRows', () => {
  it('keeps the latest row per spec and only when it is red', () => {
    const reds = redSpecsFromGroupRows([
      row(SPEC, 'fail', '2026-10-06T04:40:00Z'),
      row('apps/operator/e2e/b.spec.ts', 'fail', '2026-10-06T04:41:00Z'),
      row('apps/operator/e2e/b.spec.ts', 'pass', '2026-10-06T04:45:00Z'),
      row('apps/operator/e2e/c.spec.ts', 'error', '2026-10-06T04:42:00Z'),
      row('apps/operator/e2e/__synthetic__/d.spec.ts', 'fail', '2026-10-06T04:42:00Z'),
    ]);
    expect(reds.map((r) => [r.specPath, r.status])).toEqual([
      ['apps/operator/e2e/c.spec.ts', 'error'],
      [SPEC, 'fail'],
    ]);
  });
});

describe('classifyOwnership (plan D-001 #2)', () => {
  const finished = '2026-10-06T05:00:00Z';
  const cand = (over: Partial<OwnershipCandidate>): OwnershipCandidate => ({
    id: 'WI-1',
    status: 'open',
    assignee: null,
    closedAt: null,
    title: 'x',
    summary: 'failing test ids: home:15',
    ...over,
  });
  it('an open assigned item naming the spec owns it', () => {
    expect(classifyOwnership(SPEC, [cand({ assignee: 'su-a' })], finished)).toEqual({ kind: 'owned', id: 'WI-1', assignee: 'su-a' });
  });
  it('an item closed after the evidence answers it; one closed before does not', () => {
    expect(classifyOwnership(SPEC, [cand({ status: 'done', closedAt: '2026-10-06T06:00:00Z' })], finished).kind).toBe(
      'resolved-after-evidence',
    );
    expect(classifyOwnership(SPEC, [cand({ status: 'done', closedAt: '2026-10-05T06:00:00Z' })], finished).kind).toBe('none');
  });
  it('an open unassigned item is adopted rather than duplicated; an item about another spec is ignored', () => {
    expect(classifyOwnership(SPEC, [cand({})], finished)).toEqual({ kind: 'unassigned-open', id: 'WI-1' });
    expect(classifyOwnership(SPEC, [cand({ assignee: 'su-a', summary: 'workspace-home:3' })], finished).kind).toBe('none');
  });
});

describe('renderRedItem', () => {
  it('names the spec path, the failing cases, the run group and a de-coloured tail', () => {
    const { title, summary } = renderRedItem(
      { specPath: SPEC, status: 'fail', finishedAt: 'T', outputTail: '\u001b[31mexpected 1\u001b[39m', failedCaseTitles: ['home > redirects'] },
      'operator-e2e-nightly:wf-1',
    );
    expect(title).toBe(`Operator e2e red: ${SPEC}`);
    expect(summary).toContain('- home > redirects');
    expect(summary).toContain('operator-e2e-nightly:wf-1');
    expect(summary).toContain('expected 1');
    expect(summary).not.toContain('\u001b');
  });
});

/** An in-memory ledger + work queue: the create/assign deps write into `items`. */
function world(opts: { groups: Array<{ runGroup: string; finishedAt: string; rows: GroupSpecRow[] }>; inFlight?: string[]; umbrellaAssignee?: string | null }) {
  const items: OwnershipCandidate[] = [];
  let next = 1;
  const deps: RedFilerDeps = {
    listGroups: async () =>
      [...opts.groups].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).map(({ runGroup, finishedAt }) => ({ runGroup, finishedAt })),
    inFlightGroups: async () => opts.inFlight ?? [],
    groupRows: async (g) => opts.groups.find((x) => x.runGroup === g)?.rows ?? [],
    ownershipCandidates: async (_ws, _h, spec) => items.filter((i) => namesSpec(i.title, spec) || namesSpec(i.summary, spec)),
    assigneeOf: async () => opts.umbrellaAssignee ?? null,
    create: vi.fn(async (args) => {
      const id = `WI-${next++}`;
      items.push({ id, status: 'open', assignee: args.assign_to ?? null, closedAt: null, title: args.title, summary: args.summary ?? null });
      return { id };
    }),
    assign: vi.fn(async (id, owner) => {
      const it = items.find((i) => i.id === id);
      if (it) it.assignee = owner;
      return true;
    }),
  };
  return { deps, items };
}

const CTX = { installSlug: 'papercusp', workspaceId: 'ws', payloadTemplate: { redOwner: 'su-owner' } };

describe('fileOperatorE2eReds', () => {
  it('ACCEPTANCE: a spec red on two consecutive runs produces exactly one owned work-item', async () => {
    const night1 = { runGroup: 'operator-e2e-nightly:n1', finishedAt: '2026-10-06T05:00:00Z', rows: [row(SPEC, 'fail', '2026-10-06T05:00:00Z')] };
    const night2 = { runGroup: 'operator-e2e-nightly:n2', finishedAt: '2026-10-07T05:00:00Z', rows: [row(SPEC, 'fail', '2026-10-07T05:00:00Z')] };
    const w = world({ groups: [night1] });
    const first = await fileOperatorE2eReds(CTX, w.deps);
    expect(first.outcomes).toEqual([{ specPath: SPEC, outcome: 'filed', id: 'WI-1' }]);
    // The same group swept again an hour later, then the next night's group.
    await fileOperatorE2eReds(CTX, w.deps);
    const w2deps = { ...w.deps, listGroups: async () => [night2, night1].map(({ runGroup, finishedAt }) => ({ runGroup, finishedAt })), groupRows: async (g: string) => (g === night2.runGroup ? night2.rows : night1.rows) };
    const second = await fileOperatorE2eReds(CTX, w2deps);
    expect(second.outcomes).toEqual([{ specPath: SPEC, outcome: 'owned', id: 'WI-1' }]);
    expect(w.items).toHaveLength(1);
    expect(w.items[0]).toMatchObject({ assignee: 'su-owner', title: `Operator e2e red: ${SPEC}` });
  });

  it('skips a group whose run is still in flight and sweeps the newest finished one', async () => {
    const done = { runGroup: 'operator-e2e-nightly:old', finishedAt: '2026-10-05T05:00:00Z', rows: [row(SPEC, 'fail', '2026-10-05T05:00:00Z')] };
    const live = { runGroup: 'operator-e2e-nightly:live', finishedAt: '2026-10-06T05:00:00Z', rows: [row('apps/operator/e2e/z.spec.ts', 'fail', '2026-10-06T05:00:00Z')] };
    const w = world({ groups: [done, live], inFlight: ['operator-e2e-nightly:live'] });
    const result = await fileOperatorE2eReds(CTX, w.deps);
    expect(result.runGroup).toBe('operator-e2e-nightly:old');
    expect(w.items.map((i) => i.title)).toEqual([`Operator e2e red: ${SPEC}`]);
    const only = world({ groups: [live], inFlight: ['operator-e2e-nightly:live'] });
    expect(await fileOperatorE2eReds(CTX, only.deps)).toMatchObject({ status: 'skipped' });
  });

  it('falls back to the umbrella assignee, adopts an unassigned item, and flags a missing owner', async () => {
    const g = { runGroup: 'operator-e2e-nightly:n', finishedAt: '2026-10-06T05:00:00Z', rows: [row(SPEC, 'fail', '2026-10-06T05:00:00Z')] };
    const viaUmbrella = world({ groups: [g], umbrellaAssignee: 'su-umbrella' });
    viaUmbrella.items.push({ id: 'WI-77', status: 'open', assignee: null, closedAt: null, title: 'cluster', summary: 'home:15 redirects' });
    const adopted = await fileOperatorE2eReds({ ...CTX, payloadTemplate: null }, viaUmbrella.deps);
    expect(adopted.outcomes).toEqual([{ specPath: SPEC, outcome: 'assigned', id: 'WI-77' }]);
    expect(viaUmbrella.items).toHaveLength(1);
    expect(viaUmbrella.items[0]!.assignee).toBe('su-umbrella');

    const orphan = world({ groups: [g], umbrellaAssignee: null });
    const res = await fileOperatorE2eReds({ ...CTX, payloadTemplate: null }, orphan.deps);
    expect(res).toMatchObject({ ownerUnresolved: true, owner: null });
    expect(orphan.items).toEqual([expect.objectContaining({ assignee: null })]);
  });

  it('does not flag an unresolved owner when every red already has an owner or was resolved', async () => {
    const g = {
      runGroup: 'operator-e2e-nightly:answered',
      finishedAt: '2026-10-06T05:00:00Z',
      rows: [
        row(SPEC, 'fail', '2026-10-06T05:00:00Z'),
        row('apps/operator/e2e/other.spec.ts', 'fail', '2026-10-06T05:00:00Z'),
      ],
    };
    const answered = world({ groups: [g], umbrellaAssignee: null });
    answered.items.push(
      {
        id: 'WI-78',
        status: 'open',
        assignee: 'su-owner',
        closedAt: null,
        title: 'Operator e2e red: apps/operator/e2e/home.spec.ts',
        summary: null,
      },
      {
        id: 'WI-79',
        status: 'done',
        assignee: 'su-owner',
        closedAt: '2026-10-06T06:00:00Z',
        title: 'Operator e2e red: apps/operator/e2e/other.spec.ts',
        summary: null,
      },
    );

    const result = await fileOperatorE2eReds({ ...CTX, payloadTemplate: null }, answered.deps);

    expect(result.owner).toBeNull();
    expect(result.outcomes?.map((outcome) => outcome.outcome).sort()).toEqual(['owned', 'resolved-after-evidence']);
    expect(result.ownerUnresolved).toBe(false);
  });

  it('refuses a foreign harness', async () => {
    const w = world({ groups: [] });
    expect(await fileOperatorE2eReds({ ...CTX, installSlug: 'portal' }, w.deps)).toMatchObject({ status: 'skipped' });
  });
});
