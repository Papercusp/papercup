/**
 * blender:goal-drafts (plan blender-goal-amendment-rail-2026-08-19 P-002).
 *
 * Pins the two properties that make this read surface honest rather than merely
 * present — both of them D-012 consequences, and both of them the kind of thing that
 * degrades silently:
 *
 *  1. AN EMPTY QUEUE EXPLAINS ITSELF. Empty is the MEASURED normal state (0 of 106
 *     proposals ever asked for the goal rail), so a bare `[]` invites a reader to
 *     conclude the read failed or the rail is blocked. The result must carry `empty`
 *     with the reason, and must NOT carry it when there are drafts.
 *
 *  2. MARKER PROVENANCE IS NEVER DROPPED. The one draft in the live corpus is a
 *     vocabulary artifact; a view that showed it without its trigger word would present
 *     it as a genuine goal-scale ask. So `markerHits` survives excerpting, and a draft
 *     whose markers are ALL code-span matches is flagged at the row.
 *
 * The queue itself is mocked — its selection semantics are pinned by
 * goal-draft-queue.test.ts (fakes) and goal-draft-queue.integration.test.ts (real PG,
 * real production bytes). This file is about the VIEW.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GoalDraft } from '../../scout/goal-draft-queue';
import { readGoalDraftQueue } from '../../scout/goal-draft-queue';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { goalDraftsArgs, runGoalDrafts, toGoalDraftView } from './goal-drafts';

vi.mock('../../scout/goal-draft-queue');
vi.mock('../../workspace-registry');

const mockRead = vi.mocked(readGoalDraftQueue);
const mockWs = vi.mocked(resolveConcreteWorkspaceId);

/** A draft shaped like the live SP-001 false positive: one marker, in `mechanism`
 *  only, every occurrence inside a quoted SQL value. */
function incidentalDraft(over: Partial<GoalDraft> = {}): GoalDraft {
  return {
    cycleId: 'scout-1786878027729',
    createdAt: new Date('2026-08-16T11:03:51.848Z'),
    path: 'override',
    askedRail: null,
    matchedMarkers: ['goal mode'],
    markerHits: [{ marker: 'goal mode', fields: ['mechanism'], onlyInCodeSpan: true }],
    title: 'Policy enforcement changes that should take seconds',
    proposal: {
      id: 'SP-001',
      routeHint: 'plan',
      framing: 'x'.repeat(900),
      mechanism: "INSERT INTO tool_policies (reason='goal mode: delegate')",
    } as unknown as GoalDraft['proposal'],
    killCriterion: 'Kill this goal if a policy table already exists under a different name',
    budgetCents: 20000,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWs.mockReturnValue('papercusp-workspace');
});

describe('blender:goal-drafts', () => {
  it('EMPTY is explained, not just returned', async () => {
    mockRead.mockResolvedValue([]);
    const out = await runGoalDrafts({});

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.drafts).toEqual([]);
    expect(out.summary.total).toBe(0);
    // The whole point: a caller must not be able to read this as a fault.
    expect(out.empty).toBeDefined();
    expect(out.empty!.meaning).toContain('MEASURED pre-D-016 corpus state');
    expect(out.empty!.meaning).toContain('New direct goal hints route live');
    expect(out.empty!.meaning).toContain('not evidence that the current rail is blocked');
    expect(out.empty!.reason).toContain('30 cycle');
  });

  it('does NOT claim emptiness when drafts exist', async () => {
    // The falsifier for the test above — otherwise `empty` could be unconditional
    // and both assertions would still look green.
    mockRead.mockResolvedValue([incidentalDraft()]);
    const out = await runGoalDrafts({});

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.empty).toBeUndefined();
    expect(out.summary).toMatchObject({ total: 1, asked: 0, override: 1 });
  });

  it('flags a draft whose markers are ALL code-span matches (the D-012 shape)', async () => {
    mockRead.mockResolvedValue([incidentalDraft()]);
    const out = await runGoalDrafts({ includeCodeSpanMatches: true });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [d] = out.drafts;
    expect(d!.incidentalMatchOnly).toBe(true);
    expect(out.summary.incidentalMatchOnly).toBe(1);
  });

  it('does NOT flag a draft with a genuine prose match', async () => {
    mockRead.mockResolvedValue([
      incidentalDraft({
        matchedMarkers: ['multi-plan'],
        markerHits: [{ marker: 'multi-plan', fields: ['framing'], onlyInCodeSpan: false }],
      }),
    ]);
    const out = await runGoalDrafts({});

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.drafts[0]!.incidentalMatchOnly).toBeUndefined();
    expect(out.summary.incidentalMatchOnly).toBe(0);
  });

  it('excerpts prose in summary mode but NEVER drops marker provenance', async () => {
    const draft = incidentalDraft();
    const view = toGoalDraftView(draft, 'summary');

    const p = view.proposal as Record<string, string>;
    expect(p.framing!.length).toBeLessThan(900);
    expect(p.framing!.endsWith('…')).toBe(true);
    // D-012 binding: the trigger word survives the excerpt. A view that excerpted
    // this away would present a vocabulary artifact as a real goal-scale ask.
    expect(view.matchedMarkers).toEqual(['goal mode']);
    expect(view.markerHits).toEqual(draft.markerHits);

    // full mode hands back the proposal untouched.
    expect(toGoalDraftView(draft, 'full').proposal).toBe(draft.proposal);
  });

  it('marks artifact proposal/source ids as an unroutable pending draft, never a grade key', () => {
    const draft = incidentalDraft({
      proposal: {
        id: 'SP-mt428ji9-003',
        sourceIdeaIds: ['scout-idea-a', 'scout-idea-b'],
        routeHint: 'plan',
        framing: 'A historical goal-scale proposal',
        mechanism: 'Do the work',
      } as unknown as GoalDraft['proposal'],
    });

    const view = toGoalDraftView(draft, 'summary');

    expect(view.gradeability).toMatchObject({
      state: 'unroutable-pending-draft',
      gradeable: false,
      routedIdeaId: null,
      artifactProposalId: 'SP-mt428ji9-003',
      sourceIdeaIds: ['scout-idea-a', 'scout-idea-b'],
    });
    expect(view.gradeability.reason).toContain('do not pass them to blender:grade-idea');
    expect(view.gradeability.reason).toContain('improvements:triage');
  });

  it('passes the caller bounds through to the queue read', async () => {
    mockRead.mockResolvedValue([]);
    await runGoalDrafts({ limit: 5, includeCodeSpanMatches: true });

    expect(mockRead).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, includeCodeSpanMatches: true }),
    );
    // cyclesScanned reports what was actually asked for, not a hardcoded default.
    const out = await runGoalDrafts({ limit: 5 });
    expect(out.ok && out.summary.cyclesScanned).toBe(5);
  });

  it('reports a read failure as ok:false rather than throwing', async () => {
    mockRead.mockRejectedValue(new Error('pg exploded'));
    const out = await runGoalDrafts({});
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain('pg exploded');
  });

  it('args schema is strict and bounds limit', () => {
    expect(goalDraftsArgs.safeParse({}).success).toBe(true);
    expect(goalDraftsArgs.safeParse({ limit: 0 }).success).toBe(false);
    expect(goalDraftsArgs.safeParse({ limit: 201 }).success).toBe(false);
    expect(goalDraftsArgs.safeParse({ detail: 'partial' }).success).toBe(false);
    expect(goalDraftsArgs.safeParse({ nope: 1 }).success).toBe(false);
  });
});
