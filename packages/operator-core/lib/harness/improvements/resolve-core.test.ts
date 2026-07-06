import { describe, it, expect, vi } from 'vitest';
import { resolveImprovement, routeExhaustedImprovementToHuman, type ResolveDeps } from './resolve-core';
import type { EngineerIssue, IssueState } from '../../issues-engineer';

function issue(p: Partial<EngineerIssue> & { id: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    title: 'a bug',
    body: '',
    severity: 'major',
    source: 'su',
    state: 'open',
    assignee: 'improvement-runner',
    assignedBy: null,
    assignedAt: '2026-06-05T01:00:00Z',
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    ...p,
  };
}

interface Recorded {
  comments: { id: string; body: string; by?: string }[];
  states: { id: string; state: IssueState }[];
  released: string[];
  payloads: { id: string; patch: Record<string, unknown> }[];
  /** Dispatch-ledger closes (consume-edges P-010 / B-04). */
  closes: { id: string; outcome: string; by?: string }[];
}

function deps(current: EngineerIssue | null): ResolveDeps & { rec: Recorded } {
  const rec: Recorded = { comments: [], states: [], released: [], payloads: [], closes: [] };
  return {
    rec,
    getIssue: async () => current,
    setIssueState: async (id, state) => {
      rec.states.push({ id, state });
      return current ? { ...current, state } : null;
    },
    commentIssue: async (id, body, by) => {
      rec.comments.push({ id, body, by });
      return null;
    },
    releaseIssue: async (id) => {
      rec.released.push(id);
      return current;
    },
    mergeIssuePayload: async (id, patch) => {
      rec.payloads.push({ id, patch });
      return current;
    },
    closeDispatches: async (id, opts) => {
      rec.closes.push({ id, outcome: opts.outcome, by: opts.by });
      return 1;
    },
  };
}

describe('resolveImprovement — fixed (the verify-and-mark-done back-edge, close-loop D-001)', () => {
  it('REFUSES fixed without testsRun (verification evidence is mandatory)', async () => {
    const d = deps(issue({ id: 'EI-1' }));
    const r = await resolveImprovement({ id: 'EI-1', outcome: 'fixed', summary: 'changed the thing properly' }, d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/testsRun/);
    expect(d.rec.states).toHaveLength(0);
  });

  it('fixed + evidence → comments the evidence and marks resolved (the bug LEAVES the queue)', async () => {
    const d = deps(issue({ id: 'EI-1' }));
    const r = await resolveImprovement(
      { id: 'EI-1', outcome: 'fixed', summary: 'guarded the null icon lookup', testsRun: 'npm run test:affected → 214 green', commit: 'abc1234' },
      d,
    );
    expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
    expect(d.rec.states).toEqual([{ id: 'EI-1', state: 'resolved' }]);
    expect(d.rec.comments[0].body).toMatch(/214 green/);
    expect(d.rec.comments[0].body).toMatch(/abc1234/);
  });

  it('is idempotent — resolving an already-resolved item is a no-op success', async () => {
    const d = deps(issue({ id: 'EI-1', state: 'resolved' }));
    const r = await resolveImprovement({ id: 'EI-1', outcome: 'fixed', summary: 'already done earlier today' }, d);
    expect(r.ok).toBe(true);
    expect(d.rec.states).toHaveLength(0);
    expect(d.rec.comments).toHaveLength(0);
  });

  it('unknown id → error', async () => {
    const r = await resolveImprovement({ id: 'EI-404', outcome: 'fixed', summary: 'whatever happened' }, deps(null));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });
});

