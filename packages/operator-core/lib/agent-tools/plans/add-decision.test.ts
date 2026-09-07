/**
 * plans:add-decision — `itemRefs` alias for `refs` (EI-18735663944089262).
 *
 * plans:get echoes a decision's item refs back under the field name
 * `itemRefs`, but plans:add-decision only ever declared `refs` — so writing
 * back exactly what you just read was rejected with `Unrecognized key:
 * "itemRefs"`. This declares `itemRefs` as an accepted alias (schema-level,
 * so the EI-10883 closed-shape guard still rejects genuinely unknown keys)
 * and has the handler prefer `refs` when both are supplied.
 *
 * Schema-only (no DB): `tool.args` is the same `strictArgs(...)`-wrapped
 * zod schema the dispatcher validates every call against, so a
 * `safeParse` here exercises exactly what a live call would hit.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const handlerMocks = vi.hoisted(() => ({
  harnessScopedCtx: vi.fn((harness: unknown, ctx: Record<string, unknown>) => ({
    ...ctx,
    harnessSlug: typeof harness === 'string' ? harness : 'session-harness',
  })),
  recoverHarnessFromSlugs: vi.fn(),
  readPlanBySlug: vi.fn(),
  withPlanLock: vi.fn(),
  planRevisionCapture: vi.fn(),
  emitPlanEventForCaller: vi.fn(async () => {}),
  emitDecisionAdded: vi.fn(),
  readFrozenRepairMarker: vi.fn(),
  // WI-42142: the provenance stamp does transcript IO. Mocked so these tests pin
  // the WIRING (refusal + advisory fold), while falsifiedOwnerAnchors itself stays
  // REAL here — its own contract is unit-tested in carry-surface-provenance-stamp.test.ts.
  carryProvenanceFields: vi.fn(async () => ({}) as Record<string, unknown>),
}));

// Handler tests below isolate the scope and lock seams; the pure helper tests
// in this file continue to use the real parser and allocation functions.
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: handlerMocks.harnessScopedCtx,
}));
vi.mock('./slug-scope', async (orig) => ({
  ...(await orig<typeof import('./slug-scope')>()),
  recoverHarnessFromSlugs: handlerMocks.recoverHarnessFromSlugs,
}));
vi.mock('./source', async (orig) => ({
  ...(await orig<typeof import('./source')>()),
  readPlanBySlug: handlerMocks.readPlanBySlug,
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: handlerMocks.withPlanLock,
  bumpUpdatedDate: (body: string) => body,
}));
vi.mock('./revisions', () => ({
  planRevisionCapture: handlerMocks.planRevisionCapture,
}));
vi.mock('../coordination/plan-events', () => ({
  emitPlanEventForCaller: handlerMocks.emitPlanEventForCaller,
}));
vi.mock('../../harness/usage-emitters', () => ({
  emitDecisionAdded: handlerMocks.emitDecisionAdded,
}));
vi.mock('../../release/frozen-repair-edit-marker', async (orig) => ({
  ...(await orig<typeof import('../../release/frozen-repair-edit-marker')>()),
  readFrozenRepairMarker: handlerMocks.readFrozenRepairMarker,
}));
vi.mock('../../carry-surface-provenance-stamp', async (orig) => ({
  ...(await orig<typeof import('../../carry-surface-provenance-stamp')>()),
  carryProvenanceFields: handlerMocks.carryProvenanceFields,
}));
import tool, {
  findRetryDuplicateOfLastDecision,
  appendDecisionToBody,
  allocateNextDecisionId,
  decisionMeasurementAdvisory,
} from './add-decision';
import { parsePlan } from './parser';

const HANDLER_PLAN = [
  '---',
  'slug: handler-plan',
  'status: active',
  '---',
  '',
  '## Now',
  'State: testing',
  '',
  '## Decisions',
  '',
].join('\n');

const handlerContext = (harnessSlug = '*') => ({
  workspaceId: 'ws-add-decision',
  harnessSlug,
  metadata: vi.fn(),
});

const handlerBody = async (args: Record<string, unknown>, ctx: Record<string, unknown>) =>
  (((await tool.handler(args as never, ctx as never)) as { data: unknown }).data) as {
    ok: boolean;
    results: Array<Record<string, unknown>>;
    counts: { ok: number; failed: number };
  };

describe('plans:add-decision — itemRefs alias for refs', () => {
  it('accepts `itemRefs` on a single-decision call (the exact read-then-write repro)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      itemRefs: ['P-008', 'P-012'],
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts the canonical `refs` field', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      refs: ['P-008'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts `itemRefs` on a per-item entry of a bulk `items` call', () => {
    const parsed = tool.args.safeParse({
      items: [
        { slug: 'some-plan', title: 'A decision', body: 'Body text.', itemRefs: ['P-008'] },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('documents the shared P-NNN namespace on the itemRefs alias', () => {
    expect(tool.args.shape.itemRefs.description).toMatch(/same in-plan `P-NNN` reference format/i);
  });

  it('still rejects a genuinely unknown key (EI-10883 closed shape intact)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      notAField: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed itemRefs entry the same way refs is validated (P-NNN shape)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      itemRefs: ['not-a-p-id'],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('plans:add-decision — measure before you rule', () => {
  it('documents the tree-measurement contract on both the schema and tool guidance', () => {
    expect(tool.args.shape.body.description).toContain('Measured:');
    expect(tool.guidance?.when).toContain('open the tree');
    expect(tool.description).toContain('measurementAdvisory');
  });

  it('flags source-like paths when no measurement accompanies the tree claim', () => {
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field and coordination/based-on.ts must reuse it.',
    )).toMatchObject({
      code: 'tree_fact_measurement_missing',
      paths: ['relay-provenance.ts:212', 'coordination/based-on.ts'],
    });
  });

  it('accepts a concrete Measured line and ignores design prose without source paths', () => {
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field.\nMeasured: rg -n "evidence" relay-provenance.ts returned line 212.',
    )).toBeNull();
    expect(decisionMeasurementAdvisory('Choose the shared provenance surface over a third one.')).toBeNull();
  });

  it('accepts qualified Measured headers with parenthetical or bracketed context', () => {
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field.\nMeasured (2026-08-29, working tree vs HEAD): rg -n "evidence" relay-provenance.ts returned line 212.',
    )).toBeNull();
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field.\nMeasured [current HEAD]: rg -n "evidence" relay-provenance.ts returned line 212.',
    )).toBeNull();
  });

  it('does not treat an empty qualified Measured header as evidence', () => {
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field.\nMeasured (2026-08-29, working tree vs HEAD):',
    )).toMatchObject({ code: 'tree_fact_measurement_missing' });
  });

  // Regression pins for EI-21900576470401486 / EI-21850043257707007: the guard
  // false-fired at authors who HAD measured, because the old pattern anchored on
  // a literal `M` after leading whitespace and capped the qualifier at 80 chars.
  // A false alarm is a bug in the alarm — it trains readers to ignore the one
  // warning that catches an unmeasured tree claim. Both reporters' diagnoses of
  // the mechanism were wrong, so the forms are pinned here rather than reasoned
  // about from the regex.
  it.each([
    ['bold', '**Measured:** grep -n failover adapters -> 37 hits across 5 files'],
    ['underscore emphasis', '__Measured:__ grep -n failover -> 37 hits'],
    ['single-star emphasis', '*Measured:* grep -n failover -> 37 hits'],
    ['dash list marker', '- Measured: 22 cited paths, 7 drifted'],
    ['star list marker', '* Measured: 22 cited paths, 7 drifted'],
    ['numbered list marker', '1. Measured: 22 cited paths, 7 drifted'],
    ['blockquote marker', '> Measured: 22 cited paths, 7 drifted'],
    ['list marker plus emphasis', '- **Measured:** 22 cited paths, 7 drifted'],
    ['indented emphasis', '   **Measured:** 22 cited paths, 7 drifted'],
  ])('accepts a Measured line decorated with %s', (_label, measured) => {
    expect(decisionMeasurementAdvisory(`relay-provenance.ts:212 owns this field.\n${measured}`)).toBeNull();
  });

  it('accepts a qualifier longer than the old 80-char cap, with evidence on the next line', () => {
    // The exact heading from EI-21850043257707007: a 166-char parenthetical.
    const heading =
      'Measured (content evidence only; per repo convention neither `git blame` nor a commit subject is '
      + 'evidence here, and the boundary is established by comparing blobs, not dates):';
    expect(decisionMeasurementAdvisory(
      `relay-provenance.ts:212 owns this field.\n${heading}\n    git rev-parse a:b -> deadbeef`,
    )).toBeNull();
  });

  it('still fires when a decorated label carries no evidence after it', () => {
    // The tolerance is about how the label is WRITTEN, never about whether
    // evidence follows: a bare promise must keep failing.
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field.\n**Measured:**',
    )).toMatchObject({ code: 'tree_fact_measurement_missing' });
  });

  it('does not mistake ordinary prose containing the word for a measurement', () => {
    expect(decisionMeasurementAdvisory(
      'relay-provenance.ts:212 owns this field.\nWe Measured the thing and found: nothing conclusive.',
    )).toMatchObject({ code: 'tree_fact_measurement_missing' });
  });
});

describe('plans:add-decision — affects uses the cross-plan slug namespace', () => {
  it('accepts an existing-plan-shaped slug and documents the namespace on each item', () => {
    const parsed = tool.args.safeParse({
      slug: 'home-plan',
      title: 'A decision',
      body: 'Body text.',
      affects: ['other-plan-2026-08-22'],
    });
    expect(parsed.success).toBe(true);

    const affectsSchema = tool.args.shape.affects;
    expect(affectsSchema.description).toMatch(/existing plan slugs of OTHER plans/i);
    const itemDescription = affectsSchema.unwrap().element.description;
    expect(itemDescription).toMatch(/not a surface label/i);
    expect(itemDescription).toMatch(/refs\/itemRefs/i);
  });

  it('rejects free-form surface labels instead of silently reporting unknown_affects after the write', () => {
    const parsed = tool.args.safeParse({
      slug: 'home-plan',
      title: 'A decision',
      body: 'Body text.',
      affects: ['orchestration public API', 'capability preflight'],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('plans:add-decision — decision references do not inflate allocation (EI-19989843927675996)', () => {
  it('ignores cross-plan D-NNN citations inside decision bodies', () => {
    const body = [
      '## Decisions',
      '',
      '### D-001 — Existing decision',
      'Body.',
      '',
      '### D-002 — Citing another plan',
      'This defers to unified-agent-state-plane-2026-07-27#D-054 and also cites D-088.',
    ].join('\n');

    expect(allocateNextDecisionId(body)).toBe('D-003');
  });
});

/**
 * EI-19383795443003151: an MCP write can time out client-side with no
 * response, leaving the outcome unknown. `plans:add-decision` only ever
 * appends, so a blind retry risked minting a duplicate decision. These pin
 * `findRetryDuplicateOfLastDecision` — the pure check that makes a retry
 * safe — both standalone and threaded through the real append/allocate
 * helpers so a plan body constructed exactly like the live write path is
 * exercised (no DB — those helpers are pure string transforms).
 */
