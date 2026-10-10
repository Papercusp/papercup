import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkItem } from '../../work-items';
import { readAgentReviewState } from './agent-review-policy';
import { REBIND_BLOCKING_SESSION_STATES } from '../../agent-tools/coordination/rebind-identity';
import {
  acceptanceSourceRevision,
  createImplementationReadiness,
  createVerificationTask,
  deriveWorkItemIntakeStage,
  evaluateImplementationAcceptance,
  readImplementationReadiness,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  STRANDED_SWEEP_OWNER,
} from './agent-review-policy';
import {
  approvalAcceptance,
  claimAgentReview,
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
    /** WI-10006314: is the row authored by one of THIS workspace's own keys (the heal's identity check)? */
    ownNodeAuthored: boolean;
  } = {
    issue: cloneIssue(initial),
    ledger: null,
    posts: [],
    // Default to a live submitter: the conservative reading, and the one that preserves
    // pre-WI-41689 behaviour for every test that does not opt into the orphan path.
    submitterLiveness: { sessionState: 'live' },
    ownNodeAuthored: false,
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
  // WI-10006314: the real heal's WHERE clause IS the identity check — only an own-node
  // origin='remote' row moves to 'local'; a foreign remote row is left untouched.
  const healOwnNodeOrigin = vi.fn(async (_workspaceId: string, _id: string, _harnessSlug?: string | null) => {
    if (!state.ownNodeAuthored || state.issue.origin !== 'remote') return false;
    state.issue = { ...state.issue, origin: 'local' };
    return true;
  });

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
    resolveVerifiedSubmitterAlias: vi.fn(async () => null),
    healOwnNodeOrigin,
  } as unknown as AgentReviewDeps;

  return {
    state,
    deps,
    healOwnNodeOrigin,
    recordRoutedIdea,
    resolveLedgerIdeaId,
    releaseWorkItem,
    claimWorkItem,
    commentWorkItem,
    deliverRevision,
    resolveSubmitterLiveness,
  };
}

describe('approvalAcceptance — one verification stage, kind-specific checks (P-006 / D-019)', () => {
  const proposal = {
    problem: 'The floor admits unverified bugs.',
    evidence: ['observed on the current build'],
    outcome: 'Only verified bugs are accepted.',
    scope: 'The acceptance seal.',
    completionCheck: 'The seal refuses a bug without a receipt.',
  };
  const payloadWith = (extra: Record<string, unknown> = {}) => ({
    implementationReadiness: createImplementationReadiness({
      status: 'unknown',
      source: 'capture-policy',
      reason: 'awaiting-agent-review',
      evidence: { acceptance: proposal },
    }),
    ...extra,
  });
  const approve = (overrides: Partial<WorkItem>) =>
    approvalAcceptance(issue(overrides), { reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1, grade: 5 });
  const receipt = { kind: 'scripted-repro', ref: 'scripts/repro.sh', buildSha: 'abcdef1' };

  it('seals a bug only with the reproduction receipt recorded on it', () => {
    expect(approve({ kind: 'bug', payload: payloadWith() })).toBeUndefined();
    expect(approve({ kind: 'bug', payload: payloadWith({ intakeReproduction: { receipt: { ...receipt, buildSha: 'zz' } } }) })).toBeUndefined();
    const contract = approve({ kind: 'bug', payload: payloadWith({ intakeReproduction: { receipt } }) });
    expect(contract?.verification).toEqual({ check: 'reproduction', receipt });
  });

  it('seals a change through proposal review, with no receipt needed', () => {
    expect(approve({ kind: 'change', payload: payloadWith() })?.verification).toEqual({ check: 'proposal-review' });
  });

  it('keeps a favorable review out of the fixing lane when reproduction is missing, stale or unresolved', async () => {
    for (const status of ['missing', 'refuted', 'unresolved'] as const) {
      const h = harness(issue({ kind: 'bug', assignee: 'su-reviewer', payload: payloadWith({
        ...(status === 'missing' ? {} : { intakeReproduction: { receipt } }),
        agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'WI-7', round: 1 },
      }) }));
      h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 5, feedback: null, gradedBy: 'su-reviewer' };
      h.deps.verifyReproduction = async () => ({ status: status === 'missing' ? 'unresolved' : status,
        detail: 'target build reproduction unavailable', checkedAt: new Date().toISOString() });
      expect(await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps))
        .toMatchObject({ status: 'revision-requested', changed: true });
      expect(readImplementationReadiness(h.state.issue.payload)?.status).toBe('not-ready');
      expect(evaluateImplementationAcceptance(h.state.issue.payload, {
        kind: h.state.issue.kind, title: h.state.issue.title, summary: h.state.issue.summary,
      }).state).not.toBe('qualifying');
      expect(h.deliverRevision).toHaveBeenCalledWith(expect.objectContaining({ to: 'su-author' }));
    }
  });

  it('accepts the same favorable review after the current target failure is verified', async () => {
    const h = harness(issue({ kind: 'bug', assignee: 'su-reviewer', payload: payloadWith({
      intakeReproduction: { receipt },
      agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'WI-7', round: 1 },
    }) }));
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 5, feedback: null, gradedBy: 'su-reviewer' };
    h.deps.verifyReproduction = async () => ({ status: 'verified', detail: 'current target failed', checkedAt: new Date().toISOString() });
    expect(await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps))
      .toMatchObject({ status: 'approved', changed: true });
    expect(readImplementationReadiness(h.state.issue.payload)?.status).toBe('ready');
    expect(approvalAcceptance(h.state.issue, { reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1, grade: 5 }))
      .toMatchObject({ verification: { check: 'reproduction', receipt } });
  });
});

