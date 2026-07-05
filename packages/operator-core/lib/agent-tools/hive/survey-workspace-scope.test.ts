/**
 * survey-workspace-scope.test.ts (tool) — P-003 Phase B: the pot:survey TOOL
 * gate. OFF (the dark default) ⇒ the single-hive survey shape, BYTE-IDENTICAL to
 * today; ON ⇒ the cross-hive shape (perHive sections + a crossHive ranked
 * priority). The survey math is covered by ../../hive/survey-workspace-scope.ts;
 * this pins the FLAG BRANCH in the tool handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
  surveyHive: vi.fn(),
  surveyWorkspace: vi.fn(),
}));

vi.mock('../../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});
vi.mock('../../hive/survey', () => ({
  surveyHive: h.surveyHive,
  surveyWorkspace: h.surveyWorkspace,
}));
// Keep resolveHiveHomeSlug real-ish but env-driven; the handler only needs a slug.
vi.mock('../../hive/wake', () => ({
  resolveHiveHomeSlug: (explicit?: string | null) => explicit ?? 'papercusp',
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
  h.surveyHive.mockReset();
  h.surveyWorkspace.mockReset();
});

describe('pot:survey tool — flag OFF (byte-identical single-hive survey)', () => {
  it('OFF → calls surveyHive, returns the single-hive shape, no perHive/crossHive', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.surveyHive.mockResolvedValue({
      home: 'papercusp',
      members: ['proj'],
      scope: 'members',
      plans: [ranked('plan-1', 'proj', 12)],
      frontier: [ranked('WI-1', 'proj', 5)],
      frontierBlocked: 0,
    });

    const out = body(await tool.handler({ harness: 'papercusp' } as never, ctx));

    expect(h.surveyHive).toHaveBeenCalledTimes(1);
    expect(h.surveyWorkspace).not.toHaveBeenCalled();
    // The exact single-hive shape today — keys + values unchanged.
    expect(out).toMatchObject({
      ok: true,
      home: 'papercusp',
      members: ['proj'],
      scope: 'members',
      counts: { plans: 1, frontier: 1, frontierBlocked: 0 },
    });
    expect(out.plans[0]).toMatchObject({ id: 'plan-1', harness: 'proj' });
    expect(out.frontier[0]).toMatchObject({ id: 'WI-1', harness: 'proj' });
    // No cross-hive keys leak into the OFF response.
    expect(out.perHive).toBeUndefined();
    expect(out.crossHive).toBeUndefined();
    expect(out.hives).toBeUndefined();
    // The OFF compact rows carry NO `hive` tag (byte-identical to pre-Phase-B).
    expect('hive' in out.plans[0]).toBe(false);
    expect('hive' in out.frontier[0]).toBe(false);
  });
});

describe('pot:survey tool — flag ON (cross-hive dispatch widening)', () => {
  it('ON → calls surveyWorkspace, returns perHive sections + a crossHive ranked priority', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.surveyWorkspace.mockResolvedValue({
      hives: ['hive-a', 'hive-b'],
      perHive: [
        {
          hive: 'hive-a',
          survey: { home: 'hive-a', members: ['proj-a'], scope: 'members', plans: [ranked('plan-a', 'proj-a', 3, { hive: 'hive-a' })], frontier: [ranked('WI-A', 'proj-a', 1, { hive: 'hive-a' })], frontierBlocked: 0 },
        },
        {
          hive: 'hive-b',
          survey: { home: 'hive-b', members: ['proj-b'], scope: 'members', plans: [ranked('plan-b', 'proj-b', 20, { hive: 'hive-b' })], frontier: [ranked('WI-B', 'proj-b', 2, { hive: 'hive-b' })], frontierBlocked: 1 },
        },
      ],
      crossHive: {
        plans: [ranked('plan-b', 'proj-b', 20, { hive: 'hive-b' }), ranked('plan-a', 'proj-a', 3, { hive: 'hive-a' })],
        frontier: [ranked('WI-B', 'proj-b', 2, { hive: 'hive-b' }), ranked('WI-A', 'proj-a', 1, { hive: 'hive-a' })],
        frontierBlocked: 1,
      },
    });

    const out = body(await tool.handler({} as never, ctx));

    expect(h.surveyWorkspace).toHaveBeenCalledTimes(1);
    expect(h.surveyHive).not.toHaveBeenCalled();
    expect(out.scope).toBe('workspace');
    expect(out.hives).toEqual(['hive-a', 'hive-b']);
    expect(out.counts).toEqual({ hives: 2, plans: 2, frontier: 2, frontierBlocked: 1 });
    // cross-hive ranked priority — hive-b's urgent plan leads, each row hive-tagged.
    expect(out.crossHive.plans.map((c: { id: string }) => c.id)).toEqual(['plan-b', 'plan-a']);
    expect(out.crossHive.plans[0].hive).toBe('hive-b');
    expect(out.crossHive.frontier[0].hive).toBe('hive-b');
    // per-hive sections preserved + tagged.
    expect(out.perHive.map((s: { hive: string }) => s.hive)).toEqual(['hive-a', 'hive-b']);
    expect(out.perHive[1]).toMatchObject({ hive: 'hive-b', home: 'hive-b', counts: { plans: 1, frontier: 1, frontierBlocked: 1 } });
  });
});
