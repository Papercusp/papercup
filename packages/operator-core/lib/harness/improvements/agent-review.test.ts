import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkItem } from '../../work-items';
import { REBIND_BLOCKING_SESSION_STATES } from '../../agent-tools/coordination/rebind-identity';
import { LEGACY_AGENT_REVIEW_SUBMITTER } from './agent-review-policy';
import {
  enterAgentReview,
  preflightAgentReviewGrade,
  reconcileAgentReviewGrade,
  resubmitAgentReview,
  type AgentReviewDeps,
  type AgentReviewLedgerGrade,
  type SubmitterLivenessVerdict,
} from './agent-review';

function issue(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WI-7',
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: 'Proposal needing peer review',
    summary: 'body',
    severity: 'minor',
    state: 'open',
    assignee: 'su-filer',
    assignedBy: null,
    takenAt: null,
    lastProgressAt: null,
    payload: {},
    parent: null,
    origin: 'local',
    foundDuring: null,
    createdBy: 'su-filer',
    goalId: null,
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
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  } as WorkItem;
}

function cloneIssue(value: WorkItem): WorkItem {
  return { ...value, payload: { ...(value.payload as Record<string, unknown> ?? {}) } };
}

function harness(initial: WorkItem = issue()) {
  const state: {
    issue: WorkItem;
    ledger: AgentReviewLedgerGrade | null;
    posts: Array<{ body: string; author: string }>;
    /** The submitter's liveness as the oracle would report it. `null` = NOT MEASURED. */
    submitterLiveness: SubmitterLivenessVerdict | null;
  } = {
    issue: cloneIssue(initial),
    ledger: null,
    posts: [],
    // Default to a live submitter: the conservative reading, and the one that preserves
    // pre-WI-41689 behaviour for every test that does not opt into the orphan path.
    submitterLiveness: { sessionState: 'live' },
  };

  const recordRoutedIdea = vi.fn(async () => undefined);
  const resolveLedgerIdeaId = vi.fn(async (id: string) => id);
  const releaseWorkItem = vi.fn(async (_id: string, opts: { expectedAssignee?: string } = {}) => {
    if (opts.expectedAssignee && state.issue.assignee && state.issue.assignee !== opts.expectedAssignee) return null;
    state.issue = { ...state.issue, assignee: null };
    return cloneIssue(state.issue);
  });
  const claimWorkItem = vi.fn(async (_id: string, assignee: string, opts: { fromHolder?: string } = {}) => {
    if (state.issue.assignee && state.issue.assignee !== assignee && state.issue.assignee !== opts.fromHolder) return null;
    state.issue = { ...state.issue, assignee };
    return cloneIssue(state.issue);
  });
  const commentWorkItem = vi.fn(async (_id: string, body: string, author = 'substrate') => {
    state.posts.push({ body, author });
    return { body } as never;
  });
  const deliverRevision = vi.fn(async () => ({ woken: 1 }));
  const resolveSubmitterLiveness = vi.fn(async () => state.submitterLiveness);

  const deps = {
    getWorkItem: vi.fn(async () => cloneIssue(state.issue)),
    getWorkItemDetail: vi.fn(async () => ({
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
    mergeWorkItemPayload: vi.fn(async (_id: string, patch: Record<string, unknown>, opts: { unset?: readonly string[] } = {}) => {
      const payload = { ...(state.issue.payload as Record<string, unknown> ?? {}), ...patch };
      for (const key of opts.unset ?? []) delete payload[key];
      state.issue = { ...state.issue, payload };
      return cloneIssue(state.issue);
    }),
    releaseWorkItem,
    claimWorkItem,
    commentWorkItem,
    recordRoutedIdea,
    resolveLedgerIdeaId,
    readLedgerGrade: vi.fn(async () => state.ledger),
    deliverRevision,
    resolveSubmitterLiveness,
  } as unknown as AgentReviewDeps;

  return {
    state,
    deps,
    recordRoutedIdea,
    resolveLedgerIdeaId,
    releaseWorkItem,
    claimWorkItem,
    commentWorkItem,
    deliverRevision,
    resolveSubmitterLiveness,
  };
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
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-filer',
    });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.state.issue.state).toBe('open');
  });

  it('preserves feature-family kind and uses the deterministic ledger fallback on collision', async () => {
    const h = harness(issue({ kind: 'feature', family: 'feature' }));
    h.resolveLedgerIdeaId.mockResolvedValue('agent-review:WI-7');

    const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);

    expect(result.state).toMatchObject({ ledgerIdeaId: 'agent-review:WI-7' });
    expect(h.state.issue.kind).toBe('feature');
    expect(h.recordRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({
      ideaId: 'agent-review:WI-7',
      routedRef: 'wi:WI-7',
    }));
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
  let pending: WorkItem;

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
      returnedToSubmitter: true,
      woken: 1,
    });
    expect(h.state.issue.state).toBe('open');
    expect(h.state.issue.assignee).toBe('su-filer');
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'revision-requested', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
    });
    expect(h.claimWorkItem).toHaveBeenCalledWith('WI-7', 'su-filer', {
      harness: 'papercusp',
      fromHolder: 'su-reviewer',
    });
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
    expect(h.commentWorkItem).toHaveBeenCalledTimes(1);
    expect(h.deliverRevision).toHaveBeenCalledTimes(1);
  });

  it('WI-41687: a submitter that can no longer take the claim drops the reviewer claim instead of throwing and stranding the row', async () => {
    const h = harness(pending);
    h.state.ledger = {
      ideaId: 'WI-7',
      workItemId: 'WI-7',
      grade: 2,
      feedback: 'Add deterministic retry coverage.',
      gradedBy: 'su-reviewer',
    };
    // The submitter's session has been REAPED — the common case for any report reviewed
    // more than one session-lifetime after it was filed. claimWorkItem returns null for a
    // non-existent owner exactly as it does here.
    h.claimWorkItem.mockImplementation(async () => null);

    // Before WI-41687 this REJECTED, after the grade/payload/comment had already committed.
    const outcome = await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);

    expect(outcome).toMatchObject({
      workItemId: 'WI-7',
      status: 'revision-requested',
      round: 1,
      changed: true,
      returnedToSubmitter: false,
    });

    // The review itself is still fully recorded — this is a weaker disposition, not a failure.
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'revision-requested', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
    });
    expect(h.commentWorkItem).toHaveBeenCalledTimes(1);

    // The transfer was attempted, and its failure left the row unassigned rather than
    // stranded under the reviewer.
    expect(h.claimWorkItem).toHaveBeenCalledWith('WI-7', 'su-filer', {
      harness: 'papercusp',
      fromHolder: 'su-reviewer',
    });
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-reviewer',
    });
    expect(h.state.issue.assignee).toBeNull();
  });

  it('releases legacy-sentinel revision work to normal implementation without assigning or waking the sentinel', async () => {
    const h = harness(issue({
      assignee: 'su-reviewer',
      payload: {
        agentReview: {
          status: 'pending',
          submittedBy: LEGACY_AGENT_REVIEW_SUBMITTER,
          ledgerIdeaId: 'WI-7',
          round: 1,
        },
      },
    }));
    h.state.ledger = {
      ideaId: 'WI-7',
      workItemId: 'WI-7',
      grade: 2,
      feedback: 'Rework the migration boundary.',
      gradedBy: 'su-reviewer',
    };

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toEqual({
      workItemId: 'WI-7',
      status: 'revision-requested',
      round: 1,
      changed: true,
    });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-reviewer',
    });
    expect(h.claimWorkItem).not.toHaveBeenCalled();
    expect(h.deliverRevision).not.toHaveBeenCalled();
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

  it('requires the real legacy reviser to hold the item, then rebinds submittedBy on resubmission', async () => {
    const h = harness(issue({
      assignee: 'su-reviser',
      payload: {
        agentReview: {
          status: 'revision-requested',
          submittedBy: LEGACY_AGENT_REVIEW_SUBMITTER,
          ledgerIdeaId: 'agent-review:WI-7',
          round: 1,
        },
      },
    }));

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-stranger' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'legacy-revision-not-claimant',
    });
    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-reviser' }, h.deps)).resolves.toEqual({
      resubmitted: true,
      state: {
        status: 'pending',
        submittedBy: 'su-reviser',
        ledgerIdeaId: 'agent-review:WI-7',
        round: 2,
      },
    });
    expect(h.state.issue.assignee).toBeNull();
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
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-reviewer',
    });

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toMatchObject({
      status: 'approved',
      changed: false,
    });
    expect(h.commentWorkItem).toHaveBeenCalledTimes(1);
  });
});

