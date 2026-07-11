/**
 * blender:route-idea (su-ideate-learning-substrate-2026-07-10 P-009). Pins:
 *  - the draft path: a fresh idea → a draft plan (shared createScoutPlanDraft
 *    seam) + a NEW origin='su-ideate' ledger row keyed by the plan ref, createdBy
 *    the caller, rail:'plan', routedRef:'plan:<slug>';
 *  - the re-route path: an already-filed feature → upsert its EXISTING ledger row
 *    (ideaId = the EI id) onto the plan rail, PRESERVING the originator's
 *    created_by, lens read from payload.ideation, + a best-effort wi↔plan
 *    'relates' edge, and the wi is left OPEN (D-007);
 *  - not-found featureId ⇒ ok:false without creating a plan;
 *  - a link failure is best-effort — the routing still succeeds;
 *  - the args XOR (exactly one of featureId/draft) + rail defaulting to 'plan'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineerIssue } from '../../issues-engineer';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  buildRouteRationale,
  routeIdeaArgs,
  runRouteIdea,
  slugStemFromTitle,
  toToolResult,
  type RouteIdeaDeps,
} from './route-idea';

vi.mock('../coordination/identity');
const mockIdentity = vi.mocked(resolveAgentIdentity);

function identity(ownerId = 'su-caller') {
  return {
    ownerId,
    ownerLabel: `su · ${ownerId}`,
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  } as ReturnType<typeof resolveAgentIdentity>;
}

/** A deps double: createPlanDraft echoes a dated slug; the rest are spies. Any
 *  `over` spy REPLACES the default so the returned handle is the one deps uses. */
function makeDeps(over: Partial<RouteIdeaDeps> = {}) {
  const createPlanDraft =
    over.createPlanDraft ??
    vi.fn(async (input: { slug: string }) => ({ slug: `${input.slug}-2026-07-11`, created: true }));
  const recordRoutedIdea = over.recordRoutedIdea ?? vi.fn(async () => undefined);
  const getIssue = over.getIssue ?? vi.fn(async () => null as EngineerIssue | null);
  const linkIssue = over.linkIssue ?? vi.fn(async () => undefined);
  return {
    deps: { createPlanDraft, recordRoutedIdea, getIssue, linkIssue } as unknown as RouteIdeaDeps,
    createPlanDraft,
    recordRoutedIdea,
    getIssue,
    linkIssue,
  };
}

function issue(over: Partial<EngineerIssue> = {}): EngineerIssue {
  return {
    id: 'EI-500',
    kind: 'change',
    scope: 'operator',
    title: 'Adaptive triage batching',
    body: 'Batch low-severity triage into one pass.',
    severity: 'minor',
    source: 'agent',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    lastProgressAt: null,
    payload: { ideation: { lens: 'risk-first' } },
    origin: 'local',
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: 'su-originator',
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    ...over,
  } as EngineerIssue;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentity.mockReturnValue(identity());
});

describe('slugStemFromTitle', () => {
  it('kebab-cases, trims, and caps; falls back for empty input', () => {
    expect(slugStemFromTitle('Adaptive Triage Batching!')).toBe('adaptive-triage-batching');
    expect(slugStemFromTitle('  Multi--rail  routing  ')).toBe('multi-rail-routing');
    expect(slugStemFromTitle('???')).toBe('su-idea');
    const long = slugStemFromTitle('a'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('buildRouteRationale', () => {
  it('composes present fields and drops absent ones', () => {
    const r = buildRouteRationale({
      framing: 'the why',
      mechanism: 'the how',
      cheapExperiment: { hypothesis: 'h', method: 'm', falsifiableSignal: 's' },
    });
    expect(r).toContain('**Framing:** the why');
    expect(r).toContain('**Mechanism:** the how');
    expect(r).toContain('hypothesis — h; method — m; falsifiable signal — s');
    expect(r).not.toContain('**Bet:**');
  });

  it('notes the source ref (re-route provenance)', () => {
    expect(buildRouteRationale({ framing: 'x', sourceRef: 'wi:EI-9' })).toContain('Routed from wi:EI-9');
  });
});

describe('runRouteIdea — draft path', () => {
  it('creates a draft plan and a fresh su-ideate ledger row keyed by the plan ref', async () => {
    const { deps, createPlanDraft, recordRoutedIdea, getIssue, linkIssue } = makeDeps();
    const out = await runRouteIdea(
      {
        draft: { title: 'Adaptive triage batching', framing: 'the why', mechanism: 'the how', lens: 'cost-leverage' },
        rail: 'plan',
      },
      {},
      deps,
    );

    expect(createPlanDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'adaptive-triage-batching',
        title: 'Adaptive triage batching',
        harnessSlug: 'papercusp',
        rationale: expect.stringContaining('**Mechanism:** the how'),
      }),
    );
    expect(recordRoutedIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaId: 'plan:adaptive-triage-batching-2026-07-11',
        origin: 'su-ideate',
        rail: 'plan',
        routedRef: 'plan:adaptive-triage-batching-2026-07-11',
        lens: 'cost-leverage',
        createdBy: 'su-caller',
        harnessSlug: 'papercusp',
        title: 'Adaptive triage batching',
      }),
    );
    // A fresh idea touches neither the issue store nor the link store.
    expect(getIssue).not.toHaveBeenCalled();
    expect(linkIssue).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      ok: true,
      rail: 'plan',
      slug: 'adaptive-triage-batching-2026-07-11',
      planRef: 'plan:adaptive-triage-batching-2026-07-11',
      created: true,
      wiStaysOpen: false,
    });
  });

  it("defaults the lens to the 'su-ideate' sentinel when none is declared", async () => {
    const { deps, recordRoutedIdea } = makeDeps();
    await runRouteIdea({ draft: { title: 'x idea', framing: 'f', mechanism: 'm' }, rail: 'plan' }, {}, deps);
    expect(recordRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ lens: 'su-ideate' }));
  });
});

