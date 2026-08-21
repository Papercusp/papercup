import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineerIssue } from '../../issues-engineer';
import {
  enterAgentReview,
  preflightAgentReviewGrade,
  reconcileAgentReviewGrade,
  resubmitAgentReview,
  type AgentReviewDeps,
  type AgentReviewLedgerGrade,
} from './agent-review';

function issue(overrides: Partial<EngineerIssue> = {}): EngineerIssue {
  return {
    id: 'WI-7',
    kind: 'change',
    scope: 'harness:papercusp',
    title: 'Proposal needing peer review',
    body: 'body',
    severity: 'minor',
    source: 'agent',
    state: 'open',
    assignee: 'su-filer',
    assignedBy: null,
    assignedAt: null,
    lastProgressAt: null,
    payload: {},
    parent: null,
    origin: 'local',
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-filer',
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    closedAt: null,
    goalId: null,
    ...overrides,
  } as EngineerIssue;
}

function cloneIssue(value: EngineerIssue): EngineerIssue {
  return { ...value, payload: { ...(value.payload as Record<string, unknown> ?? {}) } };
}

function harness(initial: EngineerIssue = issue()) {
  const state: {
    issue: EngineerIssue;
    ledger: AgentReviewLedgerGrade | null;
    posts: Array<{ body: string; author: string }>;
  } = {
    issue: cloneIssue(initial),
    ledger: null,
    posts: [],
  };

  const recordRoutedIdea = vi.fn(async () => undefined);
  const releaseIssue = vi.fn(async (_id: string, opts: { expectedAssignee?: string } = {}) => {
    if (opts.expectedAssignee && state.issue.assignee && state.issue.assignee !== opts.expectedAssignee) return null;
    state.issue = { ...state.issue, assignee: null };
    return cloneIssue(state.issue);
  });
  const claimIssue = vi.fn(async (_id: string, assignee: string, opts: { fromHolder?: string } = {}) => {
    if (state.issue.assignee && state.issue.assignee !== assignee && state.issue.assignee !== opts.fromHolder) return null;
    state.issue = { ...state.issue, assignee };
    return cloneIssue(state.issue);
  });
  const commentIssue = vi.fn(async (_id: string, body: string, author = 'substrate') => {
    state.posts.push({ body, author });
    return { body } as never;
  });
  const deliverRevision = vi.fn(async () => ({ woken: 1 }));

  const deps = {
    getIssue: vi.fn(async () => cloneIssue(state.issue)),
    getIssueDetail: vi.fn(async () => ({
      ...cloneIssue(state.issue),
      topics: [],
      posts: state.posts.map((post, index) => ({
        post_id: `post-${index}`,
        thread_id: 'thread-WI-7',
        author_id: post.author,
        body: post.body,
        created_ts: '2026-08-20T00:00:00.000Z',
      })),
      links: [],
    } as never)),
    mergeIssuePayload: vi.fn(async (_id: string, patch: Record<string, unknown>, opts: { unset?: readonly string[] } = {}) => {
      const payload = { ...(state.issue.payload as Record<string, unknown> ?? {}), ...patch };
      for (const key of opts.unset ?? []) delete payload[key];
      state.issue = { ...state.issue, payload };
      return cloneIssue(state.issue);
    }),
    releaseIssue,
    claimIssue,
    commentIssue,
    recordRoutedIdea,
    readLedgerGrade: vi.fn(async () => state.ledger),
    deliverRevision,
  } as unknown as AgentReviewDeps;

  return { state, deps, recordRoutedIdea, releaseIssue, claimIssue, commentIssue, deliverRevision };
}

