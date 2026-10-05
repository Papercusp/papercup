/**
 * P-005 (review-routing-through-relevance-router-2026-09-26): the BAR-amendment
 * review policy never offers a reviewer from the implementer's spawn or rebind
 * lineage. The screen below models the lineage relation over a small graph; the
 * real relation (and its equality with the apply guard's pairwise check) is
 * pinned against Postgres in acceptance-author-identity.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { selectionPolicy } from '@papercusp/ranked-selection';
import type { RouteResult } from './relevance-router';
import {
  ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
  buildAmendmentReviewBrief,
  filterAmendmentReviewRoute,
  launchFreshAmendmentReviewer,
  openAcceptanceBarAmendmentReview,
  routeAcceptanceBarAmendmentReview,
  selectFreshReviewerModelForAccountSteer,
  type AmendmentReviewerScreen,
} from './acceptance-bar-amendment-review';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY } from './selection-policies';

// Directed lineage edges: rebind predecessor -> implementer -> spawned child;
// a common parent launched both the implementer and a sibling.
const EDGES: Array<[string, string]> = [
  ['su-rebind-predecessor', 'su-implementer'],
  ['su-implementer', 'su-spawned-child'],
  ['su-common-parent', 'su-implementer'],
  ['su-common-parent', 'su-sibling'],
];

function reach(from: string, forward: boolean): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const node = queue.shift()!;
    for (const [a, b] of EDGES) {
      const next = forward ? (a === node ? b : null) : b === node ? a : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Descendants + ancestors: the same relation areAcceptanceLineageRelated answers. */
function lineageScreen(implementer: string): AmendmentReviewerScreen & { calls: string[] } {
  const related = new Set([...reach(implementer, true), ...reach(implementer, false)]);
  const calls: string[] = [];
  const screen = (async (ownerId: string) => {
    calls.push(ownerId);
    return related.has(ownerId)
      ? { eligible: false, reason: 'related_to_plan_implementer' as const }
      : { eligible: true, reason: 'eligible' as const };
  }) as AmendmentReviewerScreen & { calls: string[] };
  screen.calls = calls;
  return screen;
}

const candidate = (ownerId: string) => ({ ownerId, score: 0.9 });

function route(qualified: string[], snapshot: string[]): RouteResult {
  return {
    verdict: 'routed',
    qualified: qualified.map(candidate),
    snapshot: { candidates: snapshot.map(candidate) },
  } as unknown as RouteResult;
}

const LINEAGE = ['su-spawned-child', 'su-rebind-predecessor', 'su-implementer'];

describe('filterAmendmentReviewRoute', () => {
  it('drops the implementer, its spawned child and its rebind predecessor from both the qualified menu and the snapshot', async () => {
    const screen = lineageScreen('su-implementer');
    const screenedOut: Array<{ ownerId: string; reason: string }> = [];
    const filtered = await filterAmendmentReviewRoute(
      route(
        ['su-spawned-child', 'su-outsider', 'su-rebind-predecessor', 'su-sibling'],
        ['su-spawned-child', 'su-outsider', 'su-rebind-predecessor', 'su-sibling', 'su-implementer'],
      ),
      screen,
      (entry) => screenedOut.push(entry),
    );
    expect(filtered.qualified.map((c) => c.ownerId)).toEqual(['su-outsider', 'su-sibling']);
    expect(filtered.snapshot.candidates.map((c) => c.ownerId)).toEqual(['su-outsider', 'su-sibling']);
    for (const member of LINEAGE) {
      expect(filtered.qualified.map((c) => c.ownerId)).not.toContain(member);
      expect(filtered.snapshot.candidates.map((c) => c.ownerId)).not.toContain(member);
    }
    expect(screenedOut.map((e) => e.ownerId).sort()).toEqual([...LINEAGE].sort());
    expect(screenedOut.every((e) => e.reason === 'related_to_plan_implementer')).toBe(true);
    // Each distinct owner is screened exactly once.
    expect([...screen.calls].sort()).toEqual(
      ['su-implementer', 'su-outsider', 'su-rebind-predecessor', 'su-sibling', 'su-spawned-child'].sort(),
    );
  });

  it('fails closed: a screen fault rejects instead of passing an unscreened candidate', async () => {
    const screen: AmendmentReviewerScreen = async (ownerId) => {
      if (ownerId === 'su-outsider') throw new Error('implementer history unreadable');
      return { eligible: true, reason: 'eligible' };
    };
    await expect(filterAmendmentReviewRoute(route(['su-sibling', 'su-outsider'], []), screen)).rejects.toThrow(
      'implementer history unreadable',
    );
  });
});

