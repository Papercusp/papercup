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
  filterAmendmentReviewRoute,
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
