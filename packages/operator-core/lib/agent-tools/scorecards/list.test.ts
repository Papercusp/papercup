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
import type { ScorecardRow } from '../../scorecards';

vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return { ...actual, listScorecards: vi.fn(async () => [] as ScorecardRow[]) };
});

import { listScorecards } from '../../scorecards';

const listScorecardsM = vi.mocked(listScorecards);
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
      synthesized: false,
      score10: 7.9,
      linkedItems: [],
    } as unknown as ScorecardRow;
    listScorecardsM.mockResolvedValue([scorecard]);

    const raw = (await listTool.handler(
      { rubricRef: 'acceptance-test-rubric' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: unknown };
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
      scorecards: Array<{ ratings: Record<string, unknown>; nKeys: number; missingKeys: string[] }>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.count).toBe(1);
    expect(payload?.scorecards[0]?.nKeys).toBe(7);
    expect(Object.keys(payload?.scorecards[0]?.ratings ?? {})).toHaveLength(7);
    expect(payload?.scorecards[0]?.missingKeys).toEqual([]);
  });
});
