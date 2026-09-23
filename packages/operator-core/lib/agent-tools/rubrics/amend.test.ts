import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const rubricsMocks = vi.hoisted(() => ({
  amendRubric: vi.fn(),
  previewAcceptanceBarAmendment: vi.fn(),
  rubricCompleteness: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'amend-test' }) }));
vi.mock('../../rubrics', () => ({
  AMENDABLE_CRITERION_FIELDS: ['title', 'model', 'method', 'driftMarkers', 'replication'],
  amendRubric: rubricsMocks.amendRubric,
  previewAcceptanceBarAmendment: rubricsMocks.previewAcceptanceBarAmendment,
  rubricCompleteness: rubricsMocks.rubricCompleteness,
}));
vi.mock('../../rubrics-replication-sql', () => ({
  validateRubricReplicationSql: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../detached-imports', () => ({
  trackDetached: () => Promise.resolve({ notifySyncInvalidate: vi.fn() }),
}));

import amendTool, { rubricsAmendArgs } from './amend';

type ToolOutput = { content: Array<{ text: string }> };
const body = async (args: unknown) =>
  JSON.parse(((await amendTool.handler(args as never, {} as never)) as ToolOutput).content[0]!.text);

beforeEach(() => vi.clearAllMocks());

const criterion = {
  key: 'r-1',
  title: 'Outcome one',
  model: 'Outcome one remains true.',
  bar: 'Outcome one remains true.',
  method: 'Run the focused test.',
  driftMarkers: 'The focused test fails.',
  barKey: 'R-1',
  role: 'outcome' as const,
  mandatory: true,
  requiredScope: ['tree'],
  evidencePlane: 'tree' as const,
  passRatings: ['healthy'],
  check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-amendment.test.ts'] },
};

describe('rubrics:amend complete acceptance criteria input', () => {
  it('keeps the complete tool schema JSON-Schema-representable', () => {
    expect(() => z.toJSONSchema(amendTool.args as never)).not.toThrow();
  });

  it('publishes the structured/legacy alias equality contract before payload construction', () => {
    const schema = z.toJSONSchema(amendTool.args as never);
    const rendered = JSON.stringify(schema);

    expect(rendered).toContain('must match after canonical normalization');
    expect(rendered).toContain('`bar`/`model`');
    expect(rendered).toContain('`acceptance.condition`');
    expect(rendered).toContain('`requirement_alias_conflict`');
    expect(rendered).toContain('omit legacy aliases');
  });

  it('documents a writable-thread handoff for outside-lineage approval JSON', () => {
    const rendered = JSON.stringify({ description: amendTool.description, guidance: amendTool.guidance });

    expect(rendered).toContain('work_items:comment');
    expect(rendered).toContain('any existing writable thread');
    expect(rendered).toContain('workspace/id');
    expect(rendered).toMatch(/do not create a counter-sign work-item/i);
    expect(rendered).toContain("approvalRef:'thread-post:");
    expect(rendered).toContain('approve thread-post:<preview-post-id>');
    expect(rendered).toContain('immutable');
    expect(rendered).toContain('avoids hash transcription');
    expect(rendered).not.toContain('point the reviewer at THAT thread post');
  });

  it('accepts a full criterion set with structured checks', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [criterion],
      reason: 'Bind the runnable acceptance check.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.criteria?.[0]?.bar).toBe(criterion.bar);
  });

  it('rejects approval authorization without an amendment patch', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      approvalRef: 'thread-post:773433',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('approvalRef authorizes a patch but does not supply one'),
          }),
        ]),
      );
    }
  });

  it('accepts approval authorization when an amendment patch is supplied', () => {
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        approvalRef: 'thread-post:773433',
        criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Also inspect the log.' },
      }).success,
    ).toBe(true);
  });

  it('allows passRatings: [] for disclosure criteria and rejects the same shape for outcomes', () => {
    const disclosure = {
      ...criterion,
      role: 'disclosure' as const,
      mandatory: false,
      passRatings: [],
      coversBarKeys: ['R-1'],
    };
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        criteria: [disclosure],
      }).success,
    ).toBe(true);
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        requirement: { key: 'r-1', acceptance: { role: 'disclosure', passRatings: [] } },
      }).success,
    ).toBe(true);

    const invalid = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...disclosure, role: 'outcome', mandatory: true }],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining("role:'disclosure'"),
          }),
        ]),
      );
    }

    const invalidDisclosure = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...disclosure, passRatings: ['healthy'] }],
    });
    expect(invalidDisclosure.success).toBe(false);
    if (!invalidDisclosure.success) {
      expect(invalidDisclosure.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining('must be empty'),
          }),
        ]),
      );
    }
  });

  it('retains a missing-class binding without requiring replacement criteria', () => {
    const parsed = rubricsAmendArgs.parse({
      rubricRef: 'acceptance-example',
      classRef: ' plan-class-investigation ',
    });
    expect(parsed.classRef).toBe('plan-class-investigation');
    expect(parsed.criteria).toBeUndefined();
    expect(rubricsAmendArgs.safeParse({ rubricRef: 'acceptance-example', classRef: '  ' }).success).toBe(false);
  });

  it('refuses an ambiguous full-set plus single-criterion patch', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [criterion],
      criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Also inspect the log.' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['criteria'], message: expect.stringContaining('cannot be combined') }),
        ]),
      );
    }
  });

  it('reports an actionable refusal when dryRun cannot resolve the rubric', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(null);

    const result = await body({
      rubricRef: 'missing-rubric',
      dryRun: true,
      reason: 'Preview the requested amendment.',
      criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Run the focused check.' },
    });

    expect(result).toEqual({
      ok: false,
      dryRun: true,
      code: 'rubric_not_found',
      error: "no rubric 'missing-rubric' — rubrics:list to see refs",
      rubricRef: 'missing-rubric',
    });
  });

  it('returns a non-blocking methodLint advisory for native-shell acceptance methods', async () => {
    const method = 'Read /proc/<pid>/environ after using pgrep -f the proxy.';
    rubricsMocks.rubricCompleteness.mockReturnValue({ complete: true });
    rubricsMocks.amendRubric.mockResolvedValue({
      rubricId: 'acceptance-example',
      kind: 'acceptance',
      criteria: [{ ...criterion, method }],
      methodRef: null,
    });

    const result = await body({
      rubricRef: 'acceptance-example',
      criteria: [{ ...criterion, method }],
      reason: 'Refresh the acceptance procedure.',
    });

    expect(result.methodLint).toEqual([
      expect.objectContaining({
        code: 'acceptance-method-native-shell',
        criterionKey: 'r-1',
        markers: ['proc-path', 'pgrep'],
      }),
    ]);
  });
});