describe('P-030 review timing lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves enrollment time on retry and resets only when a new review round starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
    const h = harness();
    await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing).toEqual({
      round: 1, enteredAt: '2026-10-08T00:00:00.000Z',
    });
    vi.setSystemTime(new Date('2026-10-08T01:00:00Z'));
    await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing?.enteredAt).toBe('2026-10-08T00:00:00.000Z');
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 2, feedback: 'Provide evidence', gradedBy: 'su-reviewer' };
    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing?.decidedAt).toBe('2026-10-08T01:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-08T02:00:00Z'));
    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing?.decidedAt).toBe('2026-10-08T01:00:00.000Z');
    await resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing).toEqual({
      round: 2, enteredAt: '2026-10-08T02:00:00.000Z',
    });
  });

  it('keeps a legacy pending round undated instead of inventing its start on retry', async () => {
    const h = harness(issue({ payload: {
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 2 },
    } }));
    await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing).toBeUndefined();
  });

  it('writes an approval decision time once, without turning repeated reconciliation into new service', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
    const h = harness();
    await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 4, feedback: null, gradedBy: 'su-reviewer' };
    vi.setSystemTime(new Date('2026-10-08T01:00:00Z'));
    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    vi.setSystemTime(new Date('2026-10-08T02:00:00Z'));
    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    expect(readAgentReviewState(h.state.issue.payload)?.timing).toEqual({
      round: 1, enteredAt: '2026-10-08T00:00:00.000Z', decidedAt: '2026-10-08T01:00:00.000Z',
    });
  });
});

