import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const rubricsMocks = vi.hoisted(() => ({
  amendRubric: vi.fn(),
  previewAcceptanceBarAmendment: vi.fn(),
  rubricCompleteness: vi.fn(),
  getRubric: vi.fn(),
  mintAmendmentIdempotencyKey: vi.fn(() => 'amend-minted-key'),
  findAmendmentDecisionByKey: vi.fn(),
}));

const reviewMocks = vi.hoisted(() => ({ openAcceptanceBarAmendmentReview: vi.fn() }));
const receiptDb = vi.hoisted(() => {
  type Row = { idempotency_key: string; rubric_ref: string; state: string; started_at: Date; finished_at: Date | null; result_json: Record<string, unknown> | null; error: string | null };
  const rows = new Map<string, Row>();
  const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    if (query.includes('DELETE FROM harness_shared.rubric_amend_receipts')) return [];
    if (query.includes('INSERT INTO harness_shared.rubric_amend_receipts')) {
      const [workspace, rubric, key] = values as string[];
      const id = `${workspace}:${rubric}:${key}`;
      if (rows.has(id)) return [];
      rows.set(id, { idempotency_key: key!, rubric_ref: rubric!, state: 'running', started_at: new Date(), finished_at: null, result_json: null, error: null });
      return [{ idempotency_key: key }];
    }
    if (query.includes('SELECT idempotency_key')) {
      const [workspace, rubric, key] = values as string[];
      const row = rows.get(`${workspace}:${rubric}:${key}`);
      return row ? [row] : [];
    }
    if (query.includes('UPDATE harness_shared.rubric_amend_receipts')) {
      const success = query.includes('result_json =');
      const [workspace, rubric, key] = (success ? values.slice(3) : values.slice(1)) as string[];
      const row = rows.get(`${workspace}:${rubric}:${key}`);
      if (row) {
        row.state = success ? String(values[0]) : 'failed';
        row.result_json = success ? JSON.parse(String(values[1])) : null;
        row.error = success ? values[2] as string | null : String(values[0]);
        row.finished_at = new Date();
      }
      return [];
    }
    throw new Error(`unexpected receipt SQL: ${query}`);
  });
  return { rows, sql };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: receiptDb.sql }),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace-registry')>(),
  activeWorkspaceId: () => 'ws-amend-test',
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'amend-test', workspaceId: 'ws-amend-test' }),
}));
vi.mock('../../consult/acceptance-bar-amendment-review', () => ({
  openAcceptanceBarAmendmentReview: reviewMocks.openAcceptanceBarAmendmentReview,
}));
vi.mock('../../rubrics', () => ({
  AMENDABLE_CRITERION_FIELDS: ['title', 'model', 'method', 'driftMarkers', 'replication'],
  amendRubric: rubricsMocks.amendRubric,
  previewAcceptanceBarAmendment: rubricsMocks.previewAcceptanceBarAmendment,
  rubricCompleteness: rubricsMocks.rubricCompleteness,
  getRubric: rubricsMocks.getRubric,
  mintAmendmentIdempotencyKey: rubricsMocks.mintAmendmentIdempotencyKey,
  findAmendmentDecisionByKey: rubricsMocks.findAmendmentDecisionByKey,
}));
vi.mock('../../rubrics-replication-sql', () => ({
  validateRubricReplicationSql: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../detached-imports', () => ({
  trackDetached: () => Promise.resolve({ notifySyncInvalidate: vi.fn() }),
}));

