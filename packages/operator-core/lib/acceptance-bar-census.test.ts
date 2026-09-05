import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_BAR_CENSUS_QUERY,
  buildAcceptanceBarCensusReport,
  type AcceptanceBarCensusRow,
} from './acceptance-bar-census';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';

const rubric = () => {
  const content = `---\ntitle: Ready covered\nslug: ready-covered\nstatus: ready\n---\n\n## Requirements\n\n**R-1 — Outcome.** The outcome is true.\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n\n## Phase 1\n\n- **P-001** \`todo\` implement outcome\n`;
  const built = buildAcceptanceBarSeed({
    planSlug: 'ready-covered',
    planContent: content,
    actorId: 'seed',
    declaredAt: '2026-09-04T00:00:00.000Z',
    cohort: 'legacy-backfilled',
    adoptionEpoch: 1,
    subjectPlanRevision: 1,
    rubricSlug: 'acceptance-ready-covered',
    rubricRevision: 1,
  });
  if (!built.ok) throw new Error(built.message);
  return built.templateData;
};

const row = (overrides: Partial<AcceptanceBarCensusRow> = {}): AcceptanceBarCensusRow => ({
  plan_slug: 'ready-covered',
  title: 'Ready covered',
  status: 'ready',
  archived: false,
  is_legacy: false,
  template: null,
  template_slug: null,
  content: '## Requirements\n\n**R-1 — Outcome.** The outcome is true.',
  acceptance_bar_epoch: 1,
  acceptance_bar_cohort: 'legacy-backfilled',
  acceptance_bar_set_hash: 'b'.repeat(64),
  acceptance_bar_rubric_slug: 'acceptance-ready-covered',
  acceptance_bar_rubric_revision: 1,
  rubric_template_data: rubric(),
  mapped_bar_keys: ['R-1'],
  ...overrides,
});

describe('P-009 acceptance BAR census', () => {
  it('keeps heading adoption separate from executable BAR coverage and names residuals', () => {
    const report = buildAcceptanceBarCensusReport([
      row(),
      row({ plan_slug: 'ready-unseeded', title: 'Ready unseeded', acceptance_bar_epoch: null, acceptance_bar_cohort: null, acceptance_bar_set_hash: null, acceptance_bar_rubric_slug: null, acceptance_bar_rubric_revision: null, rubric_template_data: null, mapped_bar_keys: [] }),
      row({ plan_slug: 'investigation', title: 'Investigation', content: '## Investigation\n\nExplore the problem.' }),
      row({ plan_slug: 'archived', archived: true }),
      row({ plan_slug: 'legacy', is_legacy: true }),
      row({ plan_slug: 'rubric', template: 'rubric' }),
    ], { workspaceId: 'ws', harnessSlug: 'harness', measuredAt: new Date('2026-09-05T00:00:00.000Z') });

    expect(report).toMatchObject({
      schemaVersion: 1,
      measuredAt: '2026-09-05T00:00:00.000Z',
      requirementsAdoption: { numerator: 2, denominator: 3, percent: 66.67 },
      barCoverage: { numerator: 1, denominator: 2, percent: 50 },
      exclusions: { archived: 1, legacy: 1, rubricOrInstance: 1, investigation: 1 },
      residuals: [{ planSlug: 'ready-unseeded', reasons: expect.arrayContaining(['bar_epoch_missing', 'rubric_missing_or_unreadable']) }],
    });
  });

  it('emits the reproducible query and explicit live-status parameters', () => {
    const report = buildAcceptanceBarCensusReport([], { workspaceId: 'ws', harnessSlug: 'harness' });
    expect(report.query).toBe(ACCEPTANCE_BAR_CENSUS_QUERY);
    expect(report.query).toContain('acceptance_bar_epoch');
    expect(report.parameters.liveStatuses).toEqual(['ready', 'active', 'awaiting-acceptance']);
    expect(report.barCoverage).toEqual({ numerator: 0, denominator: 0, percent: 0 });
  });
});
