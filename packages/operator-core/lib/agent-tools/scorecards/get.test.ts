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
  subject: { kind: 'scorecard', ref: 'EI-subject' },
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
