import { describe, it, expect, vi } from 'vitest';

import gradeIdeaTool, {
  deriveGradedBy,
  gradeIdeaArgs,
  runGradeIdea,
  toToolResult,
  type GradeIdeaDeps,
  type GradedIdeaSummary,
} from '../grade-idea';

/**
 * scout-idea-grading-2026-06-12 B-03 / P-003 — the C-3 tool over the C-2 seam,
 * exercised with FAKE PG deps (gym-tools pattern: no database). Pins the three
 * contract behaviors: role-derived attribution, arg validation (incl. the D-007
 * exactly-one key rule), and C-2 result pass-through (owner-grade-sovereign).
 */

const summary = (over: Partial<GradedIdeaSummary> = {}): GradedIdeaSummary => ({
  ideaId: 'idea-1',
  lens: 'inversion',
  rail: 'plan',
  routedRef: 'plan:some-plan-2026-06-12',
  title: 'Some idea',
  routedAt: '2026-06-12T00:00:00.000Z',
  humanGrade: 4,
  humanFeedback: 'sharp',
  gradedBy: 'owner',
  gradedAt: '2026-06-12T01:00:00.000Z',
  ...over,
});

function fakeDeps(over: Partial<GradeIdeaDeps> = {}): GradeIdeaDeps {
  return {
    gradeRoutedIdea: vi.fn(async () => ({ applied: true })),
    resolveIdeaIdFromRef: vi.fn(async () => 'idea-1'),
    readIdeaSummary: vi.fn(async () => summary()),
    ...over,
  };
}

describe('deriveGradedBy (C-3: attribution from caller, never args)', () => {
  it("maps the Queen's spawn ctx to 'Queen'", () => {
    expect(deriveGradedBy({ role: 'mug' })).toBe('Queen');
  });

  it("maps every owner surface (no role / superuser proxy / other agent roles) to 'owner'", () => {
    expect(deriveGradedBy(undefined)).toBe('owner');
    expect(deriveGradedBy({})).toBe('owner');
    expect(deriveGradedBy({ role: 'operator' })).toBe('owner');
    expect(deriveGradedBy({ role: 'worker' })).toBe('owner');
  });
});

describe('gradeIdeaArgs validation', () => {
  it('accepts ideaId-keyed and routedRef-keyed calls', () => {
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 4 }).success).toBe(true);
    expect(gradeIdeaArgs.safeParse({ routedRef: 'wi:42', grade: 1, feedback: 'meh' }).success).toBe(true);
  });

  it('rejects both keys and neither key (D-007 exactly-one rule)', () => {
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', routedRef: 'wi:42', grade: 3 }).success).toBe(false);
    expect(gradeIdeaArgs.safeParse({ grade: 3 }).success).toBe(false);
  });

  it('rejects out-of-range and non-integer grades', () => {
    for (const grade of [0, 6, 3.5, -1]) {
      expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade }).success).toBe(false);
    }
  });

  it('rejects empty ideaId; accepts any-length feedback (softText — clamped in the handler, EI-3693)', () => {
    expect(gradeIdeaArgs.safeParse({ ideaId: '', grade: 3 }).success).toBe(false);
    // feedback is now softText(LIMITS.ANNOTATION): the SCHEMA never bounces on length —
    // an over-long value parses fine and runGradeIdea truncates it to 2000 (clampText),
    // rather than rejecting the whole tool call at arg-parse.
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 3, feedback: 'x'.repeat(2001) }).success).toBe(true);
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 3, feedback: 'x'.repeat(2000) }).success).toBe(true);
  });
});