describe('enterAgentReview (abolish-human-review D-003)', () => {
  it('enrolls on the existing ledger without overwriting richer SU provenance', async () => {
    const h = harness(issue({ payload: { improvementKind: 'feature', needsHuman: true } }));

    const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);

    expect(result).toEqual({
      entered: true,
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
    });
    expect(h.recordRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({
      ideaId: 'WI-7',
      routedRef: 'wi:WI-7',
      rail: 'improvement',
      lens: 'agent-review',
      origin: 'agent-review',
      createdBy: 'su-filer',
      preserveExisting: true,
    }));
    expect(h.state.issue.payload).toEqual({
      improvementKind: 'feature',
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
    });
    expect(h.releaseIssue).toHaveBeenCalledWith('WI-7', { expectedAssignee: 'su-filer' });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.state.issue.state).toBe('open');
  });

  it('does not enroll remote or strict owner-capability rows', async () => {
    for (const candidate of [
      issue({ origin: 'remote' }),
      issue({ payload: { humanCapability: 'credential' } }),
    ]) {
      const h = harness(candidate);
      const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);
      expect(result.entered).toBe(false);
      expect(h.recordRoutedIdea).not.toHaveBeenCalled();
    }
  });
});

describe('agent-review grading lifecycle', () => {
  let pending: EngineerIssue;

  beforeEach(() => {
    pending = issue({
      assignee: 'su-reviewer',
      payload: {
        agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      },
    });
  });

  it('refuses a 1–3 grade without actionable feedback before the ledger write seam', async () => {
    const h = harness(pending);
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: null, feedback: null, gradedBy: null };

    await expect(preflightAgentReviewGrade({ ideaId: 'WI-7', grade: 3 }, h.deps)).resolves.toMatchObject({
      applicable: true,
      refusal: 'agent-review-feedback-required',
    });
    await expect(preflightAgentReviewGrade({ ideaId: 'WI-7', grade: 3, feedback: '  ' }, h.deps)).resolves.toMatchObject({
      refusal: 'agent-review-feedback-required',
    });
    const accepted = await preflightAgentReviewGrade(
      { ideaId: 'WI-7', grade: 3, feedback: 'Make the retry idempotent.' },
      h.deps,
    );
    expect(accepted).toMatchObject({ applicable: true });
    expect(accepted).not.toHaveProperty('refusal');
  });

  it('returns a 1–3 grade to the filer, wakes them, and never parks it as human/blocked', async () => {
    const h = harness(pending);
    h.state.ledger = {
      ideaId: 'WI-7',
      workItemId: 'WI-7',
      grade: 2,
      feedback: 'Add deterministic retry coverage.',
      gradedBy: 'su-reviewer',
    };

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toEqual({
      workItemId: 'WI-7',
      status: 'revision-requested',
      round: 1,
      changed: true,
      woken: 1,
    });
    expect(h.state.issue.state).toBe('open');
    expect(h.state.issue.assignee).toBe('su-filer');
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'revision-requested', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
    });
    expect(h.claimIssue).toHaveBeenCalledWith('WI-7', 'su-filer', { fromHolder: 'su-reviewer' });
    expect(h.deliverRevision).toHaveBeenCalledWith(expect.objectContaining({
      to: 'su-filer',
      workItemId: 'WI-7',
      round: 1,
      grade: 2,
    }));

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toMatchObject({
      status: 'revision-requested',
      changed: false,
    });
    expect(h.commentIssue).toHaveBeenCalledTimes(1);
    expect(h.deliverRevision).toHaveBeenCalledTimes(1);
  });

  it('resubmission increments the round and releases revision work for another reviewer', async () => {
    const h = harness(issue({
      assignee: 'su-filer',
      payload: {
        agentReview: { status: 'revision-requested', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      },
    }));

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps)).resolves.toEqual({
      resubmitted: true,
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 2 },
    });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 2 },
    });
  });

  it('a 4–5 grade re-admits the still-open item and retry converges without duplicate history', async () => {
    const h = harness(pending);
    h.state.ledger = {
      ideaId: 'WI-7',
      workItemId: 'WI-7',
      grade: 4,
      feedback: null,
      gradedBy: 'su-reviewer',
    };

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toEqual({
      workItemId: 'WI-7',
      status: 'approved',
      round: 1,
      changed: true,
    });
    expect(h.state.issue.state).toBe('open');
    expect(h.state.issue.assignee).toBeNull();
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'approved', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
    });
    expect(h.releaseIssue).toHaveBeenCalledWith('WI-7', { expectedAssignee: 'su-reviewer' });

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toMatchObject({
      status: 'approved',
      changed: false,
    });
    expect(h.commentIssue).toHaveBeenCalledTimes(1);
  });
});