import amendTool, { rubricsAmendArgs } from './amend';
import amendStatusTool from './amend-status';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

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
  it('stays within the shared P-011 prompt-weight budget', () => {
    expect(promptWeight(amendTool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

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

  it('documents the routed review for outside-lineage approval JSON', () => {
    const rendered = JSON.stringify({ description: amendTool.description, guidance: amendTool.guidance });

    expect(rendered).toContain('work_items:comment');
    expect(rendered).toContain("reviewPreviewPost:'thread-post:");
    expect(rendered).toContain('relevance router');
    expect(rendered).toContain('workspace/id');
    expect(rendered).toMatch(/do not create a counter-sign work-item/i);
    expect(rendered).toContain("approvalRef:'thread-post:");
    expect(rendered).toContain('approve thread-post:<preview-post-id>');
    expect(rendered).toContain('immutable');
    expect(rendered).toContain('avoids hash transcription');
    expect(rendered).not.toContain('point the reviewer at THAT thread post');
  });

  it('documents the live plan mapping prerequisite and structured refusal for changed BARs', () => {
    const rendered = JSON.stringify({ description: amendTool.description, guidance: amendTool.guidance });

    expect(rendered).toContain('subject plan');
    expect(rendered).toContain('`## Requirements`');
    expect(rendered).toContain('`### Bar-to-work map for this plan`');
    expect(rendered).toContain('non-dropped P-NNN item');
    expect(rendered).toContain('acceptance_bar_amendment_no_live_discharge_mapping');
    expect(rendered).toContain('{ ok:false, code, error, next }');
  });

  it('returns the expected missing-map dry-run refusal as a result instead of a tool error', async () => {
    const error = new Error("acceptance_bar_amendment_no_live_discharge_mapping: BAR 'R-9' has no live mapped plan item");
    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(error);

    const result = await body({ rubricRef: 'acceptance-example', dryRun: true, criteria: [{
      ...criterion,
      key: 'r-9',
      barKey: 'R-9',
      title: 'New outcome',
    }] });

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      code: 'acceptance_bar_amendment_no_live_discharge_mapping',
      error: error.message,
      next: expect.stringContaining('Bar-to-work map for this plan'),
    });
  });

  it('returns the same expected missing-map refusal for an apply without swallowing unrelated errors', async () => {
    const error = new Error("acceptance_bar_amendment_no_live_discharge_mapping: BAR 'R-9' has no live mapped plan item");
    rubricsMocks.amendRubric.mockRejectedValueOnce(error);

    const result = await body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'unmapped-r9-apply',
      criteria: [{ ...criterion, key: 'r-9', barKey: 'R-9', title: 'New outcome' }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'acceptance_bar_amendment_no_live_discharge_mapping',
      error: error.message,
    });

    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(new Error('unexpected database failure'));
    await expect(body({ rubricRef: 'acceptance-example', dryRun: true })).rejects.toThrow('unexpected database failure');
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

  it('accepts a serving runtime in a complete BAR amendment', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...criterion, evidencePlane: 'live', evidenceRuntime: 'staging-operator' }],
      dryRun: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.criteria?.[0]?.evidenceRuntime).toBe('staging-operator');

    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        criteria: [{ ...criterion, evidencePlane: 'live', evidenceRuntime: 'unknown-runtime' }],
        dryRun: true,
      }).success,
    ).toBe(false);
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

