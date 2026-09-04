/**
 * plans:audit writer-contract guard (plan-completion-audit-and-acceptance-verdict
 * D-008). These are handler/schema tests, not just coverage-fold tests: they pin
 * the exact boundary that decides whether an auditor actually read code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';

const { mockOrgSql } = vi.hoisted(() => ({ mockOrgSql: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: mockOrgSql }) };
});
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./slug-scope', async (orig) => ({
  ...(await orig<typeof import('./slug-scope')>()),
  recoverHarnessFromSlugs: vi.fn(),
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => 'papercusp' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-auditor' }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../sessions/_shared', async (orig) => {
  const actual = await orig<typeof import('../sessions/_shared')>();
  return { ...actual, resolveSessionTurnRefs: vi.fn() };
});
vi.mock('../../plan-audits', async (orig) => {
  const actual = await orig<typeof import('../../plan-audits')>();
  return {
    ...actual,
    getPlanItemStatuses: vi.fn(),
    getEffectiveItemAudits: vi.fn(),
    getLatestActivationAudit: vi.fn(),
    repoCitationContextForHarness: vi.fn(),
    recordPlanAudit: vi.fn(),
    recordCurrentActivationAudit: vi.fn(),
  };
});
vi.mock('./activation-audit-repair', () => ({
  ensureActivationAuditRepairFiling: vi.fn(),
}));
vi.mock('./source', () => ({ getPlanRow: vi.fn() }));
vi.mock('./spec-clauses-store', () => ({ setSpecClause: vi.fn() }));

import {
  getEffectiveItemAudits,
  getLatestActivationAudit,
  getPlanItemStatuses,
  recordCurrentActivationAudit,
  recordPlanAudit,
  repoCitationContextForHarness,
} from '../../plan-audits';
import { ensureActivationAuditRepairFiling } from './activation-audit-repair';
import { getPlanRow } from './source';
import { setSpecClause } from './spec-clauses-store';
import { resolveSessionTurnRefs } from '../sessions/_shared';
import { recoverHarnessFromSlugs } from './slug-scope';
import { BUDGET, promptWeight } from '../tool-guidance-budget';
import tool from './audit';

const mockItems = vi.mocked(getPlanItemStatuses);
const mockPrevious = vi.mocked(getEffectiveItemAudits);
const mockPreviousActivation = vi.mocked(getLatestActivationAudit);
const mockContext = vi.mocked(repoCitationContextForHarness);
const mockRecord = vi.mocked(recordPlanAudit);
const mockRecordActivation = vi.mocked(recordCurrentActivationAudit);
const mockResolveSourceRefs = vi.mocked(resolveSessionTurnRefs);
const mockRepairFiling = vi.mocked(ensureActivationAuditRepairFiling);
const mockGetPlanRow = vi.mocked(getPlanRow);
const mockSetSpecClause = vi.mocked(setSpecClause);
const mockRecoverHarness = vi.mocked(recoverHarnessFromSlugs);

const ctx = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  role: 'operator',
  workspaceId: 'test-workspace',
  tx: vi.fn(),
} as never;

const body = async (items: Array<Record<string, unknown>>) =>
  ((await tool.handler({ slug: 'plan-a', harness: 'papercusp', items } as never, ctx)) as { data: any }).data;

beforeEach(() => {
  vi.clearAllMocks();
  mockItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'ship the audit gate' }]);
  mockSetSpecClause.mockResolvedValue({
    status: 'created',
    specId: 'AUTO-REQ-M-001-P-001',
    revision: 1,
    contentHash: 'c'.repeat(64),
  });
  mockPrevious.mockResolvedValue([]);
  mockPreviousActivation.mockResolvedValue(null);
  mockContext.mockResolvedValue({
    repoRoot: '/repo',
    rootSource: 'canonical-repo',
    deps: {
      statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
      readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
      blobSha: (path) => (path === 'src/gate.ts' ? '0123456789012345678901234567890123456789' : null),
    },
  });
  mockRecord.mockResolvedValue({ auditSeq: 1, auditedSha: 'head-1' } as never);
  mockResolveSourceRefs.mockResolvedValue([
    { ref: 'session_turn:codex:session-full-id:7', ok: true, source: 'index' },
  ]);
  mockRecordActivation.mockResolvedValue({
    ok: true,
    audit: { auditSeq: 2 } as never,
    auditedPlanRevision: { id: 41, seq: 6, contentHash: 'a'.repeat(64) },
  });
  mockRepairFiling.mockResolvedValue({
    conditionKey: 'activation-audit:papercusp/plan-a',
    id: 'EI-ACTIVATION-REPAIR',
    created: true,
  });
  mockGetPlanRow.mockResolvedValue({
    content: `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-08-27\nupdated: 2026-08-27\nowner: test\n---\n\n## Items\n\n- **P-001** \`todo\` Implement the audit gate on staging.\n`,
  } as never);
});

describe('plans:audit exact-slug scope recovery', () => {
  it('recovers the owning harness for a workspace-scoped call that omits harness', async () => {
    mockRecoverHarness.mockResolvedValue({
      status: 'resolved',
      harnessSlug: 'papercusp',
      bySlug: { 'plan-a': 'papercusp' },
      ambiguous: {},
    });

    const result = await tool.handler({
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }],
    } as never, { ...(ctx as never as Record<string, unknown>), harnessSlug: '*' } as never) as { data: any };

    expect(result.data).toMatchObject({
      ok: true,
      slug: 'plan-a',
      coverage: { auditedItems: 1, verifiedItems: 1 },
    });
    expect(mockRecoverHarness).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: '*' }),
      ['plan-a'],
    );
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'papercusp' }));
  });
});

const activationArgs = (over: Record<string, unknown> = {}) => ({
  slug: 'plan-a',
  harness: 'papercusp',
  phase: 'activation',
  sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
  mappings: [{
    id: 'M-001',
    sourceRefs: ['session_turn:codex:session-full-id:7'],
    requirement: 'activation requires a complete source audit',
    planTargets: ['P-001'],
    disposition: 'covered',
  }],
  repairedOmissions: [],
  rejectedOrSuperseded: [],
  unresolvedBlockers: [],
  ...over,
});

const COMPLETE_CONVERSATION_OBLIGATION_IDS = [
  'M-001', // requirement
  'M-002', // scope boundary
  'M-003', // constraint
  'M-004', // correction
  'M-005', // rejected alternative
  'M-006', // decision
  'M-007', // dependency
  'M-008', // sequencing
  'M-009', // acceptance condition
  'M-010', // open question
  'M-011', // promised follow-up
] as const;

function missingConversationObligations(mappings: Array<{ id: string; disposition: string }>): string[] {
  const explicitlyAccountedFor = new Set(
    mappings
      .filter((mapping) => mapping.disposition !== 'open')
      .map((mapping) => mapping.id),
  );
  return COMPLETE_CONVERSATION_OBLIGATION_IDS.filter((id) => !explicitlyAccountedFor.has(id));
}

describe('plans:audit D-008 writer contract', () => {
  it.each([
    ['doc', { kind: 'doc', ref: '/internal/docs/gate', reason: 'the document describes it' }],
    ['none', { kind: 'none', reason: 'no source was inspected' }],
  ])('refuses implemented backed only by a %s declaration', async (_kind, citation) => {
    const result = await body([{ itemId: 'P-001', verdict: 'implemented', citations: [citation] }]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-001', code: 'implemented_without_code' })]),
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('requires a reason for the metered not-code escape hatch', async () => {
    const result = await body([{ itemId: 'P-001', verdict: 'not-code', citations: [] }]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-001', code: 'not_code_without_reason' })]),
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects work-item intent as a citation kind at the live input schema', () => {
    const parsed = tool.args.safeParse({
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'workitem', ref: 'WI-1' }] }],
    });

    expect(parsed.success).toBe(false);
  });

  it('records a resolving code citation with blob provenance and reports it verified', async () => {
    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
    ]);

    expect(result).toMatchObject({
      ok: true,
      coverage: { auditedItems: 1, verifiedItems: 1, verifiedRatio: 1, unverifiedItemIds: [] },
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            itemId: 'P-001',
            citations: [expect.objectContaining({ kind: 'code', path: 'src/gate.ts', blobSha: expect.any(String) })],
          }),
        ],
      }),
    );
  });

  it('reports an unresolvable citation separately from a harness-root failure', async () => {
    mockContext.mockResolvedValue({
      kind: 'citation_unresolvable',
      citations: [{
        path: 'src/gate.ts',
        symbol: 'missingGateSymbol',
        reason: 'symbol_not_found',
        detail: 'missingGateSymbol not in src/gate.ts',
      }],
    });

    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'missingGateSymbol' }] },
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: 'citation_unresolvable',
      citations: [{ path: 'src/gate.ts', symbol: 'missingGateSymbol', reason: 'symbol_not_found' }],
    });
    expect(result.message).toContain('the harness source root is not the cause');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records valid items from a mixed batch and returns only the rejected item problems', async () => {
    mockItems.mockResolvedValue([
      { itemId: 'P-001', status: 'done', itemText: 'ship the audit gate' },
      { itemId: 'P-002', status: 'done', itemText: 'ship the second gate' },
    ]);
    const resolvingContext = {
      repoRoot: '/repo',
      rootSource: 'canonical-repo' as const,
      deps: {
        statFile: (path: string) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path: string) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path: string) => (path === 'src/gate.ts' ? '0123456789012345678901234567890123456789' : null),
      },
    };
    mockContext.mockImplementation(async (_harness, citations) => {
      if ((citations ?? []).some((citation) => citation.path === 'src/missing.ts')) {
        return {
          kind: 'citation_unresolvable',
          citations: [{ path: 'src/missing.ts', reason: 'file_not_found' }],
        };
      }
      return resolvingContext;
    });

    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
      { itemId: 'P-002', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/missing.ts' }] },
    ]);

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      itemsAuditedThisPass: 1,
      rejectedItemIds: ['P-002'],
    });
    expect(result.problems).toEqual([
      expect.objectContaining({ itemId: 'P-002', code: 'citation_file_not_found' }),
    ]);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ itemId: 'P-001' })],
    }));
    expect((mockRecord.mock.calls[0]![0] as { items?: unknown[] }).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-002' })]),
    );
  });
});

describe('plans:audit phase:activation', () => {
  it('publishes the required planTargets destination grammar on the nested field', () => {
    const projected = lookupByMcpName('plans:audit');
    expect(projected).toBeDefined();
    const schema = projected?.inputSchema as {
      properties?: {
        mappings?: {
          items?: {
            properties?: {
              planTargets?: { description?: string };
            };
          };
        };
      };
    };
    const description = schema.properties?.mappings?.items?.properties?.planTargets?.description;

    expect(description).toContain('P-NNN');
    expect(description).toContain('D-NNN');
    expect(description).toContain('section:<heading>');
    expect(description).toContain('section: prefix is required');
  });

  it('refuses a non-final main wait with an actionable item diagnostic', async () => {
    mockGetPlanRow.mockResolvedValue({
      content: `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-08-27\nupdated: 2026-08-27\nowner: test\n---\n\n## Items\n\n- **P-001** \`todo\` Wait for green-checkpoint before continuing implementation.\n`,
    } as never);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'staging_first_guard_failed',
      problems: [expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' })],
    });
    expect(result.problems[0].detail).toContain('name the deployed-only property');
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it.each([
    '- **P-001** `todo` Final shipment verification waits for green main and :3070.',
    '- **P-001** `todo` Wait for :3070 before closing the deployed-only restart continuity check because staging cannot exercise the deployed-host supervisor restart.',
  ])('records activation for a valid final or reasoned deployed-only item: %s', async (item) => {
    mockGetPlanRow.mockResolvedValue({
      content: `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-08-27\nupdated: 2026-08-27\nowner: test\n---\n\n## Items\n\n${item}\n`,
    } as never);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(mockResolveSourceRefs).toHaveBeenCalled();
    expect(mockRecordActivation).toHaveBeenCalled();
  });

  it('admits omitted or empty coverage arrays at the schema for carry-forward re-audits', () => {
    expect(tool.args.safeParse({ slug: 'plan-a', harness: 'papercusp', phase: 'activation' }).success).toBe(true);
    expect(tool.args.safeParse({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'activation',
      sourceRanges: [],
      mappings: [],
    }).success).toBe(true);
  });

  it('keeps first activation audits nonempty in handler validation', async () => {
    const result = ((await tool.handler({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'activation',
    } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_audit_invalid',
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'source_ranges_required' }),
        expect.objectContaining({ code: 'mappings_required' }),
      ]),
    });
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('carries prior coverage when a re-audit has no new source ranges or mappings', async () => {
    mockPreviousActivation.mockResolvedValue({
      auditSeq: 7,
      activation: {
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'prior-session', fromTurn: 1, toTurn: 9 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:prior-session:4'],
          requirement: 'the original owner boundary remains represented',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: ['prior repair'],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    } as never);
    mockResolveSourceRefs.mockImplementation(async (_sql, _workspaceId, refs) =>
      refs.map((ref) => ({ ref, ok: true as const, source: 'index' as const })),
    );

    const result = ((await tool.handler({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'activation',
      summary: 'decision-only re-audit',
    } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      mappings: 1,
      sourceRanges: 1,
      carriedMappings: 1,
      carriedMappingIds: ['M-001'],
      coverageBaseAuditSeq: 7,
      sourceRefsResolved: 1,
    });
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'prior-session', fromTurn: 1, toTurn: 9 }],
        mappings: [expect.objectContaining({ id: 'M-001' })],
      }),
    }));
  });

  it('uses callable org SQL when skipWorkspaceTx leaves ctx.tx absent', async () => {
    const noTxCtx = {
      ...(ctx as unknown as Record<string, unknown>),
      tx: undefined,
    } as never;

    const result = ((await tool.handler(activationArgs() as never, noTxCtx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(mockResolveSourceRefs).toHaveBeenCalledWith(
      mockOrgSql,
      'test-workspace',
      ['session_turn:codex:session-full-id:7'],
    );
  });

  it('publishes the complete activation workflow and runtime materiality taxonomy on the tool surface', () => {
    const guidance = [
      tool.description,
      tool.guidance?.when,
      tool.guidance?.returns,
      tool.guidance?.chaining,
    ].join('\n');

    expect(guidance).toContain('COMPLETE source conversation');
    expect(guidance).toContain('audited/current revision id/seq/contentHash');
    for (const obligation of [
      'requirement', 'boundary', 'constraint', 'correction', 'rejection', 'decision',
      'dependency', 'sequence', 'acceptance condition', 'open question', 'follow-up',
    ]) {
      expect(guidance).toContain(obligation);
    }
    for (const material of [
      'requirements', 'scope', 'constraints', 'decisions', 'dependencies', 'sequencing',
      'acceptance criteria', 'open questions', 'promised follow-ups',
    ]) {
      expect(guidance).toContain(material);
    }
    for (const cosmetic of ['spelling', 'formatting', 'cosmetic-only wording']) {
      expect(guidance).toContain(cosmetic);
    }
  });

  it('stays within the shared prompt-weight budget', () => {
    expect(promptWeight(tool)).toBeLessThanOrEqual(BUDGET);
  });

  it('resolves every source ref and returns the exact server-captured revision', async () => {
    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      auditSeq: 2,
      sourceRefsResolved: 1,
      auditedPlanRevision: { id: 41, seq: 6, contentHash: 'a'.repeat(64) },
    });
    expect(mockResolveSourceRefs).toHaveBeenCalledWith(
      expect.anything(),
      'test-workspace',
      ['session_turn:codex:session-full-id:7'],
    );
    expect(mockRecordActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'test-workspace',
        planSlug: 'plan-a',
        activation: expect.objectContaining({ mappings: [expect.objectContaining({ id: 'M-001' })] }),
      }),
    );
    // Was `expect(mockItems).not.toHaveBeenCalled()` until P-019 / D-047 wired draft
    // spec-clause derivation into this branch, which reads plan items for its liveness
    // filter. "Never called" was only ever a proxy for the invariant that MATTERS and is
    // asserted directly below: an activation audit's outcome does not depend on plan
    // items being readable. Read here, but only AFTER the audit is durably recorded.
    expect(mockItems).toHaveBeenCalledWith('plan-a');
    expect(mockRecordActivation.mock.invocationCallOrder[0]!).toBeLessThan(
      mockItems.mock.invocationCallOrder[0]!,
    );
  });

  it('records the activation audit even when plan items are unreadable, and reports the derivation', async () => {
    // getPlanItemStatuses swallows its own errors and answers [] — an EMPTY list means
    // UNKNOWN, not "this plan has no items" (D-040). The deriver fails OPEN on unknown
    // rather than skipping every mapping, because skipping would make a failed read
    // indistinguishable from a plan with no realizing mappings. setSpecClause's
    // plan_item_not_found is the backstop that keeps an invalid target from landing.
    mockItems.mockResolvedValue([]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.derivedSpecClauses).toMatchObject({ attempted: 1, created: 1, skipped: [] });
  });

  it('a derivation failure is REPORTED, never propagated — the audit is already recorded', async () => {
    // The audit is durably written before derivation runs. Throwing here would turn a
    // successful audit into a caller-visible failure and invite a retry that re-records
    // nothing — strictly worse than deriving no clauses.
    mockSetSpecClause.mockRejectedValue(new Error('spec clause store unavailable'));

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.derivedSpecClauses).toEqual({ error: 'spec clause store unavailable' });
  });

  it('reports the P-017 under-read verdict, flagging a declared-but-uncited requirement turn', async () => {
    // The fixture declares turns 0-20 and cites only turn 7. Turn 12 carries obligation
    // language and nothing maps it — exactly the self-chosen-denominator gap P-017 opens up.
    mockOrgSql.mockResolvedValue([
      { source_kind: 'codex', session_id: 'session-full-id', turn_idx: 7, speaker: 'user', text: 'the audit must record a complete source range' },
      { source_kind: 'codex', session_id: 'session-full-id', turn_idx: 12, speaker: 'user', text: 'it should never accept a citation outside the declared range' },
    ]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(result.underRead).toMatchObject({
      advisory: true,
      declaredTurns: 21,
      suppliedTurns: 2,
      citedTurns: 1,
      uncitedTurns: 1,
    });
    expect(result.underRead.candidates).toEqual([
      expect.objectContaining({
        ref: 'session_turn:codex:session-full-id:12',
        signals: expect.arrayContaining(['constraint']),
      }),
    ]);
    // 19 of 21 declared turns were never supplied, so this verdict is a FLOOR — an empty
    // candidate list here would NOT have meant "nothing was under-read".
    expect(result.underRead.unsuppliedTurns).toBe(19);
  });

  it('an under-read read failure is REPORTED, never propagated — the audit is already recorded', async () => {
    mockOrgSql.mockRejectedValue(new Error('session_turns unavailable'));

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.underRead).toEqual({ error: 'session_turns unavailable' });
  });

  it('reports the P-018 source-span verdict, flagging turns the audit never declared', async () => {
    // Two different queries share the one sql mock, so route by statement text rather
    // than by call order — the `sql(values)` IN-clause helper is also a call on it, which
    // makes positional mocking fragile in a way that would silently mis-attribute rows.
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first; // the sql(values) helper
      const text = (first as unknown as string[]).join('?');
      if (text.includes('MIN(turn_idx)')) {
        // The fixture declares turns 0-20; the transcript actually runs to 40.
        return Promise.resolve([
          { source_kind: 'codex', session_id: 'session-full-id', min_turn: 0, max_turn: 40 },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(result.sourceSpan).toMatchObject({
      advisory: true,
      transcriptTurns: 41,
      declaredTurns: 21,
      gapTurns: 20,
      unmeasuredSessions: [],
    });
    // A TAIL gap: the audit stopped reading at turn 20 of a 40-turn conversation, which
    // is where corrections and reversals live.
    expect(result.sourceSpan.gaps).toEqual([
      expect.objectContaining({ position: 'tail', fromTurn: 21, toTurn: 40, turnCount: 20 }),
    ]);
  });

  it('an unmeasurable session makes the span verdict inconclusive rather than clean', async () => {
    // Zero gaps here must NOT read as "fully spanned" — the extent query returned nothing,
    // so the detector could not see the session it was asked about.
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first;
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result.sourceSpan.gaps).toEqual([]);
    expect(result.sourceSpan.unmeasuredSessions).toEqual(['codex::session-full-id']);
  });

  it('a source-span read failure is REPORTED, never propagated', async () => {
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first;
      const text = (first as unknown as string[]).join('?');
      if (text.includes('MIN(turn_idx)')) return Promise.reject(new Error('extent read failed'));
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.sourceSpan).toEqual({ error: 'extent read failed' });
  });

  it('derives DRAFT clauses only, so a derivation pass can never gate another plan ship', async () => {
    // plan-spec-coverage-gate enforces only {accepted, active}. An enforceable lifecycle
    // here would let this bulk pass refuse ships it has no business judging.
    await tool.handler(activationArgs() as never, ctx);

    expect(mockSetSpecClause).toHaveBeenCalledWith(
      expect.objectContaining({
        planSlug: 'plan-a',
        planItemId: 'P-001',
        lifecycleStatus: 'draft',
        behaviorClass: 'happy-path',
        expectedRevision: 0,
      }),
    );
    expect(mockSetSpecClause.mock.calls[0]![0]).not.toHaveProperty('falsifier');
  });

  it('carries prior activation mappings and source ranges into a partial additive re-audit', async () => {
    mockPreviousActivation.mockResolvedValue({
      auditSeq: 7,
      activation: {
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'prior-session', fromTurn: 1, toTurn: 9 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:prior-session:4'],
          requirement: 'the original owner boundary remains represented',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: ['prior repair'],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    } as never);
    mockResolveSourceRefs.mockImplementation(async (_sql, _workspaceId, refs) =>
      refs.map((ref) => ({ ref, ok: true as const, source: 'index' as const })),
    );

    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
      mappings: [{
        id: 'M-002',
        sourceRefs: ['session_turn:codex:session-full-id:7'],
        requirement: 'the new material change is mapped additively',
        planTargets: ['P-001'],
        disposition: 'repaired',
      }],
      repairedOmissions: ['new repair'],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      mappings: 2,
      sourceRanges: 2,
      carriedMappings: 1,
      carriedMappingIds: ['M-001'],
      coverageBaseAuditSeq: 7,
    });
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        mappings: [
          expect.objectContaining({ id: 'M-001' }),
          expect.objectContaining({ id: 'M-002' }),
        ],
        repairedOmissions: ['prior repair', 'new repair'],
      }),
    }));
  });

  it('refuses reuse of a stable mapping id for a different requirement', async () => {
    mockPreviousActivation.mockResolvedValue({
      auditSeq: 7,
      activation: {
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:session-full-id:7'],
          requirement: 'the original owner boundary remains represented',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: [],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    } as never);

    const result = ((await tool.handler(activationArgs({
      mappings: [{
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-full-id:7'],
        requirement: 'a different requirement tried to steal the old id',
        planTargets: ['P-001'],
        disposition: 'covered',
      }],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_coverage_regression',
      previousAuditSeq: 7,
      conflicts: [expect.objectContaining({ mappingId: 'M-001', code: 'mapping_id_reused' })],
    });
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('refuses a source ref that sessions:read cannot resolve', async () => {
    mockResolveSourceRefs.mockResolvedValue([
      { ref: 'session_turn:codex:session-full-id:7', ok: false, reason: 'not_found' },
    ]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, phase: 'activation', error: 'source_refs_unresolved' });
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it.each([
    ['an open mapping', {
      mappings: [{
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-full-id:7'],
        requirement: 'The owner constraint has no plan target.',
        planTargets: ['section:Open questions'],
        disposition: 'open',
      }],
    }],
    ['an unresolved blocker', {
      unresolvedBlockers: ['The owner constraint has no plan target.'],
    }],
  ])('refuses %s and returns a claimable repair lane', async (_label, over) => {
    const result = ((await tool.handler(activationArgs(over) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_blocked',
      repairWorkItem: 'EI-ACTIVATION-REPAIR',
      repairFiling: { conditionKey: 'activation-audit:papercusp/plan-a', created: true },
    });
    expect(mockRepairFiling).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'test-workspace',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      activation: expect.objectContaining({ unresolvedBlockers: expect.any(Array) }),
    }));
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('refuses a canonical ref outside every declared source range', async () => {
    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 8, toTurn: 20 }],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, phase: 'activation', error: 'activation_audit_invalid' });
    expect(result.problems).toEqual([
      expect.objectContaining({ itemId: 'M-001', code: 'source_ref_outside_range' }),
    ]);
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
  });

  it('persists an externally-censused scattered conversation map with no missing obligation', async () => {
    const mappings = [
      {
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-full-id:4'],
        requirement: 'Requirement: the export must remain backward compatible.',
        planTargets: ['P-001'],
        disposition: 'covered',
      },
      {
        id: 'M-002',
        sourceRefs: ['session_turn:codex:session-full-id:18'],
        requirement: 'Scope boundary: completion audit behavior remains backward compatible.',
        planTargets: ['section:Requirements'],
        disposition: 'covered',
      },
      {
        id: 'M-003',
        sourceRefs: ['session_turn:codex:session-full-id:34'],
        requirement: 'Constraint: audit references must be directly retrievable.',
        planTargets: ['P-001'],
        disposition: 'covered',
      },
      {
        id: 'M-004',
        sourceRefs: ['session_turn:codex:session-full-id:57', 'session_turn:codex:session-full-id:61'],
        requirement: 'Correction: use the canonical reader rather than the earlier proposed copy.',
        planTargets: ['D-001'],
        disposition: 'repaired',
      },
      {
        id: 'M-005',
        sourceRefs: ['session_turn:codex:session-full-id:82'],
        requirement: 'Rejected alternative: never add a parallel plan-review verb.',
        planTargets: ['D-004'],
        disposition: 'rejected',
      },
      {
        id: 'M-006',
        sourceRefs: ['session_turn:codex:session-full-id:101'],
        requirement: 'Decision: the audit remains after later edits.',
        planTargets: ['D-002'],
        disposition: 'covered',
      },
      {
        id: 'M-007',
        sourceRefs: ['session_turn:codex:session-full-id:119'],
        requirement: 'Dependency: canonical session refs land before activation audit writes.',
        planTargets: ['P-003'],
        disposition: 'covered',
      },
      {
        id: 'M-008',
        sourceRefs: ['session_turn:codex:session-full-id:132'],
        requirement: 'Sequencing: repair omissions before recording the activation audit.',
        planTargets: ['section:Phase 2 — Audit and activation behavior'],
        disposition: 'covered',
      },
      {
        id: 'M-009',
        sourceRefs: ['session_turn:codex:session-full-id:143'],
        requirement: 'Acceptance condition: cosmetic edits preserve the audit.',
        planTargets: ['section:Requirements'],
        disposition: 'covered',
      },
      {
        id: 'M-010',
        sourceRefs: ['session_turn:codex:session-full-id:167'],
        requirement: 'Open question resolved: the editing agent judges semantic materiality.',
        planTargets: ['D-002'],
        disposition: 'covered',
      },
      {
        id: 'M-011',
        sourceRefs: ['session_turn:codex:session-full-id:198'],
        requirement: 'A promised follow-up must remain represented in the execution plan.',
        planTargets: ['P-006'],
        disposition: 'covered',
      },
    ];
    const refs = mappings.flatMap((mapping) => mapping.sourceRefs);
    mockResolveSourceRefs.mockImplementation(async (_sql, _workspaceId, requested) =>
      requested.map((ref) => ({ ref, ok: true as const, source: 'index' as const })),
    );

    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 220 }],
      mappings,
      repairedOmissions: ['Replaced the superseded copy design with the canonical reader.'],
      rejectedOrSuperseded: ['Rejected automatic invalidation after cosmetic edits.'],
    }) as never, ctx)) as { data: any }).data;

    expect(missingConversationObligations(mappings)).toEqual([]);
    expect(result).toMatchObject({ ok: true, phase: 'activation', sourceRefsResolved: refs.length });
    expect(mockResolveSourceRefs).toHaveBeenCalledWith(expect.anything(), 'test-workspace', refs);
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        mappings,
        repairedOmissions: ['Replaced the superseded copy design with the canonical reader.'],
        rejectedOrSuperseded: ['Rejected automatic invalidation after cosmetic edits.'],
        unresolvedBlockers: [],
      }),
    }));
  });

  it('the external completeness oracle catches one omitted obligation before writer acceptance', () => {
    const mappings = COMPLETE_CONVERSATION_OBLIGATION_IDS.slice(0, -1).map((id) => ({
      id,
      disposition: 'covered',
    }));

    expect(missingConversationObligations(mappings)).toEqual(['M-011']);
  });
});