describe('routeAcceptanceBarAmendmentReview', () => {
  const identity = { ownerId: 'su-implementer', workspaceId: 'ws-1' } as never;

  it('routes under the amendment policy, fresh (no archive), with the screen applied before selection', async () => {
    const screen = lineageScreen('su-implementer');
    const resolveScreen = vi.fn(async () => ({ check: screen }));
    let selectedFrom: RouteResult | null = null;
    const feedback = vi.fn(async (_req: unknown, _identity: unknown, opts: { filterRoute: (r: RouteResult) => Promise<RouteResult> }) => {
      selectedFrom = await opts.filterRoute(route(['su-spawned-child', 'su-rebind-predecessor', 'su-outsider'], ['su-sibling']));
      return { verdict: 'routed', conversation_id: 'conv-1', responder: { ownerId: selectedFrom.qualified[0]!.ownerId } };
    });
    const result = await routeAcceptanceBarAmendmentReview(
      { rubricRef: 'plan:acceptance-x', brief: 'review this diff', identity, workspaceId: 'ws-1', harness: 'papercusp' },
      { resolveScreen, feedback: feedback as never },
    );
    expect(resolveScreen).toHaveBeenCalledWith({ rubricId: 'acceptance-x', applierId: 'su-implementer' });
    const request = feedback.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({
      workspaceId: 'ws-1',
      requesterId: 'su-implementer',
      question: 'review this diff',
      originTaskRef: 'acceptance-x',
      subjectRef: 'acceptance-x',
      excludeOwners: ['su-implementer'],
      archiveFloor: 2,
      policy: ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY,
      harnessSlug: 'papercusp',
    });
    expect(selectedFrom!.qualified.map((c) => c.ownerId)).toEqual(['su-outsider']);
    expect(result).toEqual({
      state: 'routed',
      conversationId: 'conv-1',
      responderId: 'su-outsider',
      screenedOut: [
        { ownerId: 'su-spawned-child', reason: 'related_to_plan_implementer' },
        { ownerId: 'su-rebind-predecessor', reason: 'related_to_plan_implementer' },
      ],
    });
  });

  it('reports no eligible reviewer when the router selects nobody, and refuses on a router error', async () => {
    const resolveScreen = async () => ({ check: lineageScreen('su-implementer') });
    const none = vi.fn(async () => ({ verdict: 'no_available_responder', conversation_id: 'conv-2', reason: 'all screened out' }));
    await expect(
      routeAcceptanceBarAmendmentReview(
        { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1' },
        { resolveScreen, feedback: none as never },
      ),
    ).resolves.toEqual({
      state: 'no-eligible-reviewer',
      conversationId: 'conv-2',
      reason: 'no_available_responder (all screened out)',
      screenedOut: [],
    });
    const failing = vi.fn(async () => ({ error: 'invalid_args' }));
    await expect(
      routeAcceptanceBarAmendmentReview(
        { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1' },
        { resolveScreen, feedback: failing as never },
      ),
    ).rejects.toThrow('acceptance_bar_amendment_review_refused: invalid_args');
  });

  it('sends a validated reviewer model to the saved routed consult', async () => {
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' } as const;
    const feedback = vi.fn(async () => ({ verdict: 'routed', conversation_id: 'conv-model', responder: { ownerId: 'su-outsider' } }));
    const assertAllowed = vi.fn(async () => {});
    await routeAcceptanceBarAmendmentReview(
      { rubricRef: 'acceptance-x', brief: 'review', identity, workspaceId: 'ws-1', reviewerModel },
      { resolveScreen: async () => ({ check: lineageScreen('su-implementer') }),
        feedback: feedback as never, assertAllowed },
    );
    expect(assertAllowed).toHaveBeenCalledWith('ws-1', reviewerModel);
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ reviewerModel }), identity, expect.any(Object));
  });

  it('refuses before routing when the independence population cannot be resolved', async () => {
    const feedback = vi.fn();
    await expect(
      routeAcceptanceBarAmendmentReview(
        { rubricRef: 'acceptance-x', brief: 'b', identity, workspaceId: 'ws-1' },
        {
          resolveScreen: async () => {
            throw new Error('acceptance_bar_approver_check_subject_unreadable');
          },
          feedback: feedback as never,
        },
      ),
    ).rejects.toThrow('acceptance_bar_approver_check_subject_unreadable');
    expect(feedback).not.toHaveBeenCalled();
  });

  it('registers the amendment policy with one reviewer per attempt', () => {
    expect(selectionPolicy(ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY)).toEqual({ min: 1, max: 1 });
  });
});

