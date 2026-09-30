/**
 * EI-24720168531118378: `claimNextAgentReview` must never hand a reviewer a pending round whose
 * ledger row ALREADY carries a standing grade. `enterAgentReview` enrolls with `preserveExisting`,
 * so a pre-existing su-ideate row the owner had already graded keeps that sovereign grade while the
 * payload starts at 'pending'; handing it out made the reviewer spend a review on a foregone
 * conclusion and (before the holder-CAS fix) strand the claim. The pickup converges it instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkItem } from '../../work-items';

const h = vi.hoisted(() => ({ rows: [] as Array<{ feature_id: string }> }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  // A tagged-template fake: the pickup query (and every nested SQL fragment builder) resolves to
  // the candidate rows. The rows are what is under test here, not the SQL text. Partial mock so
  // the package's other exports (other modules import them at load) stay real.
  const sql: any = (..._args: unknown[]) => Promise.resolve(h.rows);
  sql.unsafe = sql;
  sql.json = (v: unknown) => v;
  sql.array = (v: unknown) => v;
  return { ...(await importOriginal<Record<string, unknown>>()), getOrgPg: () => ({ sql }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));

import {
  claimNextAgentReview,
  type AgentReviewDeps,
  type AgentReviewLedgerGrade,
} from './agent-review';

function item(id: string): WorkItem {
  return {
    id,
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: `Proposal ${id}`,
    summary: 'body',
    severity: 'minor',
    state: 'open',
    assignee: null,
    payload: {
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: id, round: 1 },
    },
    origin: 'local',
  } as unknown as WorkItem;
}

function build(ledger: Record<string, AgentReviewLedgerGrade | null>) {
  const items = new Map<string, WorkItem>([['WI-A', item('WI-A')], ['WI-B', item('WI-B')]]);
  const claimWorkItem = vi.fn(async (id: string, assignee: string) => {
    const current = items.get(id)!;
    const claimed = { ...current, assignee } as WorkItem;
    items.set(id, claimed);
    return claimed;
  });
  const mergeWorkItemPayload = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const current = items.get(id)!;
    const next = { ...current, payload: { ...(current.payload as object), ...patch } } as WorkItem;
    items.set(id, next);
    return next;
  });
  const releaseWorkItem = vi.fn(async (id: string) => items.get(id) ?? null);
  const commentWorkItem = vi.fn(async () => ({}) as never);
  const deps = {
    getWorkItem: vi.fn(async (id: string) => items.get(id) ?? null),
    getWorkItemDetail: vi.fn(async (id: string) => ({ ...items.get(id), posts: [], topics: [], links: [] }) as never),
    mergeWorkItemPayload,
    releaseWorkItem,
    claimWorkItem,
    commentWorkItem,
    readLedgerGrade: vi.fn(async (ideaId: string) => ledger[ideaId] ?? null),
    deliverRevision: vi.fn(async () => ({ woken: 0 })),
  } as unknown as AgentReviewDeps;
  return { items, deps, claimWorkItem, mergeWorkItemPayload, releaseWorkItem };
}

describe('claimNextAgentReview skips and converges rows the ledger already settled', () => {
  beforeEach(() => {
    h.rows = [{ feature_id: 'WI-A' }, { feature_id: 'WI-B' }];
  });

  it('does not hand out an owner-graded pending row; it converges it and claims the next pending one', async () => {
    const t = build({
      'WI-A': { ideaId: 'WI-A', workItemId: 'WI-A', grade: 4, feedback: null, gradedBy: 'owner' },
    });

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-B');
    // WI-A was never claimed by the reviewer…
    expect(t.claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-B']);
    // …and its payload converged to the standing (owner) grade instead of staying pending forever.
    expect((t.items.get('WI-A')!.payload as any).agentReview.status).toBe('approved');
  });

  it('skips (never hands out) a settled row that cannot converge, without throwing', async () => {
    // A low standing grade with no feedback makes reconcile throw 'agent-review-feedback-required'.
    const t = build({
      'WI-A': { ideaId: 'WI-A', workItemId: 'WI-A', grade: 2, feedback: null, gradedBy: 'owner' },
    });

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-B');
    expect(t.claimWorkItem.mock.calls.map((c) => c[0])).toEqual(['WI-B']);
    expect((t.items.get('WI-A')!.payload as any).agentReview.status).toBe('pending');
  });

  it('still claims an ordinary pending row whose ledger row carries no standing grade', async () => {
    const t = build({ 'WI-A': { ideaId: 'WI-A', workItemId: 'WI-A', grade: null, feedback: null, gradedBy: null } });

    const claimed = await claimNextAgentReview({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' }, t.deps);

    expect(claimed?.id).toBe('WI-A');
  });
});
