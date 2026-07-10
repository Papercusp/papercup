/**
 * survey-workspace-scope.test.ts (tool) — P-003 Phase B: the pot:survey TOOL
 * gate. OFF (the dark default) ⇒ the single-pot survey shape, BYTE-IDENTICAL to
 * today; ON ⇒ the cross-pot shape (perPot sections + a crossPot ranked
 * priority). The survey math is covered by ../../pot/survey-workspace-scope.ts;
 * this pins the FLAG BRANCH in the tool handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
  surveyPot: vi.fn(),
  surveyWorkspace: vi.fn(),
}));

vi.mock('../../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});
vi.mock('../../pot/survey', () => ({
  surveyPot: h.surveyPot,
  surveyWorkspace: h.surveyWorkspace,
}));
// Keep resolvePotHomeSlug real-ish but env-driven; the handler only needs a slug.
vi.mock('../../pot/wake', () => ({
  resolvePotHomeSlug: (explicit?: string | null) => explicit ?? 'papercusp',
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));

import tool from './survey';

// The handler returns a {data} envelope (context-trimming-tiers P-024) —
// serialization to content[] happens in defineTool dispatch, not here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: unknown): any => (r as { data: unknown }).data;
const ctx = { workspaceId: 'papercusp-workspace', role: 'mug' } as never;

const ranked = (id: string, harness: string, score: number, extra: Record<string, unknown> = {}) => ({
  id,
  harness,
  title: id,
  importance: 'normal',
  rank: { score, features: [{ feature: 'plan-importance', value: 0, weight: 4, contribution: 0, reasons: [] }] },
  ...extra,
});

beforeEach(() => {
  h.isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
  h.surveyPot.mockReset();
  h.surveyWorkspace.mockReset();
});

describe('pot:survey tool — flag OFF (byte-identical single-pot survey)', () => {
  it('OFF → calls surveyPot, returns the single-pot shape, no perPot/crossPot', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.surveyPot.mockResolvedValue({
      home: 'papercusp',
      members: ['proj'],
      scope: 'members',
      plans: [ranked('plan-1', 'proj', 12)],
      frontier: [ranked('WI-1', 'proj', 5)],
      frontierBlocked: 0,
    });

    const out = body(await tool.handler({ harness: 'papercusp' } as never, ctx));

    expect(h.surveyPot).toHaveBeenCalledTimes(1);
    expect(h.surveyWorkspace).not.toHaveBeenCalled();
    // The exact single-pot shape today — keys + values unchanged.
    expect(out).toMatchObject({
      ok: true,
      home: 'papercusp',
      members: ['proj'],
      scope: 'members',
      counts: { plans: 1, frontier: 1, frontierBlocked: 0 },
    });
    expect(out.plans[0]).toMatchObject({ id: 'plan-1', harness: 'proj' });
    expect(out.frontier[0]).toMatchObject({ id: 'WI-1', harness: 'proj' });
    // No cross-pot keys leak into the OFF response.
    expect(out.perPot).toBeUndefined();
    expect(out.crossPot).toBeUndefined();
    expect(out.hives).toBeUndefined();
    // The OFF compact rows carry NO `hive` tag (byte-identical to pre-Phase-B).
    expect('hive' in out.plans[0]).toBe(false);
    expect('hive' in out.frontier[0]).toBe(false);
  });
});

describe('pot:survey tool — flag ON (cross-pot dispatch widening)', () => {
  it('ON → calls surveyWorkspace, returns perPot sections + a crossPot ranked priority', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.surveyWorkspace.mockResolvedValue({
      hives: ['pot-a', 'pot-b'],
      perPot: [
        {
          pot: 'pot-a',
          survey: { home: 'pot-a', members: ['proj-a'], scope: 'members', plans: [ranked('plan-a', 'proj-a', 3, { pot: 'pot-a' })], frontier: [ranked('WI-A', 'proj-a', 1, { pot: 'pot-a' })], frontierBlocked: 0 },
        },
        {
          pot: 'pot-b',
          survey: { home: 'pot-b', members: ['proj-b'], scope: 'members', plans: [ranked('plan-b', 'proj-b', 20, { pot: 'pot-b' })], frontier: [ranked('WI-B', 'proj-b', 2, { pot: 'pot-b' })], frontierBlocked: 1 },
        },
      ],
      crossPot: {
        plans: [ranked('plan-b', 'proj-b', 20, { pot: 'pot-b' }), ranked('plan-a', 'proj-a', 3, { pot: 'pot-a' })],
        frontier: [ranked('WI-B', 'proj-b', 2, { pot: 'pot-b' }), ranked('WI-A', 'proj-a', 1, { pot: 'pot-a' })],
        frontierBlocked: 1,
      },
    });

    const out = body(await tool.handler({} as never, ctx));

    expect(h.surveyWorkspace).toHaveBeenCalledTimes(1);
    expect(h.surveyPot).not.toHaveBeenCalled();
    expect(out.scope).toBe('workspace');
    expect(out.hives).toEqual(['pot-a', 'pot-b']);
    expect(out.counts).toEqual({ hives: 2, plans: 2, frontier: 2, frontierBlocked: 1 });
    // cross-pot ranked priority — pot-b's urgent plan leads, each row pot-tagged.
    expect(out.crossPot.plans.map((c: { id: string }) => c.id)).toEqual(['plan-b', 'plan-a']);
    expect(out.crossPot.plans[0].pot).toBe('pot-b');
    expect(out.crossPot.frontier[0].pot).toBe('pot-b');
    // per-pot sections preserved + tagged.
    expect(out.perPot.map((s: { pot: string }) => s.pot)).toEqual(['pot-a', 'pot-b']);
    expect(out.perPot[1]).toMatchObject({ pot: 'pot-b', home: 'pot-b', counts: { plans: 1, frontier: 1, frontierBlocked: 1 } });
  });
});
