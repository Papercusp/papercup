/** scorecards:get — the evidence-first single-card audit read. */
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

vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, readScorecardEvidence: vi.fn() };
});

import { readScorecardEvidence } from '../../scorecards';

const readScorecardEvidenceM = vi.mocked(readScorecardEvidence);
const getTool = (await import('./get')).default;

const makeDispatchContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'scorecards-get-evidence-test',
  isSuperuser: true,
  uiClientId: 'su-scorecards-get-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
});

const scorecard = {
  issueId: 'EI-audited-card',
  createdAt: '2026-09-08T19:00:00.000Z',
  createdBy: 'su-grader',
  rubricRef: 'spec-test-adequacy',
  rubricRevision: 2,
  criteriaHash: 'criteria-hash-v2',
  subject: { kind: 'scorecard' as const, ref: 'EI-subject' },
  criteria: Array.from({ length: 8 }, (_, i) => ({
    key: `criterion-${i + 1}`,
    rating: i === 7 ? 'partial' : 'pass',
    evidence: `run probe criterion-${i + 1}: ${'e'.repeat(1200)}`,
  })),
  nKeys: 8,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
};

describe('scorecards:get evidence-first projection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps every exact evidence string through trimmed projected dispatch', async () => {
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard });
    const raw = (await getTool.handler(
      { issueId: scorecard.issueId } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-get-test', workspaceId: 'default' } as never,
    )) as { data: unknown };
    const rawChars = JSON.stringify(raw).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('scorecards:get');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:get',
      { issueId: scorecard.issueId },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      ok: boolean;
      scorecard: typeof scorecard;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.scorecard.criteria).toHaveLength(8);
    expect(payload?.scorecard.criteria[0]?.evidence).toBe(scorecard.criteria[0]?.evidence);
    expect(payload?.scorecard.criteria[7]?.evidence).toBe(scorecard.criteria[7]?.evidence);
    expect(Object.keys(payload?.scorecard ?? {}).sort()).toEqual([
      'createdAt',
      'createdBy',
      'criteriaHash',
      'criteria',
      'extraKeys',
      'issueId',
      'missingKeys',
      'nKeys',
      'rubricRef',
      'rubricResolved',
      'rubricRevision',
      'subject',
      'synthesized',
    ].sort());
  });

  it('returns precise missing/not-scorecard errors without a wide history row', async () => {
    readScorecardEvidenceM.mockResolvedValueOnce({ kind: 'not_found' });
    await expect(getTool.handler({ issueId: 'EI-missing' } as never, makeDispatchContext())).resolves.toMatchObject({
      data: { ok: false, error: "scorecard 'EI-missing' not found" },
    });
    readScorecardEvidenceM.mockResolvedValueOnce({ kind: 'not_scorecard' });
    await expect(getTool.handler({ issueId: 'WI-not-card' } as never, makeDispatchContext())).resolves.toMatchObject({
      data: { ok: false, error: "'WI-not-card' is not a scorecard" },
    });
  });

  it('makes oversized cards explicitly incomplete and recovers every probe through bounded dispatch pages', async () => {
    const large = {
      ...scorecard,
      criteria: scorecard.criteria.map((criterion) => ({
        ...criterion,
        evidence: `${'"\\\n🙂'.repeat(4_000)} Re-run exact-probe ${criterion.key} with args={"frozen":true}`,
      })),
    };
    expect(JSON.stringify(large).length).toBeGreaterThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: large });
    const read = async (args: Record<string, unknown>) => {
      const dispatched = await dispatchProjectedTool(
        lookupByMcpName('scorecards:get')!, 'scorecards:get', args, makeDispatchContext(), {},
      );
      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
      const payload = readJsonResult<{
        ok: boolean;
        scorecard: typeof scorecard;
        evidenceRead: {
          complete: boolean;
          criteria?: Array<{ key: string; read: { tool: string; args: Record<string, unknown> } }>;
          next?: { tool: string; args: Record<string, unknown> };
        };
        _projection?: unknown;
      }>(dispatched.result!)!;
      expect(payload._projection).toBeUndefined();
      expect(JSON.stringify(payload).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
      return payload;
    };
    const index = await read({ issueId: large.issueId });
    expect(index.evidenceRead.complete).toBe(false);
    expect(index.scorecard.criteria).toEqual([]);
    expect(index.evidenceRead.criteria?.map((entry) => entry.key)).toEqual(large.criteria.map((entry) => entry.key));
    for (const entry of index.evidenceRead.criteria!) {
      let args: Record<string, unknown> | undefined = entry.read.args;
      let recovered = '';
      let pages = 0;
      while (args) {
        expect(++pages).toBeLessThan(30);
        const page = await read(args);
        expect(page.scorecard.criteria).toHaveLength(1);
        expect(page.scorecard.criteria[0].key).toBe(entry.key);
        recovered += page.scorecard.criteria[0].evidence;
        if (!page.evidenceRead.complete) expect(page.evidenceRead.next).toBeDefined();
        args = page.evidenceRead.next?.args;
      }
      expect(pages).toBeGreaterThan(1);
      expect(recovered).toBe(large.criteria.find((criterion) => criterion.key === entry.key)!.evidence);
      expect(recovered).toContain(`Re-run exact-probe ${entry.key}`);
    }
  });

  it('guides oversized audits to parallelize independent criteria while preserving page order', () => {
    const tool = lookupByMcpName('scorecards:get');
    const chaining = (tool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(chaining).toContain('Promise.all');
    expect(chaining).toContain('each criterion’s evidenceRead.next page loop sequential');
  });

  it('rejects unknown criterion keys and out-of-range offsets instead of returning empty evidence', async () => {
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard });
    await expect(getTool.handler(
      { issueId: scorecard.issueId, criterionKey: 'missing' } as never, makeDispatchContext(),
    )).resolves.toMatchObject({ data: { ok: false, error: 'unknown_criterion' } });
    await expect(getTool.handler(
      { issueId: scorecard.issueId, criterionKey: 'criterion-1', evidenceOffset: 999_999 } as never,
      makeDispatchContext(),
    )).resolves.toMatchObject({ data: { ok: false, error: 'invalid_evidence_offset' } });
  });

  it('fails explicitly when even the criterion index cannot fit instead of letting transport silently trim it', async () => {
    readScorecardEvidenceM.mockResolvedValue({
      kind: 'found',
      scorecard: { ...scorecard, criteria: Array.from({ length: 300 }, (_, i) => ({
        key: `criterion-${i}`, rating: 'pass', evidence: 'x'.repeat(200),
      })) },
    });
    const dispatched = await dispatchProjectedTool(
      lookupByMcpName('scorecards:get')!, 'scorecards:get',
      { issueId: scorecard.issueId }, makeDispatchContext(), {},
    );
    expect(readJsonResult(dispatched.result!)).toMatchObject({
      ok: false, error: 'scorecard_index_exceeds_inline_budget',
    });
  });

  it('preserves typed transient contention failures', async () => {
    readScorecardEvidenceM.mockRejectedValueOnce(new OrgTxnTimeoutError('55P03', new Error('lock timeout')));
    await expect(getTool.handler({ issueId: 'EI-card' } as never, makeDispatchContext())).resolves.toMatchObject({
      data: { ok: false, error: 'timeout', retryable: true, pgCode: '55P03' },
    });
    readScorecardEvidenceM.mockRejectedValueOnce(
      new DbCallDeadlineError('boundedPgReadTxn:acquire(admin)', 8000, 8000, 'org-admin'),
    );
    await expect(getTool.handler({ issueId: 'EI-card' } as never, makeDispatchContext())).resolves.toMatchObject({
      data: { ok: false, error: 'timeout', retryable: true },
    });
  });
});