describe('resolveImprovement — non-terminal states actually resolve (EI-6953/6954/6938 regression)', () => {
  // engineer_issues is a VIEW over work_items (status AS state); issue-family items
  // are minted with the work-item state `todo` (non-terminal, normalized to `open`
  // by other readers — but resolve-core reads raw). The old `!== 'open'` idempotency
  // guard treated todo/wip/in_progress/blocked as already-terminal and NO-OP'd, so
  // ~450–650 items stayed stuck and re-dispatched forever. The guard must test
  // TERMINAL membership (resolved|closed) so every non-terminal state resolves.
  const NON_TERMINAL_STATES: string[] = ['todo', 'wip', 'in_progress', 'blocked', 'needs-human', 'open'];
  for (const state of NON_TERMINAL_STATES) {
    it(`fixed + evidence on a '${state}' (non-terminal) item ACTUALLY marks it resolved (not a silent no-op)`, async () => {
      const d = deps(issue({ id: 'EI-drift', state: state as IssueState }));
      const r = await resolveImprovement(
        { id: 'EI-drift', outcome: 'fixed', summary: 'real fix landed', testsRun: 'vitest green' },
        d,
      );
      expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
      expect(d.rec.states).toEqual([{ id: 'EI-drift', state: 'resolved' }]);
      expect(d.rec.comments[0].body).toMatch(/vitest green/);
    });
  }

  it("a 'closed' (terminal) item stays an idempotent no-op, like 'resolved'", async () => {
    const d = deps(issue({ id: 'EI-closed', state: 'closed' }));
    const r = await resolveImprovement({ id: 'EI-closed', outcome: 'fixed', summary: 'x', testsRun: 't' }, d);
    expect(r).toMatchObject({ ok: true, state: 'closed' });
    expect(d.rec.states).toHaveLength(0);
    expect(d.rec.comments).toHaveLength(0);
  });
});

describe('resolveImprovement — could-not-fix (retry path)', () => {
  it('releases the claim and stays open (a later run retries)', async () => {
    const d = deps(issue({ id: 'EI-2', payload: { implementAttempts: 1 } }));
    const r = await resolveImprovement({ id: 'EI-2', outcome: 'could-not-fix', summary: 'repro is flaky, ran out of leads' }, d);
    expect(r).toMatchObject({ ok: true, outcome: 'could-not-fix', state: 'open', routedToHuman: false });
    expect(d.rec.released).toEqual(['EI-2']);
    expect(d.rec.states).toHaveLength(0);
    expect(d.rec.payloads).toHaveLength(0); // attempts not exhausted → no needsHuman
  });

  it('exhausted attempts → ALSO routes to a human (no infinite auto ping-pong)', async () => {
    const d = deps(issue({ id: 'EI-2', payload: { implementAttempts: 3 } }));
    const r = await resolveImprovement({ id: 'EI-2', outcome: 'could-not-fix', summary: 'third strike, still failing' }, d);
    expect(r.routedToHuman).toBe(true);
    expect(d.rec.payloads).toEqual([{ id: 'EI-2', patch: { needsHuman: true } }]);
    expect(d.rec.comments[0].body).toMatch(/Retries exhausted/);
  });

  it('honors a custom maxAttempts', async () => {
    const d = deps(issue({ id: 'EI-2', payload: { implementAttempts: 1 } }));
    const r = await resolveImprovement(
      { id: 'EI-2', outcome: 'could-not-fix', summary: 'one strike policy here', maxAttempts: 1 },
      d,
    );
    expect(r.routedToHuman).toBe(true);
  });
});

describe('resolveImprovement — needs-human (the protected-surface stop)', () => {
  it('sets needsHuman, releases the claim, stays open', async () => {
    const d = deps(issue({ id: 'EI-3' }));
    const r = await resolveImprovement(
      { id: 'EI-3', outcome: 'needs-human', summary: 'the correct fix is a schema migration' },
      d,
    );
    expect(r).toMatchObject({ ok: true, outcome: 'needs-human', state: 'open', routedToHuman: true });
    expect(d.rec.payloads).toEqual([{ id: 'EI-3', patch: { needsHuman: true } }]);
    expect(d.rec.released).toEqual(['EI-3']);
    expect(d.rec.states).toHaveLength(0);
  });
});