describe('runRouteIdea — re-route (featureId) path', () => {
  it('upserts the existing ledger row onto the plan rail, preserves the originator, links wi↔plan, leaves the wi open', async () => {
    const { deps, createPlanDraft, recordRoutedIdea, getIssue, linkIssue } = makeDeps({
      getIssue: vi.fn(async () => issue()),
    });
    const out = await runRouteIdea({ featureId: 'EI-500', rail: 'plan' }, {}, deps);

    expect(getIssue).toHaveBeenCalledWith('EI-500');
    expect(createPlanDraft).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'adaptive-triage-batching', title: 'Adaptive triage batching' }),
    );
    expect(recordRoutedIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaId: 'EI-500', // upsert the feature's OWN ledger row
        origin: 'su-ideate',
        rail: 'plan',
        routedRef: 'plan:adaptive-triage-batching-2026-07-11',
        lens: 'risk-first', // read from payload.ideation
        createdBy: 'su-originator', // the ORIGINATOR, not the re-router
      }),
    );
    expect(linkIssue).toHaveBeenCalledWith(
      'EI-500',
      { kind: 'plan', ref: 'adaptive-triage-batching-2026-07-11' },
      'relates',
      'su-caller',
    );
    expect(out).toMatchObject({ ok: true, featureId: 'EI-500', linked: true, wiStaysOpen: true });
  });

  it("falls back to the 'su-ideate' lens sentinel when the payload carries no ideation", async () => {
    const { deps, recordRoutedIdea } = makeDeps({ getIssue: vi.fn(async () => issue({ payload: null })) });
    await runRouteIdea({ featureId: 'EI-500', rail: 'plan' }, {}, deps);
    expect(recordRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ lens: 'su-ideate' }));
  });

  it('a not-found featureId returns ok:false and creates no plan', async () => {
    const { deps, createPlanDraft, recordRoutedIdea } = makeDeps({ getIssue: vi.fn(async () => null) });
    const out = await runRouteIdea({ featureId: 'EI-nope', rail: 'plan' }, {}, deps);
    expect(out).toEqual({ ok: false, reason: 'not-found', featureId: 'EI-nope' });
    expect(createPlanDraft).not.toHaveBeenCalled();
    expect(recordRoutedIdea).not.toHaveBeenCalled();
    expect(toToolResult(out).isError).toBe(true);
  });

  it('a link failure is best-effort — the routing still succeeds (linked:false)', async () => {
    const { deps, recordRoutedIdea } = makeDeps({
      getIssue: vi.fn(async () => issue()),
      linkIssue: vi.fn(async () => {
        throw new Error('link store down');
      }),
    });
    const out = await runRouteIdea({ featureId: 'EI-500', rail: 'plan' }, {}, deps);
    expect(recordRoutedIdea).toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, linked: false, wiStaysOpen: true });
  });
});

describe('routeIdeaArgs (schema)', () => {
  it('accepts exactly one of featureId / draft and defaults rail to plan', () => {
    const draftOnly = routeIdeaArgs.safeParse({ draft: { title: 't', framing: 'f', mechanism: 'm' } });
    expect(draftOnly.success).toBe(true);
    if (draftOnly.success) expect(draftOnly.data.rail).toBe('plan');

    expect(routeIdeaArgs.safeParse({ featureId: 'EI-1' }).success).toBe(true);
  });

  it('rejects passing both or neither', () => {
    expect(routeIdeaArgs.safeParse({}).success).toBe(false);
    expect(
      routeIdeaArgs.safeParse({ featureId: 'EI-1', draft: { title: 't', framing: 'f', mechanism: 'm' } }).success,
    ).toBe(false);
  });

  it("rejects a non-'plan' rail (gym/instance are out of scope here)", () => {
    expect(routeIdeaArgs.safeParse({ featureId: 'EI-1', rail: 'gym' }).success).toBe(false);
  });
});