describe('plans:add-decision — retry-safety (EI-19383795443003151)', () => {
  const BASE_PLAN = [
    '---',
    'slug: some-plan',
    'status: active',
    '---',
    '',
    '## Now',
    'State: testing',
    '',
    '## Decisions',
    '',
  ].join('\n');

  function appendOne(body: string, title: string, decisionBody: string, refs: string[] = []): string {
    const id = allocateNextDecisionId(body);
    return appendDecisionToBody(body, id, title, decisionBody, '2026-08-03', refs);
  }

  it('findRetryDuplicateOfLastDecision: no decisions yet → null', () => {
    expect(findRetryDuplicateOfLastDecision([], 'Title', 'Body')).toBeNull();
  });

  it('an exact-match retry of the MOST RECENT decision is found', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    expect(parsed.decisions).toHaveLength(1);

    const dup = findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'We chose A because it is simpler.');
    expect(dup).not.toBeNull();
    expect(dup?.id).toBe(parsed.decisions[0]?.id);
  });

  it('a DIFFERENT title against the same last decision does not match', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    expect(findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option B', 'We chose A because it is simpler.')).toBeNull();
  });

  it('a DIFFERENT body against the same last decision does not match', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    expect(findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'Actually we chose B.')).toBeNull();
  });

  it('an identical title+body recorded EARLIER (not the last decision) is NOT deduped', () => {
    // Two genuinely distinct decisions can legitimately share the same text
    // (e.g. a decision reaffirmed later under a new id) — only the TAIL
    // decision is eligible, so retrying the FIRST one's exact text after a
    // second, different decision has landed must not match it.
    let body = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    body = appendOne(body, 'Pick option C', 'Later we also chose C for a separate reason.');
    const parsed = parsePlan(body, { filePath: 'some-plan.md' });
    expect(parsed.decisions).toHaveLength(2);

    // Retrying the FIRST decision's exact text now finds nothing — it is no
    // longer the tail, so this correctly falls through to allocating a new id
    // rather than silently colliding with an unrelated later decision.
    expect(findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'We chose A because it is simpler.')).toBeNull();
    // Retrying the SECOND (actually most recent) decision's exact text does match.
    const dup = findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option C', 'Later we also chose C for a separate reason.');
    expect(dup?.id).toBe(parsed.decisions[1]?.id);
  });

  it('refs on the original call do not defeat the match (containment, not equality)', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.', ['P-001', 'P-002']);
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    const dup = findRetryDuplicateOfLastDecision(parsed.decisions, 'Pick option A', 'We chose A because it is simpler.');
    expect(dup?.id).toBe(parsed.decisions[0]?.id);
  });

  it('whitespace-only differences in title/body still match (both sides are trimmed)', () => {
    const withOne = appendOne(BASE_PLAN, 'Pick option A', 'We chose A because it is simpler.');
    const parsed = parsePlan(withOne, { filePath: 'some-plan.md' });
    const dup = findRetryDuplicateOfLastDecision(
      parsed.decisions,
      '  Pick option A  ',
      '  We chose A because it is simpler.  ',
    );
    expect(dup?.id).toBe(parsed.decisions[0]?.id);
  });
});

