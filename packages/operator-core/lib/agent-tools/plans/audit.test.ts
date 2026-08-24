/**
 * plans:audit writer-contract guard (plan-completion-audit-and-acceptance-verdict
 * D-008). These are handler/schema tests, not just coverage-fold tests: they pin
 * the exact boundary that decides whether an auditor actually read code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
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
    repoCitationContextForHarness: vi.fn(),
    recordPlanAudit: vi.fn(),
    recordCurrentActivationAudit: vi.fn(),
  };
});

import {
  getEffectiveItemAudits,
  getPlanItemStatuses,
  recordCurrentActivationAudit,
  recordPlanAudit,
  repoCitationContextForHarness,
} from '../../plan-audits';
import { resolveSessionTurnRefs } from '../sessions/_shared';
import tool from './audit';

const mockItems = vi.mocked(getPlanItemStatuses);
const mockPrevious = vi.mocked(getEffectiveItemAudits);
const mockContext = vi.mocked(repoCitationContextForHarness);
const mockRecord = vi.mocked(recordPlanAudit);
const mockRecordActivation = vi.mocked(recordCurrentActivationAudit);
const mockResolveSourceRefs = vi.mocked(resolveSessionTurnRefs);

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
  mockPrevious.mockResolvedValue([]);
  mockContext.mockResolvedValue({
    repoRoot: '/repo',
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
});

describe('plans:audit phase:activation', () => {
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
    expect(mockItems).not.toHaveBeenCalled();
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
  ])('refuses %s before touching either store', async (_label, over) => {
    const result = ((await tool.handler(activationArgs(over) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, phase: 'activation', error: 'activation_blocked' });
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