describe('openAcceptanceBarAmendmentReview (P-006)', () => {
  const approval = { schemaVersion: 1, kind: 'acceptance-bar-approval', rubricRef: 'acceptance-demo', bars: [{ barKey: 'R-1' }] };
  const baseInput = {
    rubricRef: 'acceptance-demo',
    previewPostRef: 'thread-post:42',
    preview: {
      approvalRequired: true,
      approval,
      changes: [{ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['falsifier'] }],
    },
    reason: 'Tighten the falsifier.',
    patch: { criterion: { key: 'r-1', field: 'driftMarkers', mode: 'append', text: 'Also fails when X.' } },
    identity: { ownerId: 'su-implementer', workspaceId: 'ws' },
    workspaceId: 'ws',
  } as unknown as Parameters<typeof openAcceptanceBarAmendmentReview>[0];

  it('routes nothing when the preview needs no approval', async () => {
    const verifyPreviewPost = vi.fn();
    const route = vi.fn();
    const result = await openAcceptanceBarAmendmentReview(
      { ...baseInput, preview: { ...baseInput.preview, approvalRequired: false } },
      { verifyPreviewPost, route },
    );
    expect(result.state).toBe('not-required');
    expect(verifyPreviewPost).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it('refuses a preview post the apply resolver rejects, before spending a routed reviewer', async () => {
    const route = vi.fn();
    const verifyPreviewPost = vi.fn().mockRejectedValue(new Error('acceptance_bar_approval_stale_or_mismatched: R-1 hash mismatch'));
    await expect(openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost, route })).rejects.toThrow(
      /acceptance_bar_amendment_review_preview_invalid: thread-post:42 .*stale_or_mismatched/,
    );
    expect(verifyPreviewPost).toHaveBeenCalledWith({ workspaceId: 'ws', previewPostRef: 'thread-post:42', approval });
    expect(route).not.toHaveBeenCalled();
  });

  it('refuses a preview reference that is not thread-post:<id>', async () => {
    await expect(
      openAcceptanceBarAmendmentReview({ ...baseInput, previewPostRef: 'WI-12' }, { verifyPreviewPost: vi.fn(), route: vi.fn() }),
    ).rejects.toThrow(/reviewPreviewPost must be thread-post:<id>/);
  });

  it('opens the routed review for the preview post and returns its reference', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'routed', conversationId: 'conv-1', responderId: 'su-outsider', screenedOut: [] });
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route });

    expect(result).toMatchObject({ state: 'routed', conversationId: 'conv-1', previewPostRef: 'thread-post:42' });
    expect(result.next).toContain("consult:reply:conv-1");
    const routed = route.mock.calls[0]![0];
    expect(routed).toMatchObject({ rubricRef: 'acceptance-demo', workspaceId: 'ws', identity: baseInput.identity });
    expect(routed.brief).toBe(buildAmendmentReviewBrief({ ...baseInput }));
  });

  it('carries no routed reference when no eligible reviewer exists', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: null, reason: 'no_qualified_responder', screenedOut: [] });
    const launchFresh = vi.fn().mockResolvedValue({ state: 'not-launched', reason: 'launcher screened out' });
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh });
    expect(result).toMatchObject({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:42' });
    expect(result.next).not.toContain('consult:reply');
    expect(result.next).toContain('launcher screened out');
  });

  // WI-10003299: an empty menu used to end the review ("re-request later"), so a
  // plan whose whole live fleet built it could never get a BAR change approved.
  it('launches a fresh reviewer when the router staffs nobody, and says where it will answer', async () => {
    const route = vi.fn().mockResolvedValue({
      state: 'no-eligible-reviewer',
      conversationId: 'conv-9',
      reason: 'no_available_responder',
      screenedOut: [{ ownerId: 'su-peer', reason: 'related_to_plan_implementer' }],
    });
    const launchFresh = vi.fn().mockResolvedValue({
      state: 'launched',
      launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      taskId: 'task-1',
      label: 'bar-amendment-review:abc',
      idempotencyKey: 'acceptance-bar-amendment-review:abc',
      deduped: false,
      answerOn: { workItemId: 'WI-7', harness: 'papercusp' },
    });
    const launchCtx = { ownerId: 'su-implementer', workspaceId: 'ws' };
    const result = await openAcceptanceBarAmendmentReview(
      { ...baseInput, launchCtx },
      { verifyPreviewPost: vi.fn(), route, launchFresh },
    );
    expect(launchFresh).toHaveBeenCalledTimes(1);
    expect(launchFresh.mock.calls[0]![0]).toMatchObject({
      rubricRef: 'acceptance-demo',
      previewPostRef: 'thread-post:42',
      applierId: 'su-implementer',
      workspaceId: 'ws',
      patch: baseInput.patch,
      launchCtx,
    });
    expect(result).toMatchObject({
      state: 'no-eligible-reviewer',
      previewPostRef: 'thread-post:42',
      freshReviewer: { state: 'launched', taskId: 'task-1' },
      screenedOut: [{ ownerId: 'su-peer', reason: 'related_to_plan_implementer' }],
    });
    expect(result.next).toContain('work_items:comment on WI-7');
    expect(result.next).toContain("approvalRef:'thread-post:<that post id>'");
    expect(result.next).not.toMatch(/re-request later/i);
  });

  it('does not launch a fresh reviewer when the router staffed one', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'routed', conversationId: 'conv-1', responderId: 'su-outsider', screenedOut: [] });
    const launchFresh = vi.fn();
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh });
    expect(result.state).toBe('routed');
    expect(launchFresh).not.toHaveBeenCalled();
    expect('freshReviewer' in result).toBe(false);
  });

  it('reports a failed fresh launch instead of throwing away the routing result', async () => {
    const route = vi.fn().mockResolvedValue({ state: 'no-eligible-reviewer', conversationId: 'conv-3', reason: 'x', screenedOut: [] });
    const launchFresh = vi.fn().mockRejectedValue(new Error('rubric unreadable'));
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route, launchFresh });
    expect(result).toMatchObject({
      state: 'no-eligible-reviewer',
      conversationId: 'conv-3',
      freshReviewer: { state: 'not-launched', reason: 'fresh reviewer launch failed: rubric unreadable' },
    });
  });

  it('the routed brief uses typed consult verbs for the approval and settled outcome', () => {
    const brief = buildAmendmentReviewBrief(baseInput);
    expect(brief).toContain(JSON.stringify(approval));
    expect(brief).toContain(JSON.stringify(baseInput.patch));
    expect(brief).toContain('R-1 (bar-meaning: falsifier)');
    expect(brief).toContain('Tighten the falsifier.');
    expect(brief).toContain('Read the current criteria with rubrics:get and compare');
    expect(brief).toContain('Do not call rubrics:amend or pass reviewPreviewPost');
    expect(brief).not.toContain('rubrics:amend { rubricRef');
    // The first non-empty reviewer line is the pointer; later verification prose is allowed.
    expect(brief).toContain("the first non-empty body line must be exactly approve thread-post:42. You may add verification notes on later lines");
    expect(brief).toContain('any later approval pointer must name the same preview.');
    expect(brief).toContain("Once the review is settled, call consult:close { conversation_id:'<this consult>', outcome:'answered', answer:'<concise review conclusion>', evidence:[...] }.");
    expect(brief).toContain('consult:reply records the signed post; consult:close records the accepted answer.');
    expect(brief).not.toContain('answer this consult');
    expect(brief).not.toContain('conversations:post');
    expect(/^approve thread-post:([1-9][0-9]*)$/.test('approve thread-post:42')).toBe(true);
    expect(brief).not.toContain('coord:send');
  });

  it('preserves changed criteria after a large unchanged prefix', () => {
    const unchanged = Array.from({ length: 12 }, (_, index) => ({ key: `R-${index + 2}`, model: 'unchanged '.repeat(35) }));
    const changed = { key: 'R-1', model: 'complete changed falsifier after the prefix' };
    const patch = { criteria: [...unchanged, changed], reason: 'keep this field' };
    expect(JSON.stringify(patch).length).toBeGreaterThan(2500);
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch });
    expect(brief).toContain(JSON.stringify({ criteria: [changed], reason: 'keep this field' }));
    expect(brief).toContain('12 unchanged criteria omitted');
    expect(brief).not.toContain(unchanged[0].model);
    expect(brief).not.toContain('chars clipped');
    expect(brief).toContain('must not be submitted to rubrics:amend');
  });

  it('keeps an unmappable replacement complete rather than hiding a changed criterion', () => {
    const patch = { criteria: ['x'.repeat(10_000)] };
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch });
    expect(brief).toContain(JSON.stringify(patch));
    expect(brief).not.toContain('chars clipped');
  });
});