describe('routeExhaustedImprovementToHuman — exhausted with no resolve recorded (consume-edges P-012)', () => {
  it('SILENT WORKER DEATH: open + exhausted + no needsHuman → comment, flag, release the stale claim', async () => {
    // The worker(s) died without ever calling improvements:resolve — the item
    // carries only the dispatch bookkeeping (attempts + a stale claim).
    const d = deps(issue({ id: 'EI-9', payload: { implementAttempts: 3 } }));
    const r = await routeExhaustedImprovementToHuman({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: true });
    expect(d.rec.payloads).toEqual([{ id: 'EI-9', patch: { needsHuman: true } }]);
    expect(d.rec.released).toEqual(['EI-9']);
    expect(d.rec.comments[0].body).toMatch(/NO resolve ever recorded/);
    expect(d.rec.comments[0].body).toMatch(/3\/3/);
    expect(d.rec.states).toHaveLength(0); // stays open — a human decides, the auto lane just lets go
  });

  it('idempotent: an item already routed to a human is a no-op', async () => {
    const d = deps(issue({ id: 'EI-9', payload: { implementAttempts: 3, needsHuman: true } }));
    const r = await routeExhaustedImprovementToHuman({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: false, reason: expect.stringMatching(/already/) });
    expect(d.rec.comments).toHaveLength(0);
    expect(d.rec.payloads).toHaveLength(0);
    expect(d.rec.released).toHaveLength(0);
  });

  it('a resolved item is a no-op (the worker DID resolve — nothing was silent)', async () => {
    const d = deps(issue({ id: 'EI-9', state: 'resolved', payload: { implementAttempts: 3 } }));
    const r = await routeExhaustedImprovementToHuman({ id: 'EI-9' }, d);
    expect(r).toMatchObject({ ok: true, flipped: false, reason: 'not open' });
    expect(d.rec.comments).toHaveLength(0);
  });

  it('a missing item reports not-found without throwing', async () => {
    const d = deps(null);
    const r = await routeExhaustedImprovementToHuman({ id: 'EI-404' }, d);
    expect(r).toMatchObject({ ok: false, flipped: false });
    expect(r.reason).toMatch(/not found/);
  });

  it('uses the provided attempts/maxAttempts in the explanatory comment', async () => {
    const d = deps(issue({ id: 'EI-9', payload: { implementAttempts: 5 } }));
    const r = await routeExhaustedImprovementToHuman({ id: 'EI-9', attempts: 5, maxAttempts: 5, by: 'test-routine' }, d);
    expect(r.flipped).toBe(true);
    expect(d.rec.comments[0].body).toMatch(/5\/5/);
    expect(d.rec.comments[0].by).toBe('test-routine');
  });
});

describe('resolveImprovement — dispatch-ledger close (consume-edges P-010 / B-04)', () => {
  it('every successful outcome drives the open ledger rows terminal with that outcome', async () => {
    for (const outcome of ['could-not-fix', 'needs-human'] as const) {
      const d = deps(issue({ id: 'EI-7' }));
      await resolveImprovement({ id: 'EI-7', outcome, summary: 's', by: 'worker-1' }, d);
      expect(d.rec.closes).toEqual([{ id: 'EI-7', outcome, by: 'worker-1' }]);
    }
    const d = deps(issue({ id: 'EI-7' }));
    await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's', testsRun: 'vitest green', by: 'worker-1' }, d);
    expect(d.rec.closes).toEqual([{ id: 'EI-7', outcome: 'fixed', by: 'worker-1' }]);
  });

  it('the idempotent re-resolve of an already-resolved item STILL closes ledger rows (no strays for the orphan collector)', async () => {
    const d = deps(issue({ id: 'EI-7', state: 'resolved' }));
    const r = await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's', testsRun: 't' }, d);
    expect(r.ok).toBe(true);
    expect(d.rec.closes).toEqual([{ id: 'EI-7', outcome: 'fixed', by: 'improvement-runner' }]);
    expect(d.rec.states).toHaveLength(0); // still a no-op on the issue itself
  });

  it('a REFUSED resolve (fixed without testsRun) closes nothing — the dispatch is still live', async () => {
    const d = deps(issue({ id: 'EI-7' }));
    await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's' }, d);
    expect(d.rec.closes).toHaveLength(0);
  });

  it('a ledger-close failure never fails the resolve (best-effort back edge)', async () => {
    const d = deps(issue({ id: 'EI-7' }));
    d.closeDispatches = async () => {
      throw new Error('PG hiccup');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await resolveImprovement({ id: 'EI-7', outcome: 'fixed', summary: 's', testsRun: 't' }, d);
    expect(r).toMatchObject({ ok: true, outcome: 'fixed', state: 'resolved' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dispatch-ledger close failed/), 'PG hiccup');
    warn.mockRestore();
  });
});
