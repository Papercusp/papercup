/**
 * router-deps.test.ts — production wiring of the Scout router dispatch ports (P-007).
 *
 * The underlying backends are tested elsewhere (capture-core.test.ts,
 * gym-bridge via its own tests); this pins the proposal→backend MAPPING +
 * the duplicate-decline attribution that only this file owns.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Proposal } from './types';
import type { ArchivePort, ArchiveEliteView } from './gym-bridge';
import type { CaptureImprovementInput, CaptureImprovementResult } from '../harness/improvements/capture-core';
import {
  buildCapturePort,
  buildGoalDispatchPort,
  buildGoalAmendmentDispatchPort,
  buildGymDispatchPort,
  buildPlansNewPort,
  improvementBody,
  type GoalUpdateDispatcher,
  type PlanDraftCreator,
} from './router-deps';

const autoStartGoal = vi.hoisted(() =>
  vi.fn(async () => ({
    goalId: 'goal-auto',
    agentOwnerId: 'agent-auto',
    drainFleet: null,
    startBlockedOverride: null,
    warnings: [],
  })),
);
vi.mock('../goals/goal-auto-start', () => ({ autoStartGoal }));

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    framing: 'Wake-on-grant for blocked edits',
    mechanism: 'register a wake on lock grant + yield the turn',
    whyNew: 'no prior plan treats a block as a wake-trigger',
    bet: 'fewer wasted retries',
    cheapExperiment: { hypothesis: 'cuts spins', method: 'instrument a session', falsifiableSignal: 'spins unchanged' },
    sourceIdeaIds: ['idea-1', 'idea-2'],
    addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
    ...over,
  };
}

describe('improvementBody', () => {
  it('composes the structured proposal fields into a readable body', () => {
    const body = improvementBody(proposal());
    expect(body).toContain('no prior plan treats a block');
    expect(body).toContain('**Mechanism:**');
    expect(body).toContain('**The bet:**');
    expect(body).toContain('Cheap experiment (D-006)');
    expect(body).toContain('Falsified if: spins unchanged');
    expect(body).toContain('Source ideas: idea-1, idea-2');
  });

  it('folds the independent consult disposition + critique into the routed artifact body', () => {
    const body = improvementBody(
      proposal({
        consultation: {
          originCycleId: 'cycle-1',
          originalProposalId: 'prop-1',
          conversationId: 'conv-1',
          status: 'answered',
          state: 'closed_answered',
          verdict: 'routed',
          reviewerId: 'reviewer-1',
          feedback: 'Bound the first rollout to one workspace and measure rollback latency.',
        },
      }),
    );
    expect(body).toContain('Independent Blender consult (answered)');
    expect(body).toContain('conv-1');
    expect(body).toContain('Consult feedback folded into this route');
    expect(body).toContain('measure rollback latency');
  });
});

describe('buildCapturePort', () => {
  it('files via captureImprovement as the Queen and returns the new issue id', async () => {
    const fake = vi.fn(
      async (_input: CaptureImprovementInput): Promise<CaptureImprovementResult> => ({
        ok: true,
        created: true,
        kind: 'change',
        issue: { id: 'EI-42' } as never,
        topics: [],
        possibleDuplicates: [],
      }),
    );
    const port = buildCapturePort({}, fake);
    const res = await port({ proposal: proposal() });

    expect(res).toEqual({ id: 'EI-42', created: true });
    const input = fake.mock.calls[0][0];
    // D-033 (learning-loop-identity-and-consumption-2026-08-08 P-008): Scout's port
    // declines on the SOFT band, unlike the agent-facing default. Measured: 407 of
    // 507 open Scout-minted items had a soft-band open sibling. Owner constraint
    // D-004 holds by construction — only THIS port opts in; if that stops being
    // true, the guard below fails.
    expect(input.semanticBlockBand).toBe('soft');
    expect(input.sourceRole).toBe('Scout'); // artifact-side provenance stamp (improvement-source:Scout); the Queen still gates (D-010)
    expect(input.kind).toBe('change');
    expect(input.scope).toBe('operator');
  });

  it('on a coalesced burst, attributes to the EXISTING item (created:false — the surviving non-create path, P-002)', async () => {
    const fake = vi.fn(
      async (_input: CaptureImprovementInput): Promise<CaptureImprovementResult> => ({
        ok: true,
        created: false,
        reason: 'coalesced',
        possibleDuplicates: [{ id: 'EI-7', title: 'dup', state: 'open', severity: 'minor', similarity: 0.9 }],
      }),
    );
    const port = buildCapturePort({}, fake);
    const res = await port({ proposal: proposal() });
    expect(res).toEqual({ id: 'EI-7', created: false });
  });

  it('passes synthetic drill provenance through without changing the default Scout path', async () => {
    const fake = vi.fn(
      async (_input: CaptureImprovementInput): Promise<CaptureImprovementResult> => ({
        ok: true,
        created: true,
        kind: 'change',
        issue: { id: 'EI-drill' } as never,
        topics: [],
        possibleDuplicates: [],
      }),
    );
    const port = buildCapturePort({ origin: 'drill', foundDuring: 'blender-drill:123' }, fake);
    await port({ proposal: proposal() });

    expect(fake.mock.calls[0][0]).toMatchObject({
      origin: 'drill',
      foundDuring: 'blender-drill:123',
    });
  });
});

describe('buildPlansNewPort', () => {
  it('shapes the proposal into a draft-plan create call and passes the slug stem through', async () => {
    const create = vi.fn<PlanDraftCreator>(async (args) => ({ slug: `${args.slug}-2026-06-08` }));
    const port = buildPlansNewPort(create);
    const res = await port({ proposal: proposal(), slugStem: 'scout-wake-on-grant' });

    expect(res.slug).toBe('scout-wake-on-grant-2026-06-08');
    const arg = create.mock.calls[0][0];
    expect(arg.slug).toBe('scout-wake-on-grant');
    expect(arg.title).toBe('Wake-on-grant for blocked edits');
    expect(arg.rationale).toContain('Scout-generated');
    expect(arg.rationale).toContain('idea-1, idea-2');
  });
});

describe('buildGoalAmendmentDispatchPort', () => {
  it('maps a targeted proposal onto goals:update without silently changing title or bounds', async () => {
    const dispatch = vi.fn<GoalUpdateDispatcher>(async () => ({ data: { id: 'goal-existing' } }));
    const port = buildGoalAmendmentDispatchPort(
      { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
      dispatch,
    );

    await expect(
      port({ proposal: proposal({ targetGoalId: 'goal-existing' }), targetGoalId: 'goal-existing' }),
    ).resolves.toEqual({ goalId: 'goal-existing' });

    const [args, scope] = dispatch.mock.calls[0];
    expect(args.id).toBe('goal-existing');
    expect(args.body).toContain('**Mechanism:**');
    expect(args.body).toContain('Cheap experiment (D-006)');
    expect(args.reason).toContain('Scout proposal prop-1');
    expect(Object.keys(args).sort()).toEqual(['body', 'id', 'reason']);
    expect(scope).toEqual({ harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' });
  });
});

describe('buildGoalDispatchPort', () => {
  it('forwards the explicit workspace to autoStartGoal instead of relying on ambient scope', async () => {
    autoStartGoal.mockClear();
    const port = buildGoalDispatchPort({ harnessSlug: 'papercusp-workspace', workspaceId: 'ws-scout-real' });
    const input = {
      proposal: proposal({ id: 'prop-goal' }),
      title: 'Workspace-scoped goal',
      killCriterion: 'no verified outcome',
      budgetCents: 2_000,
    };

    await expect(port(input)).resolves.toEqual({ goalId: 'goal-auto' });
    expect(autoStartGoal).toHaveBeenCalledWith(expect.objectContaining({
      harnessSlug: 'papercusp-workspace',
      workspaceId: 'ws-scout-real',
      title: input.title,
      killCriterion: input.killCriterion,
      budgetCents: input.budgetCents,
      proposalId: 'prop-goal',
    }));
  });
});

describe('buildGymDispatchPort', () => {
  it('delegates to seedDistantNiches against the injected archive (empty archive → opens niches)', async () => {
    const seeded: { coords: unknown }[] = [];
    const archive: ArchivePort = {
      listElites: () => [] as ArchiveEliteView[],
      seed: (entry) => {
        seeded.push({ coords: entry.descriptor.coords });
        return { admitted: true, nicheKey: `niche-${seeded.length}` };
      },
    };
    const port = buildGymDispatchPort(archive);
    const res = await port([
      { id: 'prop-1', text: 'idea a' },
      { id: 'prop-2', text: 'idea b' },
    ]);
    // Empty archive ⇒ every seed lands in an open niche (noveltyDistance = Infinity).
    expect(res.newNiches).toHaveLength(2);
    expect(res.seeded.map((s) => s.ideaId)).toEqual(['prop-1', 'prop-2']);
    expect(res.seeded.every((s) => s.admitted)).toBe(true);
  });
});
