/**
 * Unit coverage for the plan-agent launch seed assembler
 * (plan-agent-launch-2026-05-21, P-009 / D-002).
 *
 * `assemblePlanContextBundleText` is pure — no FS, no PG — so the seed
 * structure is testable directly. The IO wrapper `buildPlanContextBundle`
 * (FS plan read + `plan_revisions` query) is exercised live in
 * P-027 / P-028.
 */

import { describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn(), history: vi.fn() }));
vi.mock('../source', async (original) => ({
  ...(await original<typeof import('../source')>()),
  readPlanBySlug: io.read,
  resolvePlanScope: async () => ({ workspaceId: 'ws-history', harnessSlug: 'papercusp' }),
}));
vi.mock('../revisions', async (original) => ({
  ...(await original<typeof import('../revisions')>()),
  listPlanRevisions: async () => [],
}));
vi.mock('../../../prior-attempt-context', async (original) => ({
  ...(await original<typeof import('../../../prior-attempt-context')>()),
  readPlanHistoryContext: io.history,
}));
import { assemblePlanContextBundleText, buildPlanContextBundle, type PlanBundleRationale } from '../context-bundle';

const RATIONALE_A: PlanBundleRationale = {
  seq: 2,
  createdAt: Date.UTC(2026, 4, 21),
  authorKind: 'agent',
  rationale: 'Renamed the verb to avoid the namespace collision.',
};
const RATIONALE_B: PlanBundleRationale = {
  seq: 1,
  createdAt: Date.UTC(2026, 4, 20),
  authorKind: 'human',
  rationale: 'Initial plan.',
};

describe('assemblePlanContextBundleText', () => {
  it('delivers child history in the actual launch bundle', async () => {
    io.read.mockResolvedValue({
      parsed: { frontmatter: { title: 'History plan' }, raw: '# Plan authority' },
      row: { status: 'active', harnessSlug: 'papercusp' },
      archived: false,
    });
    const history = {
      status: 'available',
      brief: {
        fingerprint: 'child-generation',
        attempts: [{ rawRef: 'WI-1#checkpoint', text: 'Root cause: child cursor advanced early.' }],
      },
      recovery: { tool: 'plans:get', args: { slug: 'history', harness: 'papercusp', heading: 'History' } },
    };
    io.history.mockResolvedValue(history);
    const bundle = await buildPlanContextBundle('history', { harnessSlug: 'papercusp' });
    expect(bundle?.text).toContain('child cursor advanced early');
    expect(bundle?.text).toContain('child-generation');
    expect(bundle?.text).toContain('WI-1#checkpoint');
    expect(bundle?.history).toEqual(history);
    expect(io.history).toHaveBeenCalledWith('history', 'papercusp');
  });
  it('includes the framing preamble, the plan doc, and the rationale digest', () => {
    const text = assemblePlanContextBundleText({
      title: 'A Test Plan',
      slug: 'a-test-plan-2026-05-21',
      status: 'active',
      planMarkdown: '# A Test Plan\n\n## Now\n\nState: starting.',
      rationales: [RATIONALE_A, RATIONALE_B],
    });
    // Preamble — the agent is told what it is and to read `## Now`.
    expect(text).toContain('launched to advance a plan');
    expect(text).toContain('`## Now`');
    // The plan doc, verbatim.
    expect(text).toContain('# A Test Plan\n\n## Now\n\nState: starting.');
    // The header line.
    expect(text).toContain('slug: a-test-plan-2026-05-21   ·   status: active');
    // Both rationales, as digest entries.
    expect(text).toContain('· rev 2 — 2026-05-21 — agent');
    expect(text).toContain('Renamed the verb to avoid the namespace collision.');
    expect(text).toContain('· rev 1 — 2026-05-20 — human');
  });

  it('preserves the caller-supplied (newest-first) rationale order', () => {
    const text = assemblePlanContextBundleText({
      title: 'P',
      slug: 'p',
      status: 'active',
      planMarkdown: '# P',
      rationales: [RATIONALE_A, RATIONALE_B],
    });
    expect(text.indexOf('· rev 2')).toBeLessThan(text.indexOf('· rev 1'));
  });

  it('shows an explicit empty-state when no revision recorded a rationale', () => {
    const text = assemblePlanContextBundleText({
      title: 'Fresh Plan',
      slug: 'fresh-plan',
      status: 'draft',
      planMarkdown: '# Fresh Plan',
      rationales: [],
    });
    expect(text).toContain('No revision rationales have been recorded for this plan yet.');
    expect(text).not.toContain('· rev');
  });

  it('warns inline when the plan being launched is superseded', () => {
    const text = assemblePlanContextBundleText({
      title: 'Old Plan',
      slug: 'old-plan',
      status: 'superseded',
      planMarkdown: '# Old Plan',
      rationales: [],
    });
    expect(text).toContain('status: superseded');
    expect(text).toContain('⚠ This plan is superseded');
  });

  it('defaults a null status to draft, with no superseded warning', () => {
    const text = assemblePlanContextBundleText({
      title: 'Untyped',
      slug: 'untyped',
      status: null,
      planMarkdown: '# Untyped',
      rationales: [],
    });
    // 'unknown' status was retired in favor of 'draft' (commit 471f4695);
    // a null status now renders as the draft default.
    expect(text).toContain('status: draft');
    expect(text).not.toContain('⚠ This plan is superseded');
  });

  it('indents every line of a multi-line rationale under its entry header', () => {
    const text = assemblePlanContextBundleText({
      title: 'P',
      slug: 'p',
      status: 'active',
      planMarkdown: '# P',
      rationales: [
        {
          seq: 3,
          createdAt: Date.UTC(2026, 4, 21),
          authorKind: 'agent',
          rationale: 'First line of the why.\nSecond line of the why.',
        },
      ],
    });
    expect(text).toContain('· rev 3 — 2026-05-21 — agent\n    First line of the why.\n    Second line of the why.');
  });
});