describe('plans:add-decision — exact-slug harness recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlerMocks.readFrozenRepairMarker.mockReturnValue(null);
    handlerMocks.carryProvenanceFields.mockResolvedValue({});
    handlerMocks.planRevisionCapture.mockReturnValue({
      afterWrite: undefined,
      recorded: { current: null },
    });
    handlerMocks.withPlanLock.mockImplementation(
      async (
        _ctx: unknown,
        _opts: unknown,
        mutate: (body: string) => Promise<{ newBody: string | null; value: unknown }>,
      ) => {
        const result = await mutate(HANDLER_PLAN);
        return { kind: 'ok', ...result, filePath: 'handler-plan.md' };
      },
    );
    handlerMocks.harnessScopedCtx.mockImplementation((harness: unknown, ctx: Record<string, unknown>) => ({
      ...ctx,
      harnessSlug: typeof harness === 'string' ? harness : 'session-harness',
    }));
  });

  it('recovers the owning harness from an exact slug in operator scope', async () => {
    const ctx = handlerContext();
    handlerMocks.recoverHarnessFromSlugs.mockResolvedValue({
      status: 'resolved',
      harnessSlug: 'recovered-harness',
      bySlug: { 'handler-plan': 'recovered-harness' },
      ambiguous: {},
    });

    const result = await handlerBody(
      { slug: 'handler-plan', title: 'Recovered scope', body: 'Use the owning harness.' },
      ctx,
    );

    expect(handlerMocks.recoverHarnessFromSlugs).toHaveBeenCalledWith(ctx, ['handler-plan']);
    expect(handlerMocks.harnessScopedCtx).not.toHaveBeenCalled();
    expect(handlerMocks.withPlanLock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ slug: 'handler-plan', harnessSlug: 'recovered-harness' }),
      expect.any(Function),
    );
    expect(ctx.metadata).toHaveBeenCalledWith({
      harnessAutoResolved: { 'handler-plan': 'recovered-harness' },
    });
    expect(result).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(result.results[0]).toMatchObject({ ok: true, slug: 'handler-plan', decisionId: 'D-001' });
  });

  it('preserves explicit harness behavior without consulting slug recovery', async () => {
    const ctx = handlerContext();

    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Explicit scope',
        body: 'Honor the caller-selected harness.',
      },
      ctx,
    );

    expect(handlerMocks.recoverHarnessFromSlugs).not.toHaveBeenCalled();
    expect(handlerMocks.harnessScopedCtx).toHaveBeenCalledWith('explicit-harness', ctx);
    expect(handlerMocks.withPlanLock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ harnessSlug: 'explicit-harness' }),
      expect.any(Function),
    );
    expect(result.results[0]).toMatchObject({ ok: true, slug: 'handler-plan', decisionId: 'D-001' });
  });

  it('refuses the historical staging-candidate decision before taking the plan lock', async () => {
    handlerMocks.readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Canonical candidate source',
        body: 'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
      },
      handlerContext(),
    );

    // Bulk transport remains healthy even when the sole item is refused; the
    // per-item result and failed count carry the policy verdict.
    expect(result).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(result.results[0]).toMatchObject({
      ok: false,
      slug: 'handler-plan',
      error: 'frozen_candidate_lineage_violation',
      surface: 'plan-decision',
      unsafeSource: 'staging',
      liveIdentity: {
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        queueRevision: 1_788_763_360_000,
      },
    });
    expect(handlerMocks.withPlanLock).not.toHaveBeenCalled();
    expect(handlerMocks.carryProvenanceFields).not.toHaveBeenCalled();
  });

  it('resolves affected plans against the source write scope (same-harness cross-plan repro)', async () => {
    const ctx = handlerContext();
    const resolvedScope = { workspaceId: 'sidestage-workspace', harnessSlug: 'sidestage' };
    handlerMocks.readPlanBySlug.mockResolvedValueOnce({});
    handlerMocks.withPlanLock.mockImplementationOnce(
      async (
        _ctx: unknown,
        _opts: unknown,
        mutate: (body: string) => Promise<{ newBody: string | null; value: unknown }>,
      ) => {
        const result = await mutate(HANDLER_PLAN);
        return { kind: 'ok', ...result, filePath: 'handler-plan.md', scope: resolvedScope };
      },
    );

    const result = await handlerBody(
      {
        harness: 'sidestage',
        slug: 'handler-plan',
        title: 'Cross-plan propagation',
        body: 'Propagate this decision to the affected plan.',
        affects: ['affected-plan'],
      },
      ctx,
    );

    expect(handlerMocks.readPlanBySlug).toHaveBeenCalledWith('affected-plan', resolvedScope);
    expect(result.results[0]).toMatchObject({
      ok: true,
      decisionId: 'D-001',
      propagated_to: ['affected-plan'],
    });
    expect(result.results[0]).not.toHaveProperty('unknown_affects');
  });

  it('WI-42142: refuses a decision whose owner claim is anchored to a NON-owner turn, before taking the plan lock', async () => {
    const ctx = handlerContext();
    const ref = '[turn:codex:01a03d76-8954-76d3-a211-dc9717f3e07c@2026-08-26T09:46:32.215Z]';
    handlerMocks.carryProvenanceFields.mockResolvedValue({
      turnProvenance: {
        refs: [
          {
            ref,
            found: true,
            checked: true,
            verdict: 'agent-injected',
            origin: 'self-compaction',
            snippet: 'Continue where you left off',
            quote: null,
            quoteMatch: null,
          },
        ],
      },
    });

    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Owner-directed ordering',
        body: `Owner-directed ordering. The owner checkpoint records the source turn as ${ref}.`,
      },
      ctx,
    );

    // The refusal must land BEFORE the write — a decision recorded and then
    // warned about is already being read as authority by other lanes.
    expect(handlerMocks.withPlanLock).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      ok: false,
      slug: 'handler-plan',
      error: 'falsified_owner_anchor',
    });
    expect(String(result.results[0].message)).toContain('[self-imposed]');
    expect(result.results[0].anchors).toHaveLength(1);
  });

  it('WI-42142: a bare [owner:…] tag with no anchor is NOT refused — it folds through as advisory', async () => {
    // The dominant existing convention: 432 of the 483 decision-body owner-tag
    // lines in this workspace's plans are bare tags. Refusing them would break
    // correct practice AND still miss the falsified-anchor shape above.
    const ctx = handlerContext();
    handlerMocks.carryProvenanceFields.mockResolvedValue({
      provenanceLint: {
        flagged: true,
        note: 'sync note',
        matches: [{ line: '[owner 2026-08-26] ship it', kind: 'manual-owner-tag' }],
      },
    });

    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Ship it',
        body: '[owner 2026-08-26] ship it',
      },
      ctx,
    );

    expect(handlerMocks.withPlanLock).toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ ok: true, decisionId: 'D-001' });
    expect(result.results[0].provenanceLint).toMatchObject({ flagged: true });
  });

  it('WI-42142: a stamp fault fails OPEN — the decision still lands', async () => {
    const ctx = handlerContext();
    handlerMocks.carryProvenanceFields.mockRejectedValue(new Error('transcript unreachable'));

    const result = await handlerBody(
      { harness: 'explicit-harness', slug: 'handler-plan', title: 'Still lands', body: 'No provenance shapes.' },
      ctx,
    );

    expect(result.results[0]).toMatchObject({ ok: true, decisionId: 'D-001' });
  });

  it('WI-42142: a clean decision keeps its exact prior response shape (no provenance noise)', async () => {
    const ctx = handlerContext();

    const result = await handlerBody(
      { harness: 'explicit-harness', slug: 'handler-plan', title: 'Clean', body: 'Ordinary rationale.' },
      ctx,
    );

    expect(result.results[0]).toMatchObject({ ok: true, decisionId: 'D-001' });
    expect(result.results[0]).not.toHaveProperty('provenanceLint');
    expect(result.results[0]).not.toHaveProperty('turnProvenance');
  });

  it('WI-7238: returns an advisory for an uncovered absence premise while preserving the decision', async () => {
    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Add the reader',
        body: 'There is no exported reader for the offers table, so the plan must add one.',
      },
      handlerContext(),
    );

    expect(handlerMocks.withPlanLock).toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      ok: true,
      decisionId: 'D-001',
      absenceLint: {
        flagged: true,
        claims: [{ claim: expect.stringContaining('no exported reader'), recheck: expect.any(String) }],
      },
    });
  });

  it('WI-7238: a concrete Measured line suppresses the mixed-precision decision advisory', async () => {
    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Reader inventory',
        body:
          'There is no exported reader for the offers table.\n' +
          'Measured (whole repository): rg -n "offers reader" packages apps returned zero matches.',
      },
      handlerContext(),
    );

    expect(result.results[0]).toMatchObject({ ok: true, decisionId: 'D-001' });
    expect(result.results[0]).not.toHaveProperty('absenceLint');
  });

  it('returns a machine-visible measurement advisory on the decision write that needs review', async () => {
    const ctx = handlerContext();

    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Provenance placement',
        body: 'relay-provenance.ts:212 owns the evidence band, so based-on.ts must store the read trace there.',
      },
      ctx,
    );

    expect(result.results[0]).toMatchObject({
      ok: true,
      decisionId: 'D-001',
      measurementAdvisory: {
        code: 'tree_fact_measurement_missing',
        paths: ['relay-provenance.ts:212', 'based-on.ts'],
      },
    });
  });

  it('refuses an ambiguous recovered slug before taking the plan lock', async () => {
    const ctx = handlerContext();
    handlerMocks.recoverHarnessFromSlugs.mockResolvedValue({
      status: 'resolved',
      harnessSlug: 'new-harness',
      bySlug: { 'handler-plan': 'new-harness' },
      ambiguous: { 'handler-plan': ['new-harness', 'old-harness'] },
    });

    const result = await handlerBody(
      { slug: 'handler-plan', title: 'Ambiguous scope', body: 'Do not guess.' },
      ctx,
    );

    expect(handlerMocks.withPlanLock).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      ok: false,
      slug: 'handler-plan',
      error: 'plan_slug_ambiguous_across_harnesses',
      candidates: { 'handler-plan': ['new-harness', 'old-harness'] },
    });
  });

  it('preserves safe busy metadata and the nullable holder snapshot in the item result', async () => {
    const ctx = handlerContext();
    const holderSnapshot = {
      captured_at: '2026-09-04T20:00:00.000Z',
      lock_key: 'ws-add-decision:explicit-harness:handler-plan',
      holders: [
        {
          pid: 1234,
          application_name: 'papercusp-staging',
          state: 'active',
          query_start: '2026-09-04 20:00:00+00',
          wait_event_type: null,
          wait_event: null,
        },
      ],
    };
    handlerMocks.withPlanLock.mockResolvedValueOnce({
      kind: 'busy',
      busy: [
        {
          path: 'handler-plan.md',
          owner: 'unknown',
          owner_label: null,
          intent: 'another plans write is in progress',
          expires_ts: null,
          holder_snapshot: holderSnapshot,
        },
      ],
    });

    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Busy metadata',
        body: 'Preserve the diagnostic snapshot.',
      },
      ctx,
    );

    expect(result).toMatchObject({ ok: true, counts: { ok: 0, failed: 1 } });
    expect(result.results[0]).toEqual({
      ok: false,
      slug: 'handler-plan',
      error: 'busy',
      busy: [
        {
          path: 'handler-plan.md',
          owner: 'unknown',
          owner_label: null,
          intent: 'another plans write is in progress',
          expires_ts: null,
          holder_snapshot: holderSnapshot,
        },
      ],
    });
  });

  it('EI-21915372335188454: neutralizes stray tool-call-lookalike markup in both title and body, without dropping the rest of the text', async () => {
    // Reproduces the reported failure shape: a client-side tool-call serializer
    // mis-closes `<parameter name="body">` (e.g. with `</body>` instead of
    // `</parameter>`) and everything after the mismatch — including a live
    // `<parameter name="refs">…` block for the NEXT argument — lands literally
    // inside this string. Left unneutralized, that plants a live-looking
    // `<invoke>`/`<parameter>` tag in a durable governance record a later
    // reading agent could misread as its own tool-call transcript (EI-9267).
    const ctx = handlerContext();
    let capturedNewBody: string | null = null;
    handlerMocks.withPlanLock.mockImplementationOnce(
      async (
        _ctx: unknown,
        _opts: unknown,
        mutate: (body: string) => Promise<{ newBody: string | null; value: unknown }>,
      ) => {
        const result = await mutate(HANDLER_PLAN);
        capturedNewBody = result.newBody;
        return { kind: 'ok', ...result, filePath: 'handler-plan.md' };
      },
    );

    const pollutedBody = 'The real ruling ends here.</body>\n<parameter name="refs">["P-007"]';
    const result = await handlerBody(
      {
        harness: 'explicit-harness',
        slug: 'handler-plan',
        title: 'Polluted <invoke name="plans:add-decision">',
        body: pollutedBody,
      },
      ctx,
    );

    expect(result.results[0]).toMatchObject({ ok: true, decisionId: 'D-001' });
    expect(capturedNewBody).not.toBeNull();
    // The exact-tag-name markup (<invoke>/<parameter>) is swapped to the inert,
    // visually-similar full-width `＜` — no longer a live/parseable tag — while
    // the rest of the text, including the absorbed `refs` payload, survives
    // untouched (non-destructive: nothing is dropped or truncated).
    expect(capturedNewBody).not.toContain('<parameter');
    expect(capturedNewBody).not.toContain('<invoke');
    expect(capturedNewBody).toContain('＜parameter');
    expect(capturedNewBody).toContain('＜invoke');
    expect(capturedNewBody).toContain('P-007');
  });
});