/**
 * WI-41689. A 'revision-requested' row can only leave that state through
 * `resubmitAgentReview`, and only its original submitter could call it — so once that
 * session was reaped (the COMMON case: review routinely outlives the filing session) the
 * row was excluded from the claim floor with nobody alive able to free it.
 */
describe('resubmitAgentReview adopts a row whose submitter is provably gone (WI-41689)', () => {
  function orphanRow(overrides: Partial<WorkItem> = {}): WorkItem {
    return issue({
      assignee: null,
      payload: {
        agentReview: { status: 'revision-requested', submittedBy: 'su-gone', ledgerIdeaId: 'WI-7', round: 1 },
      },
      ...overrides,
    });
  }

  it('refuses while the original submitter can still act', async () => {
    const h = harness(orphanRow());
    h.state.submitterLiveness = { sessionState: 'live' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'not-submitter',
    });
    // The row is untouched — a refusal must not half-apply.
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'revision-requested', submittedBy: 'su-gone', ledgerIdeaId: 'WI-7', round: 1 },
    });
    // NON-VACUITY: 'not-submitter' is also what the PRE-WI-41689 code returned here, so
    // asserting the reason alone would pass with the orphan branch deleted entirely. This
    // proves the refusal was REACHED THROUGH the liveness guard.
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: false });
  });

  /**
   * THE TRAP THIS SUITE EXISTS FOR. 'recorded' is NOT a dead session — it is synthesized
   * from a recorded-but-not-yet-RUNNING launch, i.e. a session about to start. Reading
   * "not live" as "gone" would let one agent seize a submitter identity out from under a
   * session that is still booting: rare, timing-dependent, and near-impossible to
   * attribute after the fact. The polarity is owned by REBIND_BLOCKING_SESSION_STATES.
   */
  it('refuses a submitter whose session is merely RECORDED (a launch, not a death)', async () => {
    const h = harness(orphanRow());
    h.state.submitterLiveness = { sessionState: 'recorded' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'not-submitter',
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: false });
  });

  it.each(REBIND_BLOCKING_SESSION_STATES)('refuses while the submitter is %s', async (sessionState) => {
    const h = harness(orphanRow());
    h.state.submitterLiveness = { sessionState };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'not-submitter',
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: false });
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'revision-requested', submittedBy: 'su-gone', ledgerIdeaId: 'WI-7', round: 1 },
    });
  });

  /**
   * FAIL CLOSED. `null` is the oracle's in-band unknown — "not measured", never "absent".
   * Collapsing it into gone would silently widen the rule to "resubmit whenever we cannot
   * see the submitter", which is a different policy wearing this one's clothes.
   */
  it('refuses — with a distinct, diagnosable reason — when liveness could not be measured', async () => {
    const h = harness(orphanRow());
    h.state.submitterLiveness = null;

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'not-submitter:liveness-unknown',
    });
  });

  it('lets a new agent adopt and resubmit an unheld row once the submitter has ended', async () => {
    const h = harness(orphanRow());
    h.state.submitterLiveness = { sessionState: 'ended' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toEqual({
      resubmitted: true,
      state: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2 },
    });
    // submittedBy is rebound to the adopter, so the NEXT round's revision reaches someone alive.
    expect(h.state.issue.payload).toEqual({
      agentReview: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2 },
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: false });
  });

  /**
   * REGRESSION: `expectedAssignee` is a CAS against the CURRENT holder. Passing the caller
   * while the gone submitter still holds the claim matches zero rows, and the function
   * throws "held by another agent" about a row whose only holder is a dead session —
   * re-stranding precisely the case this branch rescues.
   */
  it('releases against the GONE submitter when it died still holding the claim', async () => {
    const h = harness(orphanRow({ assignee: 'su-gone' }));
    h.state.submitterLiveness = { sessionState: 'ended' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: true,
    });
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-gone',
    });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: true });
  });

  it('refuses to adopt a row a third agent is holding, rather than trading the bug for a claim-steal', async () => {
    const h = harness(orphanRow({ assignee: 'su-other' }));
    h.state.submitterLiveness = { sessionState: 'ended' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'orphan-revision-held-by-other',
    });
    expect(h.releaseWorkItem).not.toHaveBeenCalled();
    expect(h.state.issue.assignee).toBe('su-other');
  });

  it('does not spend an oracle read on a row that is not revision-requested anyway', async () => {
    const h = harness(issue({
      assignee: null,
      payload: {
        agentReview: { status: 'pending', submittedBy: 'su-gone', ledgerIdeaId: 'WI-7', round: 1 },
      },
    }));

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'not-submitter',
    });
    expect(h.resolveSubmitterLiveness).not.toHaveBeenCalled();
  });
});