describe('enterAgentReview (abolish-human-review D-003)', () => {
  it('enrolls on the existing ledger without overwriting richer SU provenance', async () => {
    const h = harness(issue({ payload: { improvementKind: 'feature', needsHuman: true } }));

    const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer' }, h.deps);

    expect(result).toEqual({
      entered: true,
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1,
        timing: { round: 1, enteredAt: expect.any(String) } },
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
    expect(h.state.issue.payload).toMatchObject({
      improvementKind: 'feature',
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      implementationReadiness: {
        schemaVersion: 'implementation-readiness-v1',
        status: 'unknown',
        source: 'agent-review',
        reason: 'awaiting-agent-review',
        evidence: { review: { submittedBy: 'su-filer', round: 1 } },
      },
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

  // WI-10006314 — measured 2026-10-06 02:56Z: 3 of 601 own-node rows stranded at
  // origin='remote' were refused 'remote-owned' and only entered review on a re-run,
  // after the failure-stamp write had self-healed their origin as a side effect.
  it('enrolls an own-node row stranded at origin=remote on the FIRST attempt', async () => {
    const h = harness(issue({ origin: 'remote' }));
    h.state.ownNodeAuthored = true;
    const result = await enterAgentReview(
      { id: 'WI-7', submittedBy: 'su-filer', harnessSlug: 'papercusp', workspaceId: 'ws-test' },
      h.deps,
    );
    expect(result).toMatchObject({ entered: true });
    expect(h.healOwnNodeOrigin).toHaveBeenCalledWith('ws-test', 'WI-7', 'papercusp');
    expect(h.state.issue.origin).toBe('local');
    expect(h.recordRoutedIdea).toHaveBeenCalledTimes(1);
  });

  it('still refuses a FOREIGN remote row as remote-owned; the heal leaves it untouched', async () => {
    const h = harness(issue({ origin: 'remote' }));
    const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer', workspaceId: 'ws-test' }, h.deps);
    expect(result).toEqual({ entered: false, reason: 'remote-owned' });
    expect(h.healOwnNodeOrigin).toHaveBeenCalledTimes(1);
    expect(h.state.issue.origin).toBe('remote');
    expect(h.recordRoutedIdea).not.toHaveBeenCalled();
  });

  it('fails closed when the heal cannot run: the refusal stands and the error does not escape', async () => {
    const h = harness(issue({ origin: 'remote' }));
    h.state.ownNodeAuthored = true;
    h.healOwnNodeOrigin.mockRejectedValueOnce(new Error('pg unavailable'));
    const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer', workspaceId: 'ws-test' }, h.deps);
    expect(result).toEqual({ entered: false, reason: 'remote-owned' });
    expect(h.recordRoutedIdea).not.toHaveBeenCalled();
  });

  it('never calls the heal for a local row', async () => {
    const h = harness(issue({ origin: 'local' }));
    const result = await enterAgentReview({ id: 'WI-7', submittedBy: 'su-filer', workspaceId: 'ws-test' }, h.deps);
    expect(result.entered).toBe(true);
    expect(h.healOwnNodeOrigin).not.toHaveBeenCalled();
  });
});

describe('claimAgentReview directed pickup', () => {
  const pending = (id: string, submittedBy = 'su-filer') => issue({
    id,
    assignee: null,
    payload: {
      agentReview: { status: 'pending', submittedBy, ledgerIdeaId: id, round: 1 },
    },
  });

  it('claims the requested second pending item and never consumes the first', async () => {
    const first = pending('WI-7');
    const second = pending('WI-8');
    const h = harness(second);
    h.deps.getWorkItem = vi.fn(async (id: string) => cloneIssue(id === 'WI-7' ? first : second));

    await expect(claimAgentReview({
      id: 'WI-8',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    }, h.deps)).resolves.toMatchObject({
      claimed: true,
      workItem: { id: 'WI-8', assignee: 'su-reviewer' },
    });
    expect(h.deps.getWorkItem).toHaveBeenCalledWith('WI-8', 'papercusp');
    expect(h.claimWorkItem).toHaveBeenCalledTimes(1);
    expect(h.claimWorkItem).toHaveBeenCalledWith(
      'WI-8',
      'su-reviewer',
      expect.objectContaining({
        harness: 'papercusp',
        agentReviewAdmission: expect.objectContaining({
          itemId: 'WI-8',
          reviewer: 'su-reviewer',
          harnessSlug: 'papercusp',
          submittedBy: 'su-filer',
          ledgerIdeaId: 'WI-8',
          round: 1,
        }),
      }),
    );
  });

  it('claims an own-node pending row stranded at origin=remote instead of refusing it remote-owned (WI-10006314)', async () => {
    const h = harness({ ...pending('WI-7'), origin: 'remote' });
    h.state.ownNodeAuthored = true;
    await expect(claimAgentReview({
      id: 'WI-7',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    }, h.deps)).resolves.toMatchObject({ claimed: true, workItem: { id: 'WI-7', assignee: 'su-reviewer' } });
    expect(h.healOwnNodeOrigin).toHaveBeenCalledWith(expect.any(String), 'WI-7', 'papercusp');
    expect(h.state.issue.origin).toBe('local');
  });

  it('refuses a FOREIGN remote pending row as remote-owned without claiming it', async () => {
    const h = harness({ ...pending('WI-7'), origin: 'remote' });
    await expect(claimAgentReview({
      id: 'WI-7',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    }, h.deps)).resolves.toMatchObject({ claimed: false, reason: 'remote-owned' });
    expect(h.claimWorkItem).not.toHaveBeenCalled();
  });

  it('refuses the submitter and non-pending work before claiming', async () => {
    for (const [candidate, reason] of [
      [pending('WI-7', 'su-reviewer'), 'own-submission'],
      [issue({
        assignee: null,
        payload: {
          agentReview: { status: 'approved', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
        },
      }), 'agent-review-not-pending'],
    ] as const) {
      const h = harness(candidate);

      await expect(claimAgentReview({
        id: 'WI-7',
        reviewer: 'su-reviewer',
        harnessSlug: 'papercusp',
      }, h.deps)).resolves.toMatchObject({ claimed: false, reason });
      expect(h.claimWorkItem).not.toHaveBeenCalled();
    }
  });

  it('names the holder only when a fresh read confirms a real claim conflict', async () => {
    const h = harness(pending('WI-7'));
    h.claimWorkItem.mockImplementation(async () => {
      h.state.issue = { ...h.state.issue, assignee: 'su-other', assignedBy: 'fleet-leader' };
      return null;
    });

    await expect(claimAgentReview({
      id: 'WI-7',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    }, h.deps)).resolves.toMatchObject({
      claimed: false,
      reason: 'claim-conflict',
      claimConflict: {
        workItemId: 'WI-7',
        holder: 'su-other',
        source: 'work_items.assignee',
        assignedBy: 'fleet-leader',
      },
    });
  });

  it('does not label a failed claim as a conflict when the row is still unheld', async () => {
    const h = harness(pending('WI-7'));
    h.claimWorkItem.mockResolvedValue(null);

    const result = await claimAgentReview({
      id: 'WI-7',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    }, h.deps);
    expect(result).toMatchObject({
      claimed: false,
      reason: 'claim-not-claimable',
    });
    expect(result).not.toHaveProperty('claimConflict');
  });

  it('releases a claim when the returned row shows the review stopped being pending', async () => {
    const h = harness(pending('WI-7'));
    h.claimWorkItem.mockResolvedValue(issue({
      assignee: 'su-reviewer',
      payload: {
        agentReview: { status: 'approved', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      },
    }));

    await expect(claimAgentReview({
      id: 'WI-7',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    }, h.deps)).resolves.toEqual({
      claimed: false,
      workItem: null,
      reason: 'agent-review-not-pending',
    });
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-reviewer',
    });
  });

  describe('verifier conflicts (P-007 / D-021, D-023)', () => {
    const withPayload = (item: WorkItem, extra: Record<string, unknown>): WorkItem => ({
      ...item,
      payload: { ...(item.payload as Record<string, unknown>), ...extra },
    });
    const verification = (reporters: string[], implementers: string[]) => createVerificationTask({
      subject: 'WI-6',
      check: 'reproduction',
      reporters,
      implementers,
    });
    const claimAs = (h: ReturnType<typeof harness>, reviewer: string) =>
      claimAgentReview({ id: 'WI-7', reviewer, harnessSlug: 'papercusp' }, h.deps);

    it('refuses a reporter who did not submit the review, before claiming', async () => {
      // Every row here was submitted by su-filer, so own-submission cannot fire: only the
      // reporter rule can refuse su-reporter.
      const cases: Array<[string, WorkItem]> = [
        ['row filer column', { ...pending('WI-7'), createdBy: 'su-reporter' }],
        ['_ei filer (improvement-triage style)', withPayload(pending('WI-7'), { _ei: { created_by: 'su-reporter' } })],
        ['verification-block reporter', withPayload(pending('WI-7'), { verification: verification(['su-reporter'], []) })],
      ];
      for (const [label, candidate] of cases) {
        const h = harness(candidate);
        await expect(claimAs(h, 'su-reporter'), label).resolves.toEqual({
          claimed: false,
          workItem: null,
          reason: 'reporter-conflict',
        });
        expect(h.claimWorkItem, label).not.toHaveBeenCalled();
      }
    });

    it('refuses an implementer of the subject, before claiming', async () => {
      const cases: Array<[string, WorkItem]> = [
        ['terminal owner', { ...pending('WI-7'), terminalOwner: 'su-builder' }],
        ['verification-block implementer', withPayload(pending('WI-7'), { verification: verification([], ['su-builder']) })],
      ];
      for (const [label, candidate] of cases) {
        const h = harness(candidate);
        await expect(claimAs(h, 'su-builder'), label).resolves.toEqual({
          claimed: false,
          workItem: null,
          reason: 'implementer-conflict',
        });
        expect(h.claimWorkItem, label).not.toHaveBeenCalled();
      }
    });

    it('names the reporter role first when the reviewer both filed and implemented the subject', async () => {
      const h = harness({ ...pending('WI-7'), createdBy: 'su-both', terminalOwner: 'su-both' });
      await expect(claimAs(h, 'su-both')).resolves.toMatchObject({ claimed: false, reason: 'reporter-conflict' });
      expect(h.claimWorkItem).not.toHaveBeenCalled();
    });

    it('still serves an independent reviewer on a row with a distinct reporter and implementer', async () => {
      const h = harness(withPayload(
        { ...pending('WI-7'), createdBy: 'su-reporter', terminalOwner: 'su-builder' },
        { _ei: { created_by: 'improvement-triage' }, verification: verification(['su-reporter'], ['su-builder']) },
      ));
      await expect(claimAs(h, 'su-reviewer')).resolves.toMatchObject({
        claimed: true,
        workItem: { id: 'WI-7', assignee: 'su-reviewer' },
      });
      expect(h.claimWorkItem).toHaveBeenCalledTimes(1);
      expect(h.claimWorkItem).toHaveBeenCalledWith(
        'WI-7',
        'su-reviewer',
        expect.objectContaining({ agentReviewAdmission: expect.objectContaining({ reviewer: 'su-reviewer' }) }),
      );
    });

    it('reports a conflict found on the fresh read after a failed claim instead of naming a holder', async () => {
      const h = harness(pending('WI-7'));
      h.claimWorkItem.mockImplementation(async () => {
        h.state.issue = { ...h.state.issue, assignee: 'su-other', terminalOwner: 'su-reviewer' };
        return null;
      });
      const result = await claimAs(h, 'su-reviewer');
      expect(result).toEqual({ claimed: false, workItem: null, reason: 'implementer-conflict' });
      expect(result).not.toHaveProperty('claimConflict');
    });

    it('releases a claim whose returned row shows the reviewer became a party to the subject', async () => {
      const h = harness(pending('WI-7'));
      h.claimWorkItem.mockImplementation(async (_id: string, assignee: string) => {
        h.state.issue = withPayload({ ...h.state.issue, assignee }, { verification: verification(['su-reviewer'], []) });
        return cloneIssue(h.state.issue);
      });
      await expect(claimAs(h, 'su-reviewer')).resolves.toEqual({
        claimed: false,
        workItem: null,
        reason: 'reporter-conflict',
      });
      expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
        harness: 'papercusp',
        expectedAssignee: 'su-reviewer',
      });
      expect(h.state.issue.assignee).toBeNull();
    });
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
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'revision-requested', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      implementationReadiness: {
        status: 'not-ready',
        reason: 'agent-review-revision-requested',
        evidence: { review: { submittedBy: 'su-filer', reviewer: 'su-reviewer', round: 1, grade: 2 } },
      },
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
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'revision-requested', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      implementationReadiness: {
        status: 'not-ready',
        reason: 'agent-review-revision-requested',
      },
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
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 2,
        timing: { round: 2, enteredAt: expect.any(String) } },
    });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 2 },
      implementationReadiness: {
        status: 'unknown',
        reason: 'agent-review-resubmitted',
        evidence: { review: { submittedBy: 'su-filer', round: 2 } },
      },
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
        timing: { round: 2, enteredAt: expect.any(String) },
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
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'approved', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 },
      implementationReadiness: {
        status: 'ready',
        reason: 'agent-review-approved',
        evidence: { review: { submittedBy: 'su-filer', reviewer: 'su-reviewer', round: 1, grade: 4 } },
      },
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

  // observation-candidate-acceptance-promotion P-005 (R-4 / R-20 / R-21).
  const PROPOSAL = {
    problem: 'Retry duplicates the ledger row.',
    evidence: ['retry.test.ts shows two rows after one retry'],
    outcome: 'A retried write converges on one row.',
    scope: 'The retry seam only.',
    completionCheck: 'retry.test.ts passes with one row.',
  };
  const withProposal = (proposal: Record<string, unknown>) =>
    issue({
      ...pending,
      payload: {
        ...(pending.payload as Record<string, unknown>),
        implementationReadiness: createImplementationReadiness({
          status: 'unknown',
          source: 'agent-review',
          reason: 'awaiting-agent-review',
          updatedAt: '2026-08-20T00:00:00.000Z',
          evidence: { acceptance: proposal },
        }),
      },
    });
  const stageOf = (item: WorkItem, overrides: Partial<WorkItem> = {}) =>
    deriveWorkItemIntakeStage({
      kind: item.kind,
      status: item.state,
      payload: item.payload,
      title: overrides.title ?? item.title,
      summary: item.summary,
    });

  it('approval seals a complete producer proposal into a revision-bound contract, and an edit invalidates it', async () => {
    const h = harness(withProposal(PROPOSAL));
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 5, feedback: null, gradedBy: 'su-reviewer' };

    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    const acceptance = (h.state.issue.payload as { implementationReadiness: { evidence: { acceptance: unknown } } })
      .implementationReadiness.evidence.acceptance;
    expect(acceptance).toMatchObject({
      ...PROPOSAL,
      authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-filer', round: 1 },
      reason: 'agent-review-approved (grade 5/5)',
      sourceRevision: acceptanceSourceRevision({ kind: 'change', title: pending.title, summary: pending.summary }),
    });
    expect(stageOf(h.state.issue)).toMatchObject({ primaryStage: 'accepted', acceptance: 'qualifying' });
    expect(stageOf(h.state.issue, { title: 'Proposal needing peer review — widened' })).toMatchObject({
      primaryStage: 'candidate',
      acceptance: 'stale-revision',
      reReviewRequested: true,
    });

    // Retry convergence: the second reconcile reuses the standing contract instead
    // of re-sealing it with a fresh acceptedAt.
    const before = structuredClone(h.state.issue.payload);
    const writes = vi.mocked(h.deps.mergeWorkItemPayload).mock.calls.length;
    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toMatchObject({
      changed: false,
    });
    expect(vi.mocked(h.deps.mergeWorkItemPayload).mock.calls.length).toBe(writes + 1);
    expect(h.state.issue.payload).toEqual(before);
  });

  it('approval never defaults an incomplete proposal into acceptance', async () => {
    const { completionCheck: _missing, ...incomplete } = PROPOSAL;
    const h = harness(withProposal(incomplete));
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 5, feedback: null, gradedBy: 'su-reviewer' };

    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    expect(h.state.issue.payload).toMatchObject({
      implementationReadiness: { status: 'ready', evidence: { acceptance: incomplete } },
    });
    expect(
      (h.state.issue.payload as { implementationReadiness: { evidence: { acceptance: object } } }).implementationReadiness
        .evidence.acceptance,
    ).not.toHaveProperty('authority');
    expect(stageOf(h.state.issue)).toMatchObject({
      primaryStage: 'candidate',
      acceptance: 'incomplete',
      reason: 'ready-without-executable-acceptance',
    });
  });

  it('a revision request carries the producer proposal forward unsealed', async () => {
    const h = harness(withProposal(PROPOSAL));
    h.state.ledger = {
      ideaId: 'WI-7',
      workItemId: 'WI-7',
      grade: 2,
      feedback: 'Name the retry seam precisely.',
      gradedBy: 'su-reviewer',
    };

    await reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps);
    expect(h.state.issue.payload).toMatchObject({
      implementationReadiness: { status: 'not-ready', evidence: { acceptance: PROPOSAL } },
    });
    expect(stageOf(h.state.issue)).toMatchObject({ primaryStage: 'candidate', qualifyingAcceptance: false });
  });

  // EI-24720168531118378 / EI-21887295701926471. The standing ledger grade can belong to someone
  // who never held the row (an owner-sovereign grade on a pre-existing su-ideate filing that
  // `enterAgentReview` enrolled with `preserveExisting`). The reviewer CLAIM is released against
  // the CURRENT HOLDER; keying the CAS on `ledger.gradedBy` ('owner') lost it, threw after the
  // approval payload had committed, and stranded the row held by the reviewer.
  it('an owner-graded ledger row still releases the reviewer claim (CAS targets the holder, not ledger.gradedBy)', async () => {
    const h = harness(pending);
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 4, feedback: null, gradedBy: 'owner' };

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toMatchObject({
      status: 'approved',
      changed: true,
    });
    expect(h.state.issue.assignee).toBeNull();
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-reviewer',
    });
    // Attribution still names the ledger grader — only the CAS moved.
    expect(h.state.posts[0]?.body).toContain('approved by owner');
  });

  it('an owner-graded low grade transfers the claim FROM the holder, not from ledger.gradedBy', async () => {
    const h = harness(pending);
    h.state.ledger = { ideaId: 'WI-7', workItemId: 'WI-7', grade: 2, feedback: 'Premise is false.', gradedBy: 'owner' };

    await expect(reconcileAgentReviewGrade({ ideaId: 'WI-7', gradedBy: 'su-reviewer' }, h.deps)).resolves.toMatchObject({
      status: 'revision-requested',
      returnedToSubmitter: true,
    });
    expect(h.claimWorkItem).toHaveBeenCalledWith('WI-7', 'su-filer', {
      harness: 'papercusp',
      fromHolder: 'su-reviewer',
    });
    expect(h.state.issue.assignee).toBe('su-filer');
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

  function legacySweepRow(opts: {
    createdBy?: string;
    eiCreatedBy?: string;
    markerOwner?: string;
    submittedBy?: string;
    assignee?: string | null;
  } = {}): WorkItem {
    const createdBy = opts.createdBy ?? 'su-gone';
    return issue({
      assignee: opts.assignee ?? null,
      createdBy,
      payload: {
        _ei: { created_by: opts.eiCreatedBy ?? createdBy },
        strandedToolFailureSweep: {
          owner: opts.markerOwner ?? STRANDED_SWEEP_OWNER,
          at: '2026-10-01T10:00:00.000Z',
          outcome: 'review',
        },
        agentReview: {
          status: 'revision-requested',
          submittedBy: opts.submittedBy ?? STRANDED_SWEEP_OWNER,
          ledgerIdeaId: 'WI-7',
          round: 1,
        },
      },
    });
  }

  it.each([null, 'system:judge/su-gone', 'su-other'])('adopts a proven signed-spawn alias held by %s without accepting a bug', async (assignee) => {
    const h = harness({ ...orphanRow({ assignee }), kind: 'bug', payload: {
      agentReview: { status: 'revision-requested', submittedBy: 'system:judge/su-gone', ledgerIdeaId: 'WI-7', round: 1 },
    } });
    h.deps.resolveVerifiedSubmitterAlias = vi.fn(async () => 'su-gone');
    h.state.submitterLiveness = { sessionState: 'ended' };
    const result = await resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps);
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: assignee === 'system:judge/su-gone' });
    if (assignee === 'su-other') {
      expect(result).toMatchObject({ resubmitted: false, reason: 'orphan-revision-held-by-other' });
      expect(h.deps.mergeWorkItemPayload).not.toHaveBeenCalled();
      expect(h.releaseWorkItem).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ resubmitted: true, state: { submittedBy: 'su-newcomer', status: 'pending' } });
      expect(h.state.issue.payload).toMatchObject({ implementationReadiness: { status: 'unknown' } });
      expect(h.state.issue.payload).not.toHaveProperty('intakeReproduction');
      if (assignee) expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', { harness: 'papercusp', expectedAssignee: assignee });
    }
  });

  it.each([null, { sessionState: 'parked' } as const])('preserves the signed submitter when liveness is %j', async (verdict) => {
    const h = harness({ ...orphanRow(), payload: {
      agentReview: { status: 'revision-requested', submittedBy: 'system:judge/su-gone', ledgerIdeaId: 'WI-7', round: 1 },
    } });
    h.deps.resolveVerifiedSubmitterAlias = vi.fn(async () => 'su-gone');
    h.state.submitterLiveness = verdict;
    expect(await resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps))
      .toMatchObject({ resubmitted: false, reason: verdict ? 'not-submitter' : 'not-submitter:liveness-unknown' });
    expect(h.deps.mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(h.releaseWorkItem).not.toHaveBeenCalled();
  });

  it('refuses namespaced system authority without signed alias evidence even if a liveness stub says ended', async () => {
    const h = harness({ ...orphanRow(), payload: {
      agentReview: { status: 'revision-requested', submittedBy: 'system:judge/su-gone', ledgerIdeaId: 'WI-7', round: 1 },
    } });
    h.state.submitterLiveness = { sessionState: 'ended' };
    expect(await resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps))
      .toMatchObject({ resubmitted: false, reason: 'not-submitter:authority-unknown' });
    expect(h.resolveSubmitterLiveness).not.toHaveBeenCalled();
    expect(h.deps.mergeWorkItemPayload).not.toHaveBeenCalled();
  });

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

  /**
   * 'ended' and 'suspect' are the two states DELIBERATELY absent from
   * REBIND_BLOCKING_SESSION_STATES — a warm-dead predecessor derives the first, an
   * abruptly-killed one the second. Both must adopt, or the abrupt-kill case (the one
   * most likely to strand a row mid-review) silently keeps the old behaviour.
   */
  it.each(['ended', 'suspect'] as const)(
    'lets a new agent adopt and resubmit an unheld row once the submitter is %s',
    async (sessionState) => {
      const h = harness(orphanRow());
      h.state.submitterLiveness = { sessionState };

      await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toEqual({
        resubmitted: true,
        state: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2,
          timing: { round: 2, enteredAt: expect.any(String) } },
      });
      expect(h.state.issue.payload).toMatchObject({
        agentReview: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2 },
        implementationReadiness: {
          status: 'unknown',
          reason: 'agent-review-resubmitted',
          evidence: { review: { submittedBy: 'su-newcomer', round: 2 } },
        },
      });
    },
  );

  it('rebinds submittedBy to the adopter so the next round reaches someone alive', async () => {
    const h = harness(orphanRow());
    h.state.submitterLiveness = { sessionState: 'ended' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toEqual({
      resubmitted: true,
      state: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2,
        timing: { round: 2, enteredAt: expect.any(String) } },
    });
    // submittedBy is rebound to the adopter, so the NEXT round's revision reaches someone alive.
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2 },
      implementationReadiness: {
        status: 'unknown',
        reason: 'agent-review-resubmitted',
        evidence: { review: { submittedBy: 'su-newcomer', round: 2 } },
      },
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

  it('repairs the exact legacy sweep row for its verified original reporter', async () => {
    const h = harness(legacySweepRow({ createdBy: 'su-original' }));

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-original' }, h.deps)).resolves.toEqual({
      resubmitted: true,
      state: { status: 'pending', submittedBy: 'su-original', ledgerIdeaId: 'WI-7', round: 2,
        timing: { round: 2, enteredAt: expect.any(String) } },
    });
    expect(h.resolveSubmitterLiveness).not.toHaveBeenCalled();
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'pending', submittedBy: 'su-original', ledgerIdeaId: 'WI-7', round: 2 },
    });
  });

  function triageRow(overrides: Record<string, unknown> = {}, submittedBy = 'improvement-triage'): WorkItem {
    return issue({ assignee: null, createdBy: 'su-original', payload: {
      _ei: { created_by: 'su-original' },
      ideaLifecycle: { state: 'triaged', triageDecision: 'gate', triagedAt: '2026-10-01T10:00:00.000Z' },
      agentReview: { status: 'revision-requested', submittedBy, ledgerIdeaId: 'WI-7', round: 1 },
      ...overrides,
    } });
  }

  it.each(['improvement-triage', 'Queen'])('repairs %s enrollment for its proven original reporter', async (submittedBy) => {
    const h = harness(triageRow({}, submittedBy));
    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-original' }, h.deps)).resolves.toMatchObject({
      resubmitted: true, state: { status: 'pending', submittedBy: 'su-original', round: 2 },
    });
    expect(h.resolveSubmitterLiveness).not.toHaveBeenCalled();
  });

  it.each([
    ['live', { sessionState: 'live' } as const, 'not-submitter'],
    ['unknown', null, 'not-submitter:liveness-unknown'],
    ['ended', { sessionState: 'ended' } as const, undefined],
  ])('measures the original triage reporter, keeping %s adoption honest', async (_label, verdict, reason) => {
    const h = harness(triageRow());
    h.state.submitterLiveness = verdict;
    const result = await resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps);
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-original', { claimsHeld: false });
    expect(result).toMatchObject(reason ? { resubmitted: false, reason } : { resubmitted: true });
    if (reason) expect(readAgentReviewState(h.state.issue.payload)?.submittedBy).toBe('improvement-triage');
  });

  it.each(['su-original', 'su-newcomer'])('never repairs triage provenance under a third-party implementation holder for %s', async (submittedBy) => {
    const h = harness({ ...triageRow(), assignee: 'su-other' });
    h.state.submitterLiveness = { sessionState: 'ended' };
    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy }, h.deps)).resolves.toMatchObject({
      resubmitted: false, reason: 'orphan-revision-held-by-other',
    });
    expect(h.deps.mergeWorkItemPayload).not.toHaveBeenCalled();
    expect(h.releaseWorkItem).not.toHaveBeenCalled();
    expect(h.state.issue.assignee).toBe('su-other');
    expect(readAgentReviewState(h.state.issue.payload)?.status).toBe('revision-requested');
  });

  it('recovers a place enrolled for a persistently unknown deployment screen', async () => {
    const h = harness(triageRow({
      ideaLifecycle: { state: 'triaged', triageDecision: 'place', triagedAt: '2026-10-01T10:00:00.000Z' },
      deploymentStalenessScreen: { state: 'unknown', screened: true, divert: false, at: '2026-10-01T10:00:00.000Z' },
    }));
    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-original' }, h.deps)).resolves.toMatchObject({
      resubmitted: true, state: { submittedBy: 'su-original' },
    });
  });

  it.each([
    ['missing triage marker', { ideaLifecycle: undefined }],
    ['undated triage', { ideaLifecycle: { state: 'triaged', triageDecision: 'gate' } }],
    ['unreviewed place', { ideaLifecycle: { state: 'triaged', triageDecision: 'place', triagedAt: '2026-10-01T10:00:00.000Z' } }],
    ['creator mismatch', { _ei: { created_by: 'su-other' } }],
    ['reporter mismatch', { reporter: { kind: 'agent', id: 'su-other', basis: 'agent-session', at: '2026-10-01T10:00:00.000Z' } }],
    ['malformed reporter', { reporter: { kind: 'invalid' } }],
    ['non-agent reporter', { reporter: { kind: 'watchdog', id: 'su-original', basis: 'explicit', at: '2026-10-01T10:00:00.000Z' } }],
  ])('does not infer triage authority from %s', async (_label, overrides) => {
    const h = harness(triageRow(overrides));
    h.state.submitterLiveness = null;
    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false, reason: 'not-submitter:liveness-unknown',
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('improvement-triage', { claimsHeld: false });
  });

  it.each([
    ['live', { sessionState: 'live' } as const, 'not-submitter'],
    ['unknown', null, 'not-submitter:liveness-unknown'],
  ])('keeps legacy sweep adoption fail-closed when its reporter is %s', async (_label, verdict, reason) => {
    const h = harness(legacySweepRow({ createdBy: 'su-original' }));
    h.state.submitterLiveness = verdict;

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason,
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-original', { claimsHeld: false });
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'revision-requested', submittedBy: STRANDED_SWEEP_OWNER, round: 1 },
    });
  });

  it('adopts a legacy sweep row only after the original reporter is gone and releases by CAS holder', async () => {
    const h = harness(legacySweepRow({ createdBy: 'su-gone', assignee: 'su-gone' }));
    h.state.submitterLiveness = { sessionState: 'ended' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toEqual({
      resubmitted: true,
      state: { status: 'pending', submittedBy: 'su-newcomer', ledgerIdeaId: 'WI-7', round: 2,
        timing: { round: 2, enteredAt: expect.any(String) } },
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith('su-gone', { claimsHeld: true });
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-7', {
      harness: 'papercusp',
      expectedAssignee: 'su-gone',
    });
  });

  it('does not rebind a verified legacy sweep row under a third-party claim', async () => {
    const h = harness(legacySweepRow({ createdBy: 'su-gone', assignee: 'su-other' }));
    h.state.submitterLiveness = { sessionState: 'ended' };

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'orphan-revision-held-by-other',
    });
    expect(h.state.issue.payload).toMatchObject({
      agentReview: { status: 'revision-requested', submittedBy: STRANDED_SWEEP_OWNER, round: 1 },
    });
    expect(h.releaseWorkItem).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong sweep marker', { markerOwner: 'system:other' }, STRANDED_SWEEP_OWNER],
    ['creator mismatch', { eiCreatedBy: 'su-not-the-creator' }, STRANDED_SWEEP_OWNER],
    ['other system identity', { submittedBy: 'system:other' }, 'system:other'],
  ])('does not grant synthetic adoption for %s', async (_label, overrides, expectedSubmitter) => {
    const h = harness(legacySweepRow(overrides));
    h.state.submitterLiveness = null;

    await expect(resubmitAgentReview({ id: 'WI-7', submittedBy: 'su-newcomer' }, h.deps)).resolves.toMatchObject({
      resubmitted: false,
      reason: 'not-submitter:liveness-unknown',
    });
    expect(h.resolveSubmitterLiveness).toHaveBeenCalledWith(expectedSubmitter, { claimsHeld: false });
  });
});
