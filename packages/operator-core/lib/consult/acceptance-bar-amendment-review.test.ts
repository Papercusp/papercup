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
  buildAmendmentReviewBrief,
  filterAmendmentReviewRoute,
  openAcceptanceBarAmendmentReview,
  routeAcceptanceBarAmendmentReview,
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
    const result = await openAcceptanceBarAmendmentReview(baseInput, { verifyPreviewPost: vi.fn(), route });
    expect(result).toMatchObject({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:42' });
    expect(result.next).not.toContain('consult:reply');
  });

  it('the brief carries what the reviewer signs and the one line the apply guard accepts', () => {
    const brief = buildAmendmentReviewBrief(baseInput);
    expect(brief).toContain(JSON.stringify(approval));
    expect(brief).toContain(JSON.stringify(baseInput.patch));
    expect(brief).toContain('R-1 (bar-meaning: falsifier)');
    expect(brief).toContain('Tighten the falsifier.');
    // The apply resolver accepts exactly /^approve thread-post:(\d+)$/ on the reviewer's post.
    expect(brief.split('\n')).toContain('To approve, answer this consult with exactly one line: approve thread-post:42');
    expect(/^approve thread-post:([1-9][0-9]*)$/.test('approve thread-post:42')).toBe(true);
    expect(brief).not.toContain('coord:send');
  });

  it('clips an oversized patch instead of routing an unbounded brief', () => {
    const brief = buildAmendmentReviewBrief({ ...baseInput, patch: { criteria: ['x'.repeat(10_000)] } });
    expect(brief.length).toBeLessThan(6_000);
    expect(brief).toMatch(/chars clipped\]/);
  });
});
