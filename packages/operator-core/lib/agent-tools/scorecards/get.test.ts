/** scorecards:get — the evidence-first single-card audit read. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, readScorecardEvidence: vi.fn() };
});

import { readScorecardEvidence } from '../../scorecards';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { applyResultDoor, resetResultDoorAggregatesForTests } from '../../result-door';

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
  evidenceFingerprint: 'evidence-fingerprint-v2',
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
  auditTarget: { current: true, superseded: false, supersededBy: null, retracted: false, subjectRubricCurrentness: null },
};

describe('scorecards:get evidence-first projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
    resetResultDoorAggregatesForTests();
  });

  it('declares optional result roots with concrete scorecard and paging fields', () => {
    const missingCard = getTool.result.safeParse({
      ok: false,
      error: "scorecard 'EI-missing' not found",
    });
    expect(missingCard.success).toBe(true);

    const index = getTool.result.safeParse({
      ok: true,
      scorecard: { ...scorecard, criteria: [] },
      evidenceRead: {
        complete: false,
        reason: 'card-exceeds-inline-budget',
        criteria: [{
          key: 'traceability',
          rating: 'pass',
          evidenceChars: 120,
          read: {
            tool: 'scorecards:get',
            args: { issueId: scorecard.issueId, criterionKey: 'traceability', evidenceOffset: 0 },
          },
        }],
      },
    });
    expect(index.success).toBe(true);

    const page = getTool.result.safeParse({
      ok: true,
      scorecard: { ...scorecard, criteria: [{ ...scorecard.criteria[0], evidence: 'evidence page' }] },
      evidenceRead: {
        complete: false,
        scope: 'selected-criterion',
        offset: 0,
        totalChars: 120,
        next: {
          tool: 'scorecards:get',
          args: { issueId: scorecard.issueId, criterionKey: 'traceability', evidenceOffset: 13 },
        },
      },
    });
    expect(page.success).toBe(true);
    expect(getTool.result.safeParse({ ok: true, scorecard: {} }).success).toBe(false);
  });

  it('keeps a complete criterion page inside the outer model-facing result door', async () => {
    const evidence = 'e'.repeat(6093);
    const card = {
      ...scorecard,
      criteria: [{ key: 'traceability', rating: 'pass', evidence }],
    };
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: card });
    const scratchRoot = mkdtempSync(join(tmpdir(), 'scorecards-get-result-door-'));
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousDoorOff = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(scratchRoot, 'scratch');
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    try {
      const response = (await getTool.handler(
        { issueId: card.issueId, criterionKey: 'traceability' } as never,
        makeDispatchContext(),
      )) as { data: unknown };
      const resultText = JSON.stringify(response.data);
      const budgetChars =
        computeTurnDoors(0, BAKED_DOOR_CONSTANTS).resultEach * CHARS_PER_TOKEN_ESTIMATE;
      const unpagedText = JSON.stringify({
        ok: true,
        scorecard: card,
        evidenceRead: { complete: true, scope: 'selected-criterion', offset: 0, totalChars: evidence.length },
      });
      expect(unpagedText.length).toBeGreaterThan(budgetChars);
      const unpaged = applyResultDoor(
        { content: [{ type: 'text' as const, text: unpagedText }], _meta: {} as Record<string, unknown> },
        { toolName: 'scorecards:get', workspaceId: 'scorecards-get-test' },
      );
      const unpagedDoor = (unpaged._meta.resultDoor as { truncated?: boolean } | undefined);
      expect(unpagedDoor?.truncated).toBe(true);
      expect(resultText.length).toBeLessThanOrEqual(budgetChars);

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: resultText }], _meta: {} as Record<string, unknown> },
        { toolName: 'scorecards:get', workspaceId: 'scorecards-get-test' },
      );
      const resultDoor = doored._meta.resultDoor as { truncated?: boolean } | undefined;
      expect(resultDoor?.truncated).not.toBe(true);
      const payload = JSON.parse((doored.content[0] as { text: string }).text) as {
        scorecard: { criteria: Array<{ evidence: string }> };
        evidenceRead: {
          complete: boolean;
          offset: number;
          totalChars: number;
          next?: { args: { evidenceOffset: number } };
        };
      };
      expect(payload.evidenceRead).toMatchObject({ complete: false, offset: 0, totalChars: evidence.length });
      expect(payload.scorecard.criteria[0]?.evidence).toBe(evidence.slice(0, payload.scorecard.criteria[0].evidence.length));
      expect(payload.scorecard.criteria[0]?.evidence.length).toBeLessThan(evidence.length);
      expect(payload.evidenceRead.next?.args.evidenceOffset).toBe(payload.scorecard.criteria[0]?.evidence.length);
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
      if (previousDoorOff === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousDoorOff;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('keeps every exact evidence string recoverable through trimmed projected dispatch', async () => {
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard });
    const raw = (await getTool.handler(
      { issueId: scorecard.issueId } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-get-test', workspaceId: 'default' } as never,
    )) as { data: unknown };
    const rawChars = JSON.stringify(raw.data).length;
    const resultDoorChars =
      computeTurnDoors(0, BAKED_DOOR_CONSTANTS).resultEach * CHARS_PER_TOKEN_ESTIMATE;
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThanOrEqual(resultDoorChars);

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
      scorecard: { criteria: Array<{ key: string }>; evidenceFingerprint: string };
      evidenceRead: {
        complete: boolean;
        criteria: Array<{ key: string; read: { args: Record<string, unknown> } }>;
      };
      _projection?: unknown;
    }>(dispatched.result!);
    if (!payload) throw new Error('scorecards:get dispatch should return JSON');
    expect(payload?._projection).toBeUndefined();
    expect(payload?.scorecard.criteria).toHaveLength(0);
    expect(payload?.scorecard.evidenceFingerprint).toBe('evidence-fingerprint-v2');
    expect(payload?.evidenceRead.complete).toBe(false);
    expect(payload?.evidenceRead.criteria.map(({ key }) => key)).toEqual(scorecard.criteria.map(({ key }) => key));
    for (const expected of scorecard.criteria) {
      const entry = payload.evidenceRead.criteria.find(({ key }) => key === expected.key)!;
      const page = await dispatchProjectedTool(
        projected!,
        'scorecards:get',
        entry.read.args,
        makeDispatchContext(),
        {},
      );
      expect(page.ok, JSON.stringify(page)).toBe(true);
      const recovered = readJsonResult<{
        scorecard: { criteria: Array<{ key: string; rating: string; evidence: string }> };
        evidenceRead: { complete: boolean };
      }>(page.result!);
      expect(recovered?.evidenceRead.complete).toBe(true);
      expect(recovered?.scorecard.criteria).toEqual([expected]);
    }
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

  it('bounds parallel criterion reads and explains how to recover output-door envelopes', () => {
    const tool = lookupByMcpName('scorecards:get');
    const chaining = (tool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(chaining).toContain('Promise.all');
    expect(chaining).toContain('small Promise.all groups');
    expect(chaining).toContain('papercusp.output-envelope/v1');
    expect(chaining).toContain('capability:read');
    expect(chaining).toContain('before reading scorecard.criteria');
    expect(chaining).toContain('pages sequentially');
    expect(chaining).toContain('Concatenate complete pages');
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
