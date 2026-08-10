/**
 * survey-claim-order-check.test.ts — EI-18953436700237995: pot:survey's
 * opt-in `checkClaimOrder` cross-check between the placement ranker's own
 * frontier head and the harness's ACTUAL claim-serving order (the same
 * oracle `work_items:claimable` reports). Pins:
 *   - default (omitted) ⇒ never calls the oracle — no cost, no field.
 *   - requested + disjoint heads ⇒ `rankingDivergence:true` + a note.
 *   - requested + overlapping heads ⇒ `rankingDivergence:false`, still surfaced.
 *   - requested but nothing IN-HARNESS to compare (empty either side) ⇒ the
 *     field is simply absent — never a false positive.
 *   - the oracle throwing ⇒ fail-open, field absent, survey still returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
  surveyPot: vi.fn(),
  surveyWorkspace: vi.fn(),
  readIssueClaimability: vi.fn(),
}));

vi.mock('../../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});
vi.mock('../../pot/survey', () => ({
  surveyPot: h.surveyPot,
  surveyWorkspace: h.surveyWorkspace,
}));
vi.mock('../../pot/wake', () => ({
  resolvePotHomeSlug: (explicit?: string | null) => explicit ?? 'papercusp',
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../../scheduler/get-next', () => ({
  readIssueClaimability: h.readIssueClaimability,
}));

// TIER ENABLED for this suite (retire-mug-kettle-su-only-2026-08-09 P-010 / D-017):
// pot:survey now opens with the retirement gate, so without this the file would
// assert the REFUSAL instead of the claim-order-check behaviour it is about. The
// gate itself is covered by ../mug-kettle-tool-gate.test.ts, which pins both sides
// for pot:survey. importOriginal is spread so no sibling export of pot/started is
// stranded (lint:vimock-export-strands).
vi.mock('../../pot/started', async (orig) => ({
  ...(await orig<typeof import('../../pot/started')>()),
  mugKettleSystemEnabled: async () => true,
}));

import tool from './survey';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: unknown): any => (r as { data: unknown }).data;
const ctx = { workspaceId: 'papercusp-workspace', role: 'mug' } as never;

const ranked = (id: string, harness: string, score: number, extra: Record<string, unknown> = {}) => ({
  id,
  harness,
  view: 'work-item',
  title: id,
  importance: 'normal',
  rank: { score, features: [{ feature: 'plan-importance', value: 0, weight: 4, contribution: 0, reasons: [] }] },
  ...extra,
});

beforeEach(() => {
  h.isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
  h.surveyPot.mockReset();
  h.surveyWorkspace.mockReset();
  h.readIssueClaimability.mockReset();
});

describe('pot:survey tool — checkClaimOrder (EI-18953436700237995)', () => {
  it('omitted (default false) ⇒ never calls the oracle, no claimOrderCheck field', async () => {
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['papercusp'],
      scope: 'members',
      plans: [],
      frontier: [ranked('EI-1', 'papercusp', 5)],
      frontierBlocked: 0,
    });

    const out = body(await tool.handler({ harness: 'papercusp' } as never, ctx));

    expect(h.readIssueClaimability).not.toHaveBeenCalled();
    expect(out.claimOrderCheck).toBeUndefined();
  });

  it('requested + disjoint heads ⇒ rankingDivergence:true with both heads named', async () => {
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['papercusp'],
      scope: 'members',
      plans: [],
      frontier: [ranked('EI-critical-1', 'papercusp', 50), ranked('EI-critical-2', 'papercusp', 40)],
      frontierBlocked: 0,
    });
    h.readIssueClaimability.mockResolvedValue({
      breakdown: { claimable: 2, matchedByFilter: 2, excluded: {} },
      rows: [
        { id: 'WI-housekeeping-1', kind: 'task', title: 't', status: 'open', severity: null, plan: null, featureOrder: 1, createdTs: 1 },
        { id: 'WI-housekeeping-2', kind: 'task', title: 't', status: 'open', severity: null, plan: null, featureOrder: 2, createdTs: 2 },
      ],
      admitted: {},
    });

    const out = body(await tool.handler({ harness: 'papercusp', checkClaimOrder: true } as never, ctx));

    expect(h.readIssueClaimability).toHaveBeenCalledTimes(1);
    // no spec filter — the DEFAULT claim-serving order, unsteered.
    expect(h.readIssueClaimability.mock.calls[0][0]).toBeUndefined();
    expect(h.readIssueClaimability.mock.calls[0][1]).toMatchObject({ harness: 'papercusp' });
    expect(out.claimOrderCheck).toMatchObject({
      rankingDivergence: true,
      surveyHead: ['EI-critical-1', 'EI-critical-2'],
      claimOrderHead: ['WI-housekeeping-1', 'WI-housekeeping-2'],
    });
    expect(out.claimOrderCheck.note).toMatch(/RANKING DIVERGENCE/);
    expect(out.claimOrderCheck.note).toMatch(/EI-18953436700237995/);
  });

  it('requested + overlapping heads ⇒ rankingDivergence:false, still surfaced (not silent)', async () => {
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['papercusp'],
      scope: 'members',
      plans: [],
      frontier: [ranked('WI-shared', 'papercusp', 50)],
      frontierBlocked: 0,
    });
    h.readIssueClaimability.mockResolvedValue({
      breakdown: { claimable: 1, matchedByFilter: 1, excluded: {} },
      rows: [{ id: 'WI-shared', kind: 'bug', title: 't', status: 'open', severity: 'critical', plan: null, featureOrder: null, createdTs: 1 }],
      admitted: {},
    });

    const out = body(await tool.handler({ harness: 'papercusp', checkClaimOrder: true } as never, ctx));

    expect(out.claimOrderCheck).toMatchObject({ rankingDivergence: false });
    expect(out.claimOrderCheck.note).toMatch(/no divergence detected/);
  });

  it('requested but frontier has no in-harness work-item candidates ⇒ field absent, never a false positive', async () => {
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['papercusp', 'other-member'],
      scope: 'members',
      plans: [],
      // Only a cross-member candidate — nothing IN this harness to compare.
      frontier: [ranked('EI-1', 'other-member', 5)],
      frontierBlocked: 0,
    });

    const out = body(await tool.handler({ harness: 'papercusp', checkClaimOrder: true } as never, ctx));

    expect(h.readIssueClaimability).not.toHaveBeenCalled();
    expect(out.claimOrderCheck).toBeUndefined();
  });

  it('requested but the oracle read throws ⇒ fail-open: field absent, survey still returns ok:true', async () => {
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['papercusp'],
      scope: 'members',
      plans: [],
      frontier: [ranked('EI-1', 'papercusp', 5)],
      frontierBlocked: 0,
    });
    h.readIssueClaimability.mockRejectedValue(new Error('statement timeout'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = body(await tool.handler({ harness: 'papercusp', checkClaimOrder: true } as never, ctx));

    expect(out.ok).toBe(true);
    expect(out.claimOrderCheck).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[pot-survey] checkClaimOrder comparison failed'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('requested but the served claim order is empty ⇒ field absent (nothing to compare against)', async () => {
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['papercusp'],
      scope: 'members',
      plans: [],
      frontier: [ranked('EI-1', 'papercusp', 5)],
      frontierBlocked: 0,
    });
    h.readIssueClaimability.mockResolvedValue({
      breakdown: { claimable: 0, matchedByFilter: 0, excluded: {} },
      rows: [],
      admitted: {},
    });

    const out = body(await tool.handler({ harness: 'papercusp', checkClaimOrder: true } as never, ctx));

    expect(out.claimOrderCheck).toBeUndefined();
  });
});
