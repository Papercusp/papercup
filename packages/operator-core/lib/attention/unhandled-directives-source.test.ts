/**
 * The owner's "nobody is handling these" list (owner-directive-delivery-redesign
 * P-008 / R-7): only UNHANDLED routes surface, each as a decision-tier card that
 * carries the owner's words (the D-004 display text, never a cut fragment).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerDirectiveRow } from '../owner-directives';
import type { DirectiveRoute } from '../owner-directive-routing';
import { namedQueryStageTimings, withNamedQueryDiagnosticContext } from '../agent-tools/db-diagnostic-correlation-wiring';

const h = vi.hoisted(() => ({ listOwnerDirectives: vi.fn(), routeOpenDirectives: vi.fn() }));

vi.mock('../owner-directives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../owner-directives')>()),
  listOwnerDirectives: h.listOwnerDirectives,
}));
vi.mock('../owner-directive-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../owner-directive-routing')>()),
  routeOpenDirectives: h.routeOpenDirectives,
}));

const { readUnhandledDirectives } = await import('./unhandled-directives-source');
const { unhandledDirectiveToAttention } = await import('./adapters');

function directive(id: number, verbatimText: string): OwnerDirectiveRow {
  return {
    id,
    workspaceId: 'ws',
    ownerId: 'owner',
    sessionRef: null,
    sourceTurnRef: `turn-${id}`,
    verbatimText,
    recordedBy: 'su-ended-000000',
    createdAtMs: Date.parse('2026-09-22T12:00:00.000Z'),
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
    capturedByHook: true,
  };
}

beforeEach(() => {
  h.listOwnerDirectives.mockReset();
  h.routeOpenDirectives.mockReset();
});

describe('readUnhandledDirectives', () => {
  it('surfaces only the unhandled routes', async () => {
    h.listOwnerDirectives.mockResolvedValue([directive(1, 'ship it'), directive(2, 'fix it'), directive(3, 'test it')]);
    h.routeOpenDirectives.mockResolvedValue(
      new Map<number, DirectiveRoute>([
        [1, { kind: 'addressee' }],
        [2, { kind: 'fleet-leader', fleetSlug: 'f', leaderOwnerId: 'su-leader' }],
        [3, { kind: 'unhandled', why: 'no-fleet', fleetSlug: null }],
      ]),
    );
    const out = await readUnhandledDirectives({ workspaceId: 'ws' });
    expect(out).toEqual([
      {
        directiveId: 3,
        displayText: '"test it"',
        recordedBy: 'su-ended-000000',
        why: 'no-fleet',
        fleetSlug: null,
        createdAt: '2026-09-22T12:00:00.000Z',
      },
    ]);
  });

  it('reads nothing further when no directive is open', async () => {
    h.listOwnerDirectives.mockResolvedValue([]);
    expect(await readUnhandledDirectives({ workspaceId: 'ws' })).toEqual([]);
    expect(h.routeOpenDirectives).not.toHaveBeenCalled();
  });

  it.each(['list', 'routing'] as const)('retains the pending %s boundary in the original attention request', async boundary => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const rows = [directive(3, 'test it')];
    const routes = new Map<number, DirectiveRoute>([
      [3, { kind: 'unhandled', why: 'no-fleet', fleetSlug: null }],
    ]);
    h.listOwnerDirectives.mockImplementation(async () => {
      if (boundary === 'list') { enter(); await paused; }
      return rows;
    });
    h.routeOpenDirectives.mockImplementation(async () => {
      if (boundary === 'routing') { enter(); await paused; }
      return routes;
    });

    await withNamedQueryDiagnosticContext('plans.attention', async requestId => {
      const read = readUnhandledDirectives({ workspaceId: 'ws' });
      try {
        await entered;
        expect(namedQueryStageTimings()).toMatchObject({ requestId, omittedStages: 0 });
        expect(namedQueryStageTimings()?.stages).toEqual(expect.arrayContaining([
          expect.objectContaining({ stage: 'attention-directives-import', outcome: 'fulfilled' }),
          expect.objectContaining({ stage: `attention-directives-${boundary}`, outcome: 'pending' }),
        ]));
        if (boundary === 'list') expect(h.routeOpenDirectives).not.toHaveBeenCalled();
      } finally {
        release();
        await read;
      }
      expect(await read).toMatchObject([{ directiveId: 3, displayText: '"test it"' }]);
      expect(namedQueryStageTimings()?.stages.every(stage => stage.outcome === 'fulfilled')).toBe(true);
    });
    expect(namedQueryStageTimings()).toBeNull();
  });

  it('records a rejected routing boundary without replacing the original failure', async () => {
    const failure = new Error('routing unavailable');
    h.listOwnerDirectives.mockResolvedValue([directive(3, 'test it')]);
    h.routeOpenDirectives.mockRejectedValue(failure);
    await withNamedQueryDiagnosticContext('plans.attention', async () => {
      await expect(readUnhandledDirectives({ workspaceId: 'ws' })).rejects.toBe(failure);
      expect(namedQueryStageTimings()?.stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'attention-directives-routing', outcome: 'rejected' }),
      ]));
    });
  });
});

describe('unhandledDirectiveToAttention', () => {
  it('is a decision-tier card carrying the owner words, with no auto-disposition category', () => {
    const card = unhandledDirectiveToAttention({
      directiveId: 42,
      displayText: '"rank dead agents"',
      recordedBy: 'su-ended-000000',
      why: 'leader-ended',
      fleetSlug: 'fleet-a',
      createdAt: '2026-09-22T12:00:00.000Z',
    });
    expect(card).toMatchObject({
      id: 'unhandled-directive:42',
      kind: 'unhandled-directive',
      category: null,
      tier: 'decision',
      needsHuman: true,
      ref: { kind: 'unhandled-directive', directiveId: 42 },
    });
    expect(card.body).toContain('"rank dead agents"');
    expect(card.body).toContain('fleet leader has ended too');
    expect(card.actions?.map((a) => a.id)).toContain('ack');
  });
});