describe('runGradeIdea', () => {
  it("writes through C-2 with gradedBy 'Queen' for a queen ctx and returns the read-back summary", async () => {
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => summary({ humanGrade: 5, gradedBy: 'Queen', humanFeedback: 'love it' })),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 5, feedback: 'love it' }, { role: 'mug' }, deps);

    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({
      ideaId: 'idea-1',
      grade: 5,
      feedback: 'love it',
      gradedBy: 'Queen',
    });
    expect(out.applied).toBe(true);
    expect(out.gradedBy).toBe('Queen');
    expect(out.ideaId).toBe('idea-1');
    expect(out.idea?.humanGrade).toBe(5);
    // the resolver is never consulted on the ideaId path
    expect(deps.resolveIdeaIdFromRef).not.toHaveBeenCalled();
  });

  it("writes gradedBy 'owner' for the UI/superuser surface (no agent role)", async () => {
    const deps = fakeDeps();
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 2 }, undefined, deps);
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith({ ideaId: 'idea-1', grade: 2, gradedBy: 'owner' });
    expect(out.gradedBy).toBe('owner');
  });

  it('omits the feedback key entirely when not supplied (a regrade without feedback clears it in C-2)', async () => {
    const deps = fakeDeps();
    await runGradeIdea({ ideaId: 'idea-1', grade: 3 }, undefined, deps);
    const input = vi.mocked(deps.gradeRoutedIdea).mock.calls[0][0];
    expect('feedback' in input).toBe(false);
  });

  it('clamps over-long feedback to 2000 chars before the C-2 write (softText handler clamp, EI-3693)', async () => {
    const deps = fakeDeps();
    await runGradeIdea({ ideaId: 'idea-1', grade: 3, feedback: 'x'.repeat(2500) }, undefined, deps);
    const input = vi.mocked(deps.gradeRoutedIdea).mock.calls[0][0] as { feedback?: string };
    expect(input.feedback).toHaveLength(2000);
  });

  it('resolves routedRef → ideaId before the write (D-007)', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromRef: vi.fn(async () => 'idea-9') });
    const out = await runGradeIdea({ routedRef: 'plan:x-2026-06-12', grade: 4 }, { role: 'mug' }, deps);
    expect(deps.resolveIdeaIdFromRef).toHaveBeenCalledWith('plan:x-2026-06-12');
    expect(deps.gradeRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ ideaId: 'idea-9' }));
    expect(out.ideaId).toBe('idea-9');
  });

  it('returns not-found without touching the seam when a routedRef resolves to nothing', async () => {
    const deps = fakeDeps({ resolveIdeaIdFromRef: vi.fn(async () => null) });
    const out = await runGradeIdea({ routedRef: 'wi:nope', grade: 4 }, undefined, deps);
    expect(out).toEqual({ applied: false, reason: 'not-found', gradedBy: 'owner', ideaId: null, idea: null });
    expect(deps.gradeRoutedIdea).not.toHaveBeenCalled();
  });

  it('passes the owner-grade-sovereign no-op through untouched, with the standing owner grade in the summary (D-004)', async () => {
    const deps = fakeDeps({
      gradeRoutedIdea: vi.fn(async () => ({ applied: false as const, reason: 'owner-grade-sovereign' as const })),
      readIdeaSummary: vi.fn(async () => summary({ humanGrade: 2, gradedBy: 'owner', humanFeedback: 'not this' })),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 5 }, { role: 'mug' }, deps);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('owner-grade-sovereign');
    expect(out.gradedBy).toBe('Queen'); // what THIS call graded as
    expect(out.idea?.gradedBy).toBe('owner'); // ...and the grade that stood
    expect(out.idea?.humanGrade).toBe(2);
  });

  it("passes the seam's not-found through (ideaId-keyed miss)", async () => {
    const deps = fakeDeps({
      gradeRoutedIdea: vi.fn(async () => ({ applied: false as const, reason: 'not-found' as const })),
      readIdeaSummary: vi.fn(async () => null),
    });
    const out = await runGradeIdea({ ideaId: 'ghost', grade: 1 }, undefined, deps);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('not-found');
    expect(out.idea).toBeNull();
  });

  it('synthesizes the summary from the write inputs when the read-back throws after an applied write', async () => {
    const deps = fakeDeps({
      readIdeaSummary: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const out = await runGradeIdea({ ideaId: 'idea-1', grade: 4, feedback: 'good' }, undefined, deps);
    expect(out.applied).toBe(true);
    expect(out.idea).toMatchObject({ ideaId: 'idea-1', humanGrade: 4, humanFeedback: 'good', gradedBy: 'owner' });
  });
});

describe('toToolResult envelope', () => {
  const base = { applied: true, gradedBy: 'owner' as const, ideaId: 'i1', idea: null };

  it('is not an error for applied writes nor for the sovereign no-op', () => {
    expect(toToolResult(base).isError).toBeUndefined();
    expect(
      toToolResult({ ...base, applied: false, reason: 'owner-grade-sovereign' }).isError,
    ).toBeUndefined();
  });

  it('flags not-found as an error', () => {
    const res = toToolResult({ ...base, applied: false, ideaId: null, reason: 'not-found' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).reason).toBe('not-found');
  });
});

describe('tool registration (C-3 surface)', () => {
  it('is reachable through the unified projection registry (the admin route/tool proxy dispatch path)', async () => {
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');
    const projected = lookupByMcpName('blender:grade-idea');
    expect(projected, 'blender:grade-idea registered').toBeTruthy();
  });

  it('registers as blender:grade-idea with the SU+Queen allowlist and derived-attribution args', () => {
    const tool = gradeIdeaTool as unknown as {
      name: string;
      agentRoles?: string[];
      guidance?: { when?: string };
    };
    expect(tool.name).toBe('blender:grade-idea');
    expect(tool.agentRoles).toContain('mug');
    expect(tool.agentRoles).toContain('operator');
    // gradedBy is derived, never an arg (C-3)
    expect(gradeIdeaArgs.safeParse({ ideaId: 'i1', grade: 3, gradedBy: 'owner' }).success).toBe(true);
    const parsed = gradeIdeaArgs.parse({ ideaId: 'i1', grade: 3, gradedBy: 'owner' });
    expect('gradedBy' in parsed).toBe(false); // stripped, not honored
  });
});
