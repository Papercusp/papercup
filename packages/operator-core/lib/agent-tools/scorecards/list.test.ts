/**
 * scorecards:list — correctness payloads must survive the ambient trimmed tier.
 *
 * A scorecard's ratings map is the grading evidence, not a browseable row list.
 * If the generic tier shaper trims that nested map before the result door spills
 * it, a partial card can look complete and manufacture a false pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import type { ScorecardRow } from '../../scorecards';

vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...actual,
    listScorecardPage: vi.fn(async () => ({ rows: [] as ScorecardRow[], hasMore: false })),
  };
});

import { listScorecardPage } from '../../scorecards';

const listScorecardPageM = vi.mocked(listScorecardPage);
const listTool = (await import('./list')).default;

const makeDispatchContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'scorecards-list-completeness-test',
  isSuperuser: true,
  uiClientId: 'su-scorecards-list-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
});

describe('scorecards:list correctness payload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps every criterion through an ambient trimmed dispatch', async () => {
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      selection: {
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: 'sha256:spec-v1',
        evidence: [{ evidenceKind: 'integration fixture', evidenceRef: 'surface:reconnect' }],
      },
      current: { supplied: false, fingerprints: [] },
      derivation: {
        kind: 'listSpecEvidence.currentness',
        classifier: 'classifySpecEvidenceCurrentness',
        unknownWhenMissing: true,
      },
    };
    const ratings = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `criterion-${i + 1}`,
        { rating: i < 4 ? 'healthy' : 'degraded', evidence: `evidence-${i + 1} ${'e'.repeat(1200)}` },
      ]),
    );
    const scorecard = {
      issueId: 'EI-scorecard-test',
      createdAt: '2026-08-25T00:00:00.000Z',
      createdBy: 'su-test',
      rubricRef: 'acceptance-test-rubric',
      ratings,
      nKeys: 7,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      rerunRecipe,
      synthesized: false,
      score10: 7.9,
      linkedItems: [],
    } as unknown as ScorecardRow;
    listScorecardPageM.mockResolvedValue({ rows: [scorecard], hasMore: true });

    const raw = (await listTool.handler(
      { rubricRef: 'acceptance-test-rubric' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: unknown };
    expect(raw.data).toMatchObject({
      ok: true,
      count: 1,
      hasMore: true,
      truncatedByLimit: true,
      nextCursor: { createdAt: scorecard.createdAt, issueId: scorecard.issueId },
    });
    const rawChars = JSON.stringify(raw).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('scorecards:list');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);

    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:list',
      { rubricRef: 'acceptance-test-rubric' },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      ok: boolean;
      count: number;
      hasMore: boolean;
      truncatedByLimit: boolean;
      nextCursor: { createdAt: string; issueId: string } | null;
      scorecards: Array<{
        ratings: Record<string, unknown>;
        nKeys: number;
        missingKeys: string[];
        rerunRecipe?: unknown;
      }>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.count).toBe(1);
    expect(payload?.hasMore).toBe(true);
    expect(payload?.truncatedByLimit).toBe(true);
    expect(payload?.nextCursor).toEqual({ createdAt: scorecard.createdAt, issueId: scorecard.issueId });
    expect(payload?.scorecards[0]?.nKeys).toBe(7);
    expect(Object.keys(payload?.scorecards[0]?.ratings ?? {})).toHaveLength(7);
    expect(payload?.scorecards[0]?.missingKeys).toEqual([]);
    expect(payload?.scorecards[0]?.rerunRecipe).toEqual(rerunRecipe);
  });

  it('accepts the returned keyset cursor and passes it to the scorecard page reader', async () => {
    const cursor = { createdAt: '2026-08-24T00:00:00.000Z', issueId: 'EI-scorecard-previous-page' };
    listScorecardPageM.mockResolvedValueOnce({ rows: [], hasMore: false });

    const result = (await listTool.handler(
      { rubricRef: 'acceptance-test-rubric', cursor } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: Record<string, unknown> };

    expect(listScorecardPageM).toHaveBeenCalledWith(
      expect.objectContaining({ rubricRef: 'acceptance-test-rubric', before: cursor, includeLinks: true }),
    );
    expect(result.data).toMatchObject({ ok: true, hasMore: false, nextCursor: null });
  });

  it('returns a typed retryable envelope when the bounded read exhausts contention retries', async () => {
    listScorecardPageM.mockRejectedValueOnce(new OrgTxnTimeoutError('55P03', new Error('lock timeout')));

    const result = (await listTool.handler(
      { subjectRef: 'EI-subject' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
    });
    expect(result.data.message).toContain('retry shortly');
  });

  it('returns a typed retryable envelope when acquisition misses its deadline', async () => {
    listScorecardPageM.mockRejectedValueOnce(
      new DbCallDeadlineError('boundedPgReadTxn:acquire(admin)', 8000, 8000, 'org-admin'),
    );

    const result = (await listTool.handler(
      { subjectRef: 'EI-subject' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
    });
    expect(result.data.pgCode).toBeUndefined();
    expect(result.data.message).toContain('retry shortly');
  });

  it('accepts a harness compatibility hint without filtering the workspace-wide read', async () => {
    listScorecardPageM.mockResolvedValueOnce({ rows: [], hasMore: false });

    const projected = lookupByMcpName('scorecards:list');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:list',
      { rubricRef: 'acceptance-test-rubric', harness: 'papercusp' },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(readJsonResult(dispatched.result!)).toMatchObject({
      ok: true,
      count: 0,
      hasMore: false,
      truncatedByLimit: false,
      nextCursor: null,
      scorecards: [],
    });
    expect(listScorecardPageM).toHaveBeenCalledWith({
      rubricRef: 'acceptance-test-rubric',
      includeLinks: true,
    });
  });

  it('documents the scalar subjectRef list filter separately from emit\'s structured subject', () => {
    const projected = lookupByMcpName('scorecards:list');
    expect(projected).toBeDefined();
    expect(projected?.description).toContain('subjectRef');
    expect(projected?.description).toContain('scorecards:emit');
    expect(projected?.description).toContain('composite `spec-set:<classRef>:<specSetHash>:<planKey>`');
    expect(projected?.description).toContain('not a plan or pot slug');
    expect(projected?.guidance?.when).toContain('subjectRef');
    expect(projected?.guidance?.when).toContain('subject:{kind,ref}');
    expect(projected?.guidance?.when).toContain('exact composite `spec-set:<classRef>:<specSetHash>:<planKey>` subject ref');
    expect(projected?.guidance?.chaining).toContain('subjectRef: "EI-123"');

    const subjectRefDescription = (
      listTool as unknown as { args: { shape: { subjectRef: { description?: string } } } }
    ).args.shape.subjectRef.description;
    expect(subjectRefDescription).toContain('composite `spec-set:<classRef>:<specSetHash>:<planKey>`');
    expect(subjectRefDescription).toContain('not the plan or pot slug');
  });
});
