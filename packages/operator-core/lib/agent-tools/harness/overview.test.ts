import { describe, it, expect, vi } from 'vitest';

// P-009: the open-issues fold now reads the engineer-issues store directly (listIssues +
// countIssues) instead of round-tripping the retired issues:list tool. Mock the store so
// the default-reader path is exercised without PG; the inject-reader tests pass their own.
vi.mock('../../issues-engineer', () => ({
  listIssues: vi.fn(async () => []),
  countIssues: vi.fn(async () => 0),
}));

import overviewTool, { composeHarnessOverview, type IssuesSnapshotReader } from './overview';
import { listIssues, countIssues } from '../../issues-engineer';
import type { InnerCall } from '../_compound-dispatch';
import type { ListIssuesFilter } from '../../issues-engineer';

function fakeCall(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  call: InnerCall;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: InnerCall = async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> });
    const h = handlers[name];
    if (!h) throw new Error(`unexpected sub-call: ${name}`);
    return h(args as Record<string, unknown>);
  };
  return { call, calls };
}

/** Fake issues reader — replaces the old issues:list sub-call mock (P-009 store-fn rewire).
 *  Records the (filter, limit) it was folded with so tests can assert forwarding. */
function fakeReadIssues(
  impl: (filter: ListIssuesFilter, limit: number) => { count: number; recent: unknown[] },
): { read: IssuesSnapshotReader; folds: Array<{ filter: ListIssuesFilter; limit: number }> } {
  const folds: Array<{ filter: ListIssuesFilter; limit: number }> = [];
  const read: IssuesSnapshotReader = async (filter, limit) => {
    folds.push({ filter, limit });
    return impl(filter, limit);
  };
  return { read, folds };
}

const okIssues = () => ({ count: 2, recent: [{ id: 'EI-1' }, { id: 'EI-2' }] });

describe('harness:overview routing guidance', () => {
  it('reserves the compound read for multi-part requests and routes one status fact directly', () => {
    expect(overviewTool.description).toContain("COMPOUND 'state of X'");
    expect(overviewTool.description).toContain('multi-part/full-picture');
    expect(overviewTool.description).toContain('single fact such as active/current phase');
    expect(overviewTool.description).toContain('direct harness:status call');
    expect(overviewTool.guidance?.when).toContain('status PLUS escalations and open issues');
    expect(overviewTool.guidance?.notWhen).toContain('single harness status fact');
    expect(overviewTool.guidance?.notWhen).toContain('call harness:status directly');
  });
});

describe('composeHarnessOverview (P-006 compound)', () => {
  it('with harness: folds status + escalations + open-issues snapshot (no harness:list)', async () => {
    const { call, calls } = fakeCall({
      'harness:status': () => ({ ok: true, slug: 'sheets', active: true }),
      'harness:escalation': () => ({ ok: true, escalations: [] }),
    });
    const { read, folds } = fakeReadIssues(okIssues);
    const r = await composeHarnessOverview({ harness: 'sheets' }, call, read);
    expect(r.ok).toBe(true);
    expect(r.harness).toBe('sheets');
    expect((r.status as { active: boolean }).active).toBe(true);
    expect(r.escalations).toEqual({ ok: true, escalations: [] });
    expect(r.issues).toEqual({ count: 2, recent: [{ id: 'EI-1' }, { id: 'EI-2' }] });
    expect(r.harnesses).toBeUndefined();
    // issues fold no longer rides `call` — only the harness reads do.
    expect(calls.map((c) => c.name)).toEqual(['harness:status', 'harness:escalation']);
    expect(calls.find((c) => c.name === 'harness:status')!.args).toMatchObject({ slug: 'sheets' });
    expect(folds[0]).toMatchObject({ filter: { state: 'open' }, limit: 25 });
  });

  it('without harness: folds the harness index + open issues (no status/escalation)', async () => {
    const { call, calls } = fakeCall({
      'harness:list': () => ({ ok: true, harnesses: [{ slug: 'a' }, { slug: 'b' }] }),
    });
    const { read } = fakeReadIssues(okIssues);
    const r = await composeHarnessOverview({}, call, read);
    expect(r.harnesses).toEqual({ ok: true, harnesses: [{ slug: 'a' }, { slug: 'b' }] });
    expect(r.status).toBeUndefined();
    expect(r.escalations).toBeUndefined();
    expect(r.issues!.count).toBe(2);
    expect(calls.map((c) => c.name)).toEqual(['harness:list']);
    expect(calls.find((c) => c.name === 'harness:list')!.args).toMatchObject({ detail: 'summary', limit: 50 });
  });

  it('forwards phase, issueState, issueScope, and the limits to the issues fold', async () => {
    const { call, calls } = fakeCall({
      'harness:status': () => ({}),
      'harness:escalation': () => ({}),
    });
    const { read, folds } = fakeReadIssues(() => ({ count: 0, recent: [] }));
    await composeHarnessOverview(
      { harness: 'h', phase: 'testing', issueState: 'resolved', issueScope: 'auth', issuesLimit: 5 },
      call,
      read,
    );
    expect(calls.find((c) => c.name === 'harness:escalation')!.args).toMatchObject({ slug: 'h', phase: 'testing' });
    expect(folds[0]).toMatchObject({ filter: { state: 'resolved', scope: 'auth' }, limit: 5 });
  });

  it('best-effort: a failing sub-call / issues read degrades to null, overview still ok', async () => {
    const { call } = fakeCall({
      'harness:status': () => {
        throw new Error('denied');
      },
      'harness:escalation': () => ({ ok: true }),
    });
    const read: IssuesSnapshotReader = async () => {
      throw new Error('boom');
    };
    const r = await composeHarnessOverview({ harness: 'h' }, call, read);
    expect(r.ok).toBe(true);
    expect(r.status).toBeNull();
    expect(r.escalations).toEqual({ ok: true });
    expect(r.issues).toBeNull();
  });

  it('D-008 COMPACT: clamps issuesLimit to the fold max before folding', async () => {
    const { call } = fakeCall({ 'harness:list': () => ({ harnesses: [] }) });
    const { read, folds } = fakeReadIssues((_f, limit) => ({
      count: 500,
      recent: Array.from({ length: limit }, (_, i) => ({ id: `EI-${i}` })),
    }));
    const r = await composeHarnessOverview({ issuesLimit: 9999 }, call, read);
    expect(folds[0].limit).toBe(100); // ISSUES_FOLD_MAX — overview bounds the fold
    expect(r.issues!.recent.length).toBe(100);
    expect(r.issues!.count).toBe(500); // true total still reported
    expect(JSON.stringify(r).length).toBeLessThan(6000);
  });

  it('default reader: folds via the listIssues + countIssues store fns (true total)', async () => {
    vi.mocked(listIssues).mockResolvedValue([{ id: 'EI-1' }, { id: 'EI-2' }] as never);
    vi.mocked(countIssues).mockResolvedValue(42);
    const { call } = fakeCall({ 'harness:list': () => ({ harnesses: [] }) });
    const r = await composeHarnessOverview({ issuesLimit: 5 }, call); // no reader → default store path
    expect(vi.mocked(listIssues)).toHaveBeenCalledWith(expect.objectContaining({ state: 'open', limit: 5 }));
    expect(vi.mocked(countIssues)).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' }));
    expect(r.issues).toEqual({ count: 42, recent: [{ id: 'EI-1' }, { id: 'EI-2' }] });
  });
});