// RSR-P-008-C (review-system-rework-reduction-2026-09-23): rubrics:amend that
// would exceed its timeout returns a pollable receipt. Falsifier: the caller
// receives a timeout error with an unknown commit state. Probe: run amend with a
// slow stub, assert the receipt, then poll it.
describe('rubrics:amend routed review (P-006, RR-P-006-amend-opens-routed-review)', () => {
  const patchArgs = {
    rubricRef: 'acceptance-demo',
    dryRun: true,
    reason: 'Tighten the falsifier.',
    criterion: { key: 'r-1', field: 'driftMarkers' as const, mode: 'append' as const, text: 'Also fails when X.' },
  };
  const approvalRequired = {
    approvalRequired: true,
    approval: { schemaVersion: 1, rubricRef: 'acceptance-demo', bars: [] },
    changes: [{ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['falsifier'] }],
  };

  it('an approval-required dry run with its preview post returns a routed review reference', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({
      state: 'routed',
      conversationId: 'conv-review-1',
      responderId: 'outside-expert',
      screenedOut: [],
      previewPostRef: 'thread-post:42',
      next: "events:await { event:'consult:reply:conv-review-1' }",
    });

    const result = await body({ ...patchArgs, reviewPreviewPost: 'thread-post:42' });

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      review: { state: 'routed', conversationId: 'conv-review-1', previewPostRef: 'thread-post:42' },
    });
    const call = reviewMocks.openAcceptanceBarAmendmentReview.mock.calls[0]![0];
    expect(call).toMatchObject({
      rubricRef: 'acceptance-demo',
      previewPostRef: 'thread-post:42',
      reason: 'Tighten the falsifier.',
      workspaceId: 'ws-amend-test',
      patch: { criterion: patchArgs.criterion },
      preview: approvalRequired,
    });
    // WI-10003299: the tool context reaches the opener so a fresh-reviewer
    // launch can run (re-attributed to the review's system principal).
    expect(call).toHaveProperty('launchCtx');
    expect(call.launchCtx).toEqual({});
    expect(Object.keys(call.patch)).toEqual(['criterion']);
  });

  it('an approval-required dry run without a preview post says how to open the routed review, not whom to message', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);

    const result = await body(patchArgs);

    expect(result.review.state).toBe('not-requested');
    expect(result.review.next).toContain("reviewPreviewPost:'thread-post:");
    expect(result.review.next).not.toMatch(/coord:send/);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();
  });

  it('a dry run that needs no approval carries no review', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ ...approvalRequired, approvalRequired: false });

    const result = await body(patchArgs);

    expect(result).toEqual({ ok: true, dryRun: true, preview: { ...approvalRequired, approvalRequired: false } });
  });

  it('refuses reviewPreviewPost outside a dry run', () => {
    const { dryRun: _dryRun, ...applyArgs } = patchArgs;
    const parsed = rubricsAmendArgs.safeParse({ ...applyArgs, reviewPreviewPost: 'thread-post:42' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('requires dryRun:true');
  });

  it('passes an explicit reviewer model to the routed review and requires a preview post', async () => {
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' };
    expect(rubricsAmendArgs.safeParse({ ...patchArgs, reviewerModel }).success).toBe(false);
    expect(rubricsAmendArgs.safeParse({
      ...patchArgs, reviewPreviewPost: 'thread-post:42',
      reviewerModel: { ...reviewerModel, model: 'sol; unexpected-flag' },
    }).success).toBe(false);
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({
      state: 'routed', conversationId: 'conv-model', responderId: 'reviewer',
      screenedOut: [], previewPostRef: 'thread-post:42', next: 'await reviewer',
    });
    await body({ ...patchArgs, reviewPreviewPost: 'thread-post:42', reviewerModel });
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerModel }),
    );
  });

  it('no amend or check-approver guidance tells the implementer to message a reviewer directly (D-001)', async () => {
    const { default: checkApproverTool } = await import('./check-approver');
    const rendered = JSON.stringify([
      { description: amendTool.description, guidance: amendTool.guidance, args: z.toJSONSchema(amendTool.args as never) },
      { description: checkApproverTool.description, guidance: checkApproverTool.guidance },
    ]);
    expect(rendered).not.toContain('coord:send');
    expect(rendered).not.toMatch(/send (it|its post id|the post|a pointer)[^.]*reviewer/i);
    expect(rendered).not.toMatch(/route only eligible candidates/i);
  });
});

