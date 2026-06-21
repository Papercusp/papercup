import { describe, it, expect } from 'vitest';
import { composeHarnessOverview } from './overview';
import type { InnerCall } from '../_compound-dispatch';

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

const ISSUES = {
  'issues:list': () => ({ ok: true, count: 2, issues: [{ id: 'EI-1' }, { id: 'EI-2' }] }),
};

describe('composeHarnessOverview (P-006 compound)', () => {
  it('with harness: folds status + escalations + open-issues snapshot (no harness:list)', async () => {
    const { call, calls } = fakeCall({
      'harness:status': () => ({ ok: true, slug: 'sheets', active: true }),
      'harness:escalation': () => ({ ok: true, escalations: [] }),
      ...ISSUES,
    });
    const r = await composeHarnessOverview({ harness: 'sheets' }, call);
    expect(r.ok).toBe(true);
    expect(r.harness).toBe('sheets');
    expect((r.status as { active: boolean }).active).toBe(true);
    expect(r.escalations).toEqual({ ok: true, escalations: [] });
    expect(r.issues).toEqual({ count: 2, recent: [{ id: 'EI-1' }, { id: 'EI-2' }] });
    expect(r.harnesses).toBeUndefined();
    expect(calls.map((c) => c.name)).toEqual(['harness:status', 'harness:escalation', 'issues:list']);
    expect(calls.find((c) => c.name === 'harness:status')!.args).toMatchObject({ slug: 'sheets' });
    expect(calls.find((c) => c.name === 'issues:list')!.args).toMatchObject({ state: 'open', limit: 25 });
  });

  it('without harness: folds the harness index + open issues (no status/escalation)', async () => {
    const { call, calls } = fakeCall({
      'harness:list': () => ({ ok: true, harnesses: [{ slug: 'a' }, { slug: 'b' }] }),
      ...ISSUES,
    });
    const r = await composeHarnessOverview({}, call);
    expect(r.harnesses).toEqual({ ok: true, harnesses: [{ slug: 'a' }, { slug: 'b' }] });
    expect(r.status).toBeUndefined();
    expect(r.escalations).toBeUndefined();
    expect(r.issues!.count).toBe(2);
    expect(calls.map((c) => c.name)).toEqual(['harness:list', 'issues:list']);
    expect(calls.find((c) => c.name === 'harness:list')!.args).toMatchObject({ detail: 'summary', limit: 50 });
  });

  it('forwards phase, issueState, issueScope, and the limits', async () => {
    const { call, calls } = fakeCall({
      'harness:status': () => ({}),
      'harness:escalation': () => ({}),
      'issues:list': () => ({ count: 0, issues: [] }),
    });
    await composeHarnessOverview(
      { harness: 'h', phase: 'testing', issueState: 'resolved', issueScope: 'auth', issuesLimit: 5 },
      call,
    );
    expect(calls.find((c) => c.name === 'harness:escalation')!.args).toMatchObject({ slug: 'h', phase: 'testing' });
    expect(calls.find((c) => c.name === 'issues:list')!.args).toMatchObject({ state: 'resolved', scope: 'auth', limit: 5 });
  });

  it('best-effort: a failing sub-call degrades to null, overview still ok', async () => {
    const { call } = fakeCall({
      'harness:status': () => {
        throw new Error('denied');
      },
      'harness:escalation': () => ({ ok: true }),
      'issues:list': () => {
        throw new Error('boom');
      },
    });
    const r = await composeHarnessOverview({ harness: 'h' }, call);
    expect(r.ok).toBe(true);
    expect(r.status).toBeNull();
    expect(r.escalations).toEqual({ ok: true });
    expect(r.issues).toBeNull();
  });

  it('D-008 COMPACT: caps the issues fold + the payload stays small under huge input', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `EI-${i}`, title: 'x'.repeat(200) }));
    const { call } = fakeCall({
      'harness:list': () => ({ harnesses: [] }),
      'issues:list': () => ({ count: 500, issues: many }),
    });
    const r = await composeHarnessOverview({ issuesLimit: 10 }, call);
    expect(r.issues!.recent.length).toBe(10);
    expect(r.issues!.count).toBe(500); // true total still reported
    expect(JSON.stringify(r).length).toBeLessThan(6000);
  });
});
