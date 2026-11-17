/**
 * plans:new parse admission (EI-22005620513894909).
 *
 * A body with item-looking but non-canonical lines must be rejected before
 * withPlanLock. Otherwise plans:new reports success while plans:start later
 * discovers that zero items were parsed and promoted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WithPlanLockResult } from './with-plan-lock';
import { buildCampaignPlan } from '../../code-cleanup/campaign-plan';
import type { TriageBatch } from '../../code-cleanup/triage';

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'papercusp') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string | undefined, ctx: unknown) => ctx,
}));
// The plan index the similar-plan check reads. Empty by default (and reset before each
// test); a test that needs an overlapping plan puts a row here.
const planIndex = vi.hoisted(() => ({
  rows: [] as Array<{ planSlug: string; title: string; status: string; archived: boolean }>,
}));
vi.mock('./source', () => ({
  listPlanIndexRows: vi.fn(async () => planIndex.rows),
  // plans:new resolves the pot scope for its authority/profile reads; keep it PG-free.
  resolvePlanScope: vi.fn(async (o?: { workspaceId?: string; harnessSlug?: string }) => ({
    workspaceId: o?.workspaceId ?? 'default',
    harnessSlug: o?.harnessSlug ?? 'papercusp',
  })),
}));
vi.mock('./revisions', () => ({
  planRevisionCapture: vi.fn(() => ({ recorded: { current: null }, afterWrite: vi.fn() })),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../../harness/usage-emitters', () => ({ emitPlanAuthored: vi.fn(async () => {}) }));
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
  stampPlanGoalProvenance: vi.fn(async () => null),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => {
    throw new Error('no transport identity in unit test');
  }),
}));

const appliedResult = (): WithPlanLockResult<{ ok: true; slug: string }> => ({
  kind: 'applied',
  value: { ok: true, slug: 'parse-admission-2026-09-05' },
  filePath: 'x',
  version: 1,
  scope: { workspaceId: 'default', harnessSlug: 'papercusp' },
});

vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(async () => appliedResult()),
}));
// The cosine confirmation needs an embedder; with no verdict the token match stands.
vi.mock('./semantic-dedup', () => ({
  confirmSimilarPlans: vi.fn(async (_input: unknown, similar: unknown[]) => ({ verdict: false, kept: similar, dropped: [] })),
}));

const { withPlanLock } = await import('./with-plan-lock');
const withPlanLockM = vi.mocked(withPlanLock);
const { default: tool, validateAcceptanceBarAuthoring, ACCEPTANCE_BAR_SKELETON } = await import('./new');
const { PLAN_AUTHORING_CHECKLIST, PLAN_AUTHORING_CHECKLIST_DOC } = await import('./plan-authoring-checklist');

type Out = { content: { text: string }[]; isError?: boolean };
const call = (content: string, status?: string) =>
  tool.handler(
    {
      harness: 'papercusp',
      slug: 'parse-admission',
      title: 'Parse admission',
      force: true,
      rationale: 'Isolated parse-admission fixture; this test measures authoring checks independently of topic overlap.',
      ...(status ? { status } : {}),
      content,
    } as never,
    { metadata: vi.fn() } as never,
  ) as Promise<Out>;

beforeEach(() => {
  vi.clearAllMocks();
  withPlanLockM.mockResolvedValue(appliedResult());
  planIndex.rows = [];
});

describe('plans:new parse admission (EI-22005620513894909)', () => {
  it('rejects malformed item-looking lines before persistence', async () => {
    const out = await call('## Phase 1\n\n- P-001 todo this will not parse\n');

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();

    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      error: 'invalid_plan_content',
      reason: 'unparsed_item_lines',
      itemsParsed: 0,
      unparsedItemLines: 1,
    });
    expect(payload.parseFeedback).toMatchObject({
      itemsParsed: 0,
      unparsedItemLines: 1,
    });
    expect(payload.hint).toContain('plans:set-content');
  });

  it('still writes a canonical item body and returns parse feedback', async () => {
    const out = await call('## Phase 1\n\n- **P-001** `todo` this parses\n');

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      ok: true,
      itemsParsed: 1,
      items: [{ id: 'P-001', status: 'todo', text: 'this parses' }],
    });
    expect(payload.unparsedItemLines).toBeUndefined();
  });

  it('accepts a ready plan with an already-terminal item graph for post-create reconciliation', async () => {
    const out = await call('## Phase 1\n\n- **P-001** `done` already complete\n', 'ready');

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      ok: true,
      itemsParsed: 1,
      items: [{ id: 'P-001', status: 'done', text: 'already complete' }],
    });
  });

  it('refuses ordinary Requirements prose without an R-N BAR before persistence', async () => {
    const out = await call([
      '## Requirements',
      '',
      '- Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      'The exporter reads the customer table.',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      error: 'invalid_plan_content',
      reason: 'acceptance_bar_authoring',
    });
    expect(payload.acceptanceBar.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_requirement_parse_failed' })]),
    );
  });

  it('refuses Requirements without the activation BAR map before persistence', async () => {
    const out = await call([
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      'The exporter reads the customer table.',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      error: 'invalid_plan_content',
      reason: 'acceptance_bar_authoring',
      acceptanceBar: {
        requiredMapHeading: '### Bar-to-work map for this plan',
        requiredColumns: ['bar', 'implementing plan items', 'evidence plane'],
        allowedEvidencePlanes: ['tree', 'deployed', 'live'],
      },
    });
    expect(payload.acceptanceBar.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_mapping_missing' })]),
    );
  });

  it('accepts a complete Requirements + BAR map and persists once', async () => {
    const out = await call([
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      '### Bar-to-work map for this plan',
      '',
      '| bar | implementing plan items | evidence plane |',
      '|---|---|---|',
      '| R-1 | P-001 | tree |',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ ok: true, itemsParsed: 1 });
  });

  it('accepts generated campaign content with a complete Requirements + BAR map', async () => {
    const batch = (area: string, index: number, left: string, right: string): TriageBatch => ({
      area, index, score: 1, redundantMass: 100,
      families: [{
        id: `${area}-family`, score: 1, churn: 1, redundantMass: 100, packageDistance: 0,
        coChange: { minLinkScore: 0.5, files: 2, basis: 'file' },
        members: [{ path: left, line: 10, symbol: 'left' }, { path: right, line: 20, symbol: 'right' }],
      }],
    });
    const campaign = buildCampaignPlan({
      slug: 'cleanup-generated-campaign',
      batches: [batch('pkg/a', 0, 'pkg/a/left.ts', 'pkg/a/right.ts'), batch('pkg/b', 0, 'pkg/b/left.ts', 'pkg/b/right.ts')],
    });

    expect(campaign.content).toContain('## Requirements');
    expect(campaign.content).toContain('### Bar-to-work map for this plan');
    expect(campaign.content).toContain('| R-1 | P-001, P-002 | tree |');

    const out = await call(campaign.content);
    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      ok: true,
      itemsParsed: 2,
      items: [{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'todo' }],
    });
  });

  it('explains that a title-bearing bar cell must use a bare R-N key', async () => {
    const out = await call([
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      '### Bar-to-work map for this plan',
      '',
      '| bar | implementing plan items | evidence plane |',
      '|---|---|---|',
      '| R-1 Export data | P-001 | tree |',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload.acceptanceBar.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bar_mapping_invalid', barKey: 'R-1', detail: expect.stringContaining('bare R-1 key') }),
    ]));
    expect(payload.acceptanceBar.hint).toContain('| R-1 | P-001 | tree |');
  });

  it('documents the plans:start spec-triad prerequisite in guidance', () => {
    const guidance = (tool as { guidance: { when: string; chaining: string } }).guidance;
    expect(guidance.when).toContain('Requirements');
    expect(guidance.when).toContain('Design');
    expect(guidance.when).toContain('Bar-to-work map for this plan');
    // chaining is the compact ordering (trimmed for the tool prompt-weight budget);
    // the exact heading lives in `when`. It must still name the triad before plans:start.
    expect(guidance.chaining).toMatch(/R-N JSON \+ bar-to-work map \+ items → .*plans:start/);
  });
});

// EI-28712348345595435 — every authoring problem arrives in ONE refusal. Before this, each
// check returned as soon as it failed, so the author met the problems one per attempt and
// re-sent the whole plan body each time (measured: four calls to create one small draft).
describe('plans:new reports every problem in one refusal (EI-28712348345595435)', () => {
  /** Same as `call`, but WITHOUT force, so the similar-plan check runs. */
  const callUnforced = (content: string) =>
    tool.handler(
      { harness: 'papercusp', slug: 'parse-admission', title: 'Parse admission', content } as never,
      { metadata: vi.fn() } as never,
    ) as Promise<Out>;

  const SIMILAR_ROW = {
    planSlug: 'parse-admission-hardening-2026-09-01',
    title: 'Parse admission hardening',
    status: 'shipped',
    archived: false,
  };

  /** Requirements with no R-N records, a Design with no map: the two refusals that used to come one at a time. */
  const NO_RECORDS_NO_MAP = [
    '## Requirements',
    '',
    '- Every matching customer is exported exactly once.',
    '',
    '## Design',
    '',
    'The exporter reads the customer table.',
    '',
    '## Phase 1',
    '',
    '- **P-001** `todo` implement the exporter',
    '',
  ].join('\n');

  const VALID = [
    '## Requirements',
    '',
    '**R-1 — Export data.** Every matching customer is exported exactly once.',
    '',
    '## Design',
    '',
    '### Bar-to-work map for this plan',
    '',
    '| bar | implementing plan items | evidence plane |',
    '|---|---|---|',
    '| R-1 | P-001 | tree |',
    '',
    '## Phase 1',
    '',
    '- **P-001** `todo` implement the exporter',
    '',
  ].join('\n');

  const parse = (out: Out) => JSON.parse(out.content[0]!.text) as Record<string, any>;
  const checksOf = (payload: Record<string, any>) => (payload.problems as Array<{ check: string }>).map((p) => p.check);

  it('names the missing requirement records AND the missing map together', async () => {
    const out = await call(NO_RECORDS_NO_MAP);

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = parse(out);
    expect(payload).toMatchObject({ error: 'invalid_plan_content', reason: 'acceptance_bar_authoring', problemCount: 2 });
    // Both halves of the BAR contract, in one response — the second used to need a second attempt.
    expect(payload.problems).toEqual([
      expect.objectContaining({ check: 'acceptance-bar', code: 'bar_requirement_parse_failed' }),
      expect.objectContaining({ check: 'acceptance-bar', code: 'bar_mapping_missing' }),
    ]);
    expect(payload.acceptanceBar.problems).toHaveLength(2);
    expect(payload.message).toMatch(/^plans:new found 2 problems in one pass/);
  });

  it('reports a malformed item line and the acceptance-bar problems in the same refusal', async () => {
    const out = await call(NO_RECORDS_NO_MAP.replace('- **P-001** `todo` implement the exporter', '- P-001 todo this will not parse'));

    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = parse(out);
    // The first failing check still names the refusal, so existing matchers keep working...
    expect(payload).toMatchObject({ error: 'invalid_plan_content', reason: 'unparsed_item_lines', unparsedItemLines: 1 });
    // ...and the later checks are no longer held back for the next attempt.
    expect(new Set(checksOf(payload))).toEqual(new Set(['item-grammar', 'acceptance-bar']));
    expect(payload.parseFeedback).toMatchObject({ unparsedItemLines: 1 });
    expect(payload.acceptanceBar.problems.length).toBeGreaterThan(0);
  });

  it('delivers the similar-plan verdict with the authoring problems, not after them', async () => {
    planIndex.rows = [SIMILAR_ROW];

    const out = await callUnforced(NO_RECORDS_NO_MAP);

    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = parse(out);
    expect(payload).toMatchObject({ error: 'invalid_plan_content', reason: 'acceptance_bar_authoring', problemCount: 3 });
    expect(checksOf(payload)).toEqual(['acceptance-bar', 'acceptance-bar', 'similar-plans']);
    expect(payload.similarPlans).toMatchObject({
      similar: [expect.objectContaining({ slug: SIMILAR_ROW.planSlug })],
      cosineConfirm: { basis: 'unavailable' },
    });
    expect(payload.similarPlans.hint).toContain('force: true');
    // The problem line alone is enough to act on: it names the overlapping plan.
    expect(payload.problems[2].detail).toContain(SIMILAR_ROW.planSlug);
  });

  it('keeps the established shape when similar plans are the ONLY problem', async () => {
    planIndex.rows = [SIMILAR_ROW];

    const out = await callUnforced(VALID);

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = parse(out);
    expect(payload).toMatchObject({
      error: 'similar_exists',
      similar: [expect.objectContaining({ slug: SIMILAR_ROW.planSlug })],
      problemCount: 1,
    });
    expect(payload.hint).toContain('force: true');
    expect(payload).not.toHaveProperty('similarPlans');
    expect(payload).not.toHaveProperty('reason');
  });

  it('creates the plan when nothing is wrong — the unforced path is not a standing refusal', async () => {
    // Negative control for the two tests above: same unforced call, no overlapping plan.
    const out = await callUnforced(VALID);

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    const payload = parse(out);
    expect(payload).toMatchObject({ ok: true, itemsParsed: 1 });
    expect(payload).not.toHaveProperty('problems');
    expect(payload).not.toHaveProperty('authoringChecklist');
  });

  it('returns the authoring checklist with a refusal', async () => {
    const payload = parse(await call(NO_RECORDS_NO_MAP));

    expect(payload.authoringChecklist.lines).toEqual([...PLAN_AUTHORING_CHECKLIST]);
    expect(payload.authoringChecklist.lines).toHaveLength(12);
    expect(payload.authoringChecklist.doc).toBe(PLAN_AUTHORING_CHECKLIST_DOC);
    // It is advice, and says so: nothing in it is enforced by this tool.
    expect(payload.authoringChecklist.note).toContain('not a gate');
  });

  it('puts the problems ahead of the parsed-item echo, so a clipped payload keeps what matters', async () => {
    const text = (await call(NO_RECORDS_NO_MAP)).content[0]!.text;

    expect(text.indexOf('"problems"')).toBeGreaterThan(-1);
    expect(text.indexOf('"problems"')).toBeLessThan(text.indexOf('"authoringChecklist"'));
    expect(text.indexOf('"authoringChecklist"')).toBeLessThan(text.indexOf('"itemsParsed"'));
  });

  describe('validateAcceptanceBarAuthoring', () => {
    it('does not report a malformed record a second time through the map', () => {
      // `**R-1 Export data` has no dash and no closing period, so the record is malformed.
      // Its map row is fine; the map must not ALSO complain that R-1 has no Requirements record.
      const problems = validateAcceptanceBarAuthoring(VALID.replace('**R-1 — Export data.**', '**R-1 Export data**'));

      expect(problems.map((problem) => problem.code)).toEqual(['bar_requirement_parse_failed']);
    });

    it('still reports a map row for a requirement that was never authored', () => {
      const problems = validateAcceptanceBarAuthoring(VALID.replace('| R-1 | P-001 | tree |', '| R-1 | P-001 | tree |\n| R-9 | P-001 | tree |'));

      expect(problems).toEqual([expect.objectContaining({ code: 'bar_mapping_requirement_missing', barKey: 'R-9' })]);
    });

    it('is silent on a body with no Requirements section, and on a complete one', () => {
      expect(validateAcceptanceBarAuthoring('## Phase 1\n\n- **P-001** `todo` x\n')).toEqual([]);
      expect(validateAcceptanceBarAuthoring(VALID)).toEqual([]);
    });

    // EI-24791664511417016: the skeleton a refusal hands out must itself pass. A skeleton
    // that drifted from the validator would send every author who copied it into a second
    // refusal, which is the defect it exists to remove.
    it('accepts the skeleton it hands out', () => {
      expect(validateAcceptanceBarAuthoring(ACCEPTANCE_BAR_SKELETON)).toEqual([]);
    });
  });

  describe('the skeleton returned with an acceptance-bar refusal', () => {
    // The map is under Requirements, after the last record: the placement both
    // EI-24791664511417016 and EI-28712348345595435 report.
    const MAP_UNDER_REQUIREMENTS = [
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '### Bar-to-work map for this plan',
      '',
      '| bar | implementing plan items | evidence plane |',
      '|---|---|---|',
      '| R-1 | P-001 | tree |',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n');

    it('names the parent section and carries the skeleton on the first refusal', async () => {
      const out = await call(MAP_UNDER_REQUIREMENTS);

      expect(out.isError).toBe(true);
      expect(withPlanLockM).not.toHaveBeenCalled();
      const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
      expect(payload.acceptanceBar.requiredMapSection).toBe('## Design');
      expect(payload.acceptanceBar.skeleton).toBe(ACCEPTANCE_BAR_SKELETON);
      // The skeleton shows the placement the author got wrong: the map heading comes after
      // the `## Design` heading, never before it.
      const skeleton = payload.acceptanceBar.skeleton as string;
      expect(skeleton.indexOf('## Design')).toBeGreaterThan(-1);
      expect(skeleton.indexOf('## Design')).toBeLessThan(skeleton.indexOf(payload.acceptanceBar.requiredMapHeading));
    });

    it('is accepted by plans:new when sent back unchanged', async () => {
      const out = await call(ACCEPTANCE_BAR_SKELETON);

      expect(out.isError).toBeUndefined();
      expect(withPlanLockM).toHaveBeenCalledTimes(1);
      expect(JSON.parse(out.content[0]!.text)).toMatchObject({ ok: true, itemsParsed: 1 });
    });

    it('is absent from a refusal that has no acceptance-bar problem', async () => {
      const out = await call('## Phase 1\n\n- P-001 todo no bold id, no backticks\n');

      expect(out.isError).toBe(true);
      const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
      expect(payload).not.toHaveProperty('acceptanceBar');
    });
  });
});