describe('rubrics:amend receipts (RSR-P-008-C)', () => {
  const statusBody = async (args: unknown) =>
    JSON.parse(((await amendStatusTool.handler(args as never, {} as never)) as ToolOutput).content[0]!.text);
  const amendArgs = { rubricRef: 'acceptance-example', criteria: [criterion], reason: 'Refresh the procedure.' };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    receiptDb.rows.clear();
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue(null);
    rubricsMocks.rubricCompleteness.mockReturnValue({ complete: true });
    rubricsMocks.getRubric.mockResolvedValue({ revision: 3 });
    process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS = '20';
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS;
  });

  it('a fast amend answers synchronously and names the receipt key it minted', async () => {
    rubricsMocks.amendRubric.mockResolvedValue({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    const result = await body(amendArgs);
    expect(result).toMatchObject({ ok: true, idempotencyKey: 'amend-minted-key' });
    expect(result.pending).toBeUndefined();
    // The minted key is what the amendment commits under, so its Decision can be found by it.
    expect(rubricsMocks.amendRubric).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'amend-minted-key' }));
    expect(rubricsMocks.mintAmendmentIdempotencyKey).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it('keeps a caller-supplied key instead of minting one', async () => {
    rubricsMocks.amendRubric.mockResolvedValue({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    const result = await body({ ...amendArgs, idempotencyKey: 'caller-key' });
    expect(result.idempotencyKey).toBe('caller-key');
    expect(rubricsMocks.mintAmendmentIdempotencyKey).not.toHaveBeenCalled();
  });

  it('a slow amend returns a receipt instead of timing out, and the receipt polls to committed', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);

    const answered = await body(amendArgs);
    expect(answered).toMatchObject({
      ok: true,
      pending: true,
      receipt: {
        idempotencyKey: 'amend-minted-key',
        rubricRef: 'acceptance-example',
        poll: { tool: 'rubrics:amend-status', args: { rubricRef: 'acceptance-example', idempotencyKey: 'amend-minted-key' } },
      },
    });

    expect(await statusBody(answered.receipt.poll.args)).toMatchObject({ ok: true, state: 'running', source: 'receipt' });

    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(async () => {
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'committed',
        source: 'receipt',
        result: { ok: true, rubric: { rubricId: 'acceptance-example' } },
      });
    });
  });

  it('a different worker reads the running receipt and a same-key retry does not start another amend', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    const first = await body({ ...amendArgs, idempotencyKey: 'shared-key' });
    expect(first.pending).toBe(true);

    // A fresh module registry models a second worker. The mocked PG rows survive
    // independently of either module's process-local state.
    vi.resetModules();
    const workerB = (await import('./amend-status')).default;
    const status = JSON.parse(((await workerB.handler({ rubricRef: 'acceptance-example', idempotencyKey: 'shared-key' } as never, {} as never)) as ToolOutput).content[0]!.text);
    expect(status).toMatchObject({ state: 'running', source: 'receipt' });

    const retry = await body({ ...amendArgs, idempotencyKey: 'shared-key' });
    expect(retry.pending).toBe(true);
    expect(rubricsMocks.amendRubric).toHaveBeenCalledTimes(1);
    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(async () => {
      expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'shared-key' }))
        .toMatchObject({ state: 'committed', source: 'receipt' });
    });
  });

  it('reports a committed Decision when its worker left a running receipt behind', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    const first = await body({ ...amendArgs, idempotencyKey: 'stranded-key' });
    expect(first.pending).toBe(true);
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue({
      decisionId: 'D-42', subjectPlan: 'example-plan',
    });
    expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'stranded-key' }))
      .toMatchObject({ state: 'committed', source: 'decision', decisionId: 'D-42' });
    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
  });

  it('a slow amend that then fails polls to failed with the error, never to committed', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    const answered = await body(amendArgs);
    slow.reject(new Error('acceptance_bar_amendment_conflict'));
    await vi.waitFor(async () => {
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'failed',
        error: 'acceptance_bar_amendment_conflict',
      });
    });
  });

  it('a slow dry-run returns a pollable preview receipt without applying the amendment', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.previewAcceptanceBarAmendment.mockReturnValue(slow.promise);

    const answered = await body({ ...amendArgs, dryRun: true, approvedBy: 'outside-reviewer' });
    expect(answered).toMatchObject({
      ok: true,
      dryRun: true,
      pending: true,
      receipt: {
        rubricRef: 'acceptance-example',
        poll: { tool: 'rubrics:amend-status', args: { rubricRef: 'acceptance-example' } },
      },
    });
    expect(answered.receipt.idempotencyKey).toMatch(/^preview-/);
    expect(rubricsMocks.amendRubric).not.toHaveBeenCalled();
    expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
      state: 'running',
      source: 'receipt',
    });

    slow.resolve({ changedBars: ['R-1'] });
    await vi.waitFor(async () => {
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'previewed',
        source: 'receipt',
        result: { ok: true, dryRun: true, preview: { changedBars: ['R-1'] } },
      });
    });
  });

  it('after a restart (no in-process receipt) the committed Decision still answers committed', async () => {
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue({
      decisionId: 'D-007',
      subjectPlan: 'subject-plan',
      subjectHarnessSlug: 'papercusp',
    });
    expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'amend-lost' })).toMatchObject({
      state: 'committed',
      source: 'decision',
      decisionId: 'D-007',
    });
  });

  it('with neither a receipt nor a Decision it answers not_found and says a same-key retry is safe', async () => {
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue(null);
    const status = await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'amend-unknown' });
    expect(status).toMatchObject({ state: 'not_found', source: 'none' });
    expect(status.note).toMatch(/same rubrics:amend with this idempotencyKey is safe/);
  });
});