describe('launchFreshAmendmentReviewer (WI-10003299)', () => {
  const approval = { schemaVersion: 1, kind: 'acceptance-bar-approval', rubricRef: 'acceptance-demo', bars: [{ barKey: 'R-1' }] };
  const input = {
    rubricRef: 'plan:acceptance-demo',
    previewPostRef: 'thread-post:42',
    preview: { approval, changes: [{ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['model'] }] },
    patch: { criterion: { key: 'r-1', field: 'model', mode: 'replace', text: 'new model' } },
    applierId: 'su-implementer',
    workspaceId: 'ws',
    // The requester's own tool context: the launch must NOT be attributed to it.
    launchCtx: { ownerId: 'su-implementer', ownerLabel: 'su · impl', isSuperuser: true, workspaceId: 'ws', harnessSlug: '*' },
  } as unknown as Parameters<typeof launchFreshAmendmentReviewer>[0];
  const answerOn = { workItemId: 'WI-7', harness: 'papercusp' };
  const launched = { data: { deduped: false, launch: { tasks: [{ taskId: 'task-1' }] } } };

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      resolveAnswerTarget: vi.fn().mockResolvedValue(answerOn),
      // The implementer's lineage never includes the dedicated launcher.
      resolveScreen: vi.fn(async () => ({ check: lineageScreen('su-implementer') })),
      launch: vi.fn().mockResolvedValue(launched),
      assertAllowed: vi.fn(async () => {}),
      resolveSteeredModel: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('launches ONE headless, independent judge under the system principal, never as the requester', async () => {
    const d = deps();
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(d.resolveScreen).toHaveBeenCalledWith({ rubricId: 'acceptance-demo', applierId: 'su-implementer' });
    expect(d.launch).toHaveBeenCalledTimes(1);
    const [args, ctx] = d.launch.mock.calls[0]!;
    expect(args).toMatchObject({
      harness: 'papercusp',
      headless: true,
      independent: true,
      account: 'auto',
      count: 1,
      members: [{ role: 'judge' }],
    });
    // The lineage fence: the launch edge must point at the dedicated principal.
    expect(ctx).toMatchObject({
      ownerId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      principal: { kind: 'system', slug: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR, workspaceId: 'ws' },
      isSuperuser: false,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
    });
    expect(ctx.ownerId).not.toBe('su-implementer');
    expect(args.brief).toBe(buildAmendmentReviewBrief(input, answerOn));
    expect(result).toEqual({
      state: 'launched',
      launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
      taskId: 'task-1',
      label: expect.stringMatching(/^bar-amendment-review:[0-9a-f]{12}$/),
      idempotencyKey: expect.stringMatching(/^acceptance-bar-amendment-review:[0-9a-f]{32}$/),
      deduped: false,
      answerOn,
    });
  });

  it('is idempotent per preview: the same preview reuses the key, a new preview post gets a new one', async () => {
    const d = deps();
    await launchFreshAmendmentReviewer(input, d as never);
    await launchFreshAmendmentReviewer(input, d as never);
    await launchFreshAmendmentReviewer({ ...input, previewPostRef: 'thread-post:43' }, d as never);
    const keys = d.launch.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('uses the requested backend and effort and keys dedupe by the model choice', async () => {
    const d = deps();
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' } as const;
    const constrained = { ...input, reviewerModel };
    await launchFreshAmendmentReviewer(constrained, d as never);
    await launchFreshAmendmentReviewer(constrained, d as never);
    await launchFreshAmendmentReviewer(input, d as never);
    expect(d.launch.mock.calls[0]![0]).toMatchObject({
      members: [{ role: 'judge', agent: 'codex', model: 'sol', effort: 'xhigh' }],
    });
    const keys = d.launch.mock.calls.map((call) => (call[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(d.assertAllowed).toHaveBeenCalledWith('ws', reviewerModel);
  });

  it('launches a Codex judge selected from the account steer without an explicit reviewerModel', async () => {
    const d = deps({ resolveSteeredModel: vi.fn(async () => ({ agent: 'codex', model: 'sol' })) });
    const steered = await launchFreshAmendmentReviewer(input, d as never);
    expect(d.resolveSteeredModel).toHaveBeenCalledWith('ws');
    expect(d.launch.mock.calls[0]![0]).toMatchObject({
      account: 'auto',
      members: [{ role: 'judge', agent: 'codex', model: 'sol' }],
    });
    const baseline = await launchFreshAmendmentReviewer(input, deps() as never);
    expect(steered.state).toBe('launched');
    expect(baseline.state).toBe('launched');
    if (steered.state === 'launched' && baseline.state === 'launched') {
      expect(steered.idempotencyKey).not.toBe(baseline.idempotencyKey);
    }
  });

  it('refuses to launch when the launcher itself fails the check-approver screen', async () => {
    const screen: AmendmentReviewerScreen = async (ownerId) =>
      ownerId === ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR
        ? { eligible: false, reason: 'related_to_plan_implementer' }
        : { eligible: true, reason: 'eligible' };
    const d = deps({ resolveScreen: vi.fn(async () => ({ check: screen })) });
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(result).toEqual({
      state: 'not-launched',
      reason: expect.stringContaining('related_to_plan_implementer'),
    });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('refuses to launch when the preview post is not on a work-item thread', async () => {
    const d = deps({ resolveAnswerTarget: vi.fn().mockResolvedValue(null) });
    const result = await launchFreshAmendmentReviewer(input, d as never);
    expect(result).toMatchObject({ state: 'not-launched', reason: expect.stringContaining('work-item thread') });
    expect(d.resolveScreen).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('omits the harness-scoped judge role when the work-item has no harness', async () => {
    const d = deps({ resolveAnswerTarget: vi.fn().mockResolvedValue({ workItemId: 'WI-7', harness: null }) });
    await launchFreshAmendmentReviewer(input, d as never);
    const [args] = d.launch.mock.calls[0]!;
    expect(args).not.toHaveProperty('members');
    expect(args).not.toHaveProperty('harness');
  });

  it('reports a refused launch', async () => {
    const d = deps({ launch: vi.fn().mockResolvedValue({ isError: true, content: [{ text: 'quota walled' }] }) });
    await expect(launchFreshAmendmentReviewer(input, d as never)).resolves.toEqual({
      state: 'not-launched',
      reason: 'launch refused: quota walled',
    });
  });

  it('the fresh brief asks for one work_items:comment on the preview work-item, not a consult answer', () => {
    const brief = buildAmendmentReviewBrief(input, answerOn);
    expect(brief.split('\n')).toContain(
      "To approve, use work_items:comment { id:'WI-7', harness:'papercusp' }, body: approve thread-post:42 on the first non-empty line. Add verification notes on later lines if useful; any later approval pointer must name the same preview.",
    );
    expect(brief).not.toContain('answer this consult');
    // A judge cannot call rubrics:amend, so the fresh brief must not require it.
    expect(brief).not.toContain('rubrics:amend');
    expect(brief).toContain(JSON.stringify(approval));
    expect(brief).toContain(ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR);
  });
});

describe('selectFreshReviewerModelForAccountSteer', () => {
  const ranks = [
    { rank: 1, agent: 'claude', model: 'fable' },
    { rank: 2, agent: 'codex', model: 'sol' },
  ] as const;
  const accounts = [
    { id: 'claude-1', provider: 'claude', available: true },
    { id: 'codex-1', provider: 'codex', available: true },
  ];

  it('chooses the first expert model whose provider has an allowed account', () => {
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: ['codex-1'], excludeAccounts: [], accounts, ranks,
    })).toEqual({ agent: 'codex', model: 'sol' });
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: ['claude-1'], accounts, ranks,
    })).toEqual({ agent: 'codex', model: 'sol' });
  });

  it('uses the first available allowed rank without account restrictions', () => {
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [], accounts, ranks,
    })).toEqual({ agent: 'claude', model: 'fable' });
    expect(selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [],
      accounts: accounts.map((account) => ({ ...account, available: account.provider === 'codex' })),
      ranks,
    })).toEqual({ agent: 'codex', model: 'sol' });
  });

  it('never widens the model policy or falls back to a default login when no allowed rank is available', () => {
    expect(() => selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [],
      accounts: accounts.map((account) => ({ ...account, available: false })), ranks,
    })).toThrow('no expert model has an available account permitted by the workspace account steer');
    expect(() => selectFreshReviewerModelForAccountSteer({
      forcedAccounts: [], excludeAccounts: [],
      accounts: [{ id: 'codex-1', provider: 'codex', available: true }],
      ranks: [{ rank: 1, agent: 'claude', model: 'fable' }],
    })).toThrow('no expert model has an available account permitted by the workspace account steer');
  });

  it('refuses an unavailable forced pool even if another provider is available', () => {
    expect(() => selectFreshReviewerModelForAccountSteer({
      forcedAccounts: ['codex-1'], excludeAccounts: [],
      accounts: accounts.map((account) => ({ ...account, available: account.id !== 'codex-1' })),
      ranks,
    })).toThrow('no expert model has an available account permitted by the workspace account steer');
  });
});
