import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import triageTool from './triage';
import { applyTriageDecision } from '../../harness/improvements/triage-core';
import type { ScoredItem, ImprovementDigest } from '../../harness/improvements/digest';
import type { ImprovementCandidate } from '../../harness/improvements/policy';

// Mock the dependencies
vi.mock('../../harness/improvements/read-items');
vi.mock('../../harness/improvements/digest');
vi.mock('../coordination/identity');
// The tool now PERSISTS triage-one via triage-core (learning-system-audit P-010)
// — mock the core so the unit test stays PG-free; triage-core has its own tests.
vi.mock('../../harness/improvements/triage-core');
// The tool ranks the human lane through the ONE queue ranker (frontier
// P-040/P-045) — stub it shape-faithfully (a rank breakdown attached per item)
// so the unit test stays PG-free; the ranker's real behavior is pinned in
// lib/queue-ranker/human-queue.test.ts.
vi.mock('../../queue-ranker/human-queue', () => ({
  applyHumanQueueRanking: vi.fn(async (digest: { humanQueue: unknown[] }) => ({
    ...digest,
    humanQueue: digest.humanQueue.map((item) => ({
      ...(item as Record<string, unknown>),
      rank: {
        score: 1,
        features: [{ feature: 'blocking-impact', value: 1, weight: 1, contribution: 1, reasons: [] }],
      },
    })),
  })),
  humanQueueRankerSpec: vi.fn(() => [{ name: 'blocking-impact', weight: 1, description: 'stub' }]),
}));

const mockReadImprovementItems = vi.mocked(readImprovementItems);
const mockBuildDigest = vi.mocked(buildDigest);
const mockApplyTriageDecision = vi.mocked(applyTriageDecision);

describe('improvements:triage tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyTriageDecision.mockImplementation(async (input) => ({
      ok: true,
      id: input.id,
      decision: input.decision,
      lifecycle: {
        state: 'triaged',
        stateUpdatedAt: new Date().toISOString(),
        triageDecision: input.decision,
        triageReason: input.reason,
      },
      closed: input.decision === 'reject',
    }));
  });

  const mockItem = (p: Partial<ScoredItem> & { id: string }): ScoredItem => ({
    id: p.id,
    kind: p.kind || 'change',
    severity: p.severity || 'minor',
    title: p.title || 'test idea',
    scope: p.scope || 'harness:papercup',
    tier: p.tier || 'human',
    score: p.score || 0.5,
    ageDays: p.ageDays || 0,
    tierReason: p.tierReason || 'test reason',
    ...p,
  });

  it('has correct tool metadata', () => {
    expect(triageTool).toBeDefined();
    expect(triageTool.name).toBe('improvements:triage');
    expect(triageTool.description).toContain('D-005 taxonomy');
    expect(triageTool.guidance).toBeDefined();
    expect(triageTool.guidance.when).toBeDefined();
  });

  describe('handler - summary mode', () => {
    it('returns digest summary without applying decisions', async () => {
      const items = [
        mockItem({ id: '1', scope: 'harness:sheets' }),
        mockItem({ id: '2', scope: 'operator' }),
      ];
      mockReadImprovementItems.mockResolvedValue(items);
      mockBuildDigest.mockReturnValue({
        total: 2,
        open: 2,
        byKind: { bug: 0, change: 2, feature: 0 },
        autoEligible: [],
        humanQueue: items,
      });

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'summary' }, ctx)) as any;

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(true);
      expect(response.mode).toBe('summary');
      expect(response.digest.total).toBe(2);
      expect(response.triageSummary).toBeDefined();
      // The one ranker's registry rides along as data (P-040/P-045, D-005).
      expect(response.ranker).toEqual([{ name: 'blocking-impact', weight: 1, description: 'stub' }]);
    });

    it('defaults to summary mode when no mode is specified', async () => {
      const items = [mockItem({ id: '1' })];
      mockReadImprovementItems.mockResolvedValue(items);
      mockBuildDigest.mockReturnValue({
        total: 1,
        open: 1,
        byKind: { bug: 0, change: 1, feature: 0 },
        autoEligible: [],
        humanQueue: items,
      });

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({}, ctx)) as any;

      expect(result.content).toBeDefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.mode).toBe('summary');
      expect(response.ok).toBe(true);
    });
  });

  describe('handler - triage-all mode', () => {
    it('classifies all open ideas and shows decisions', async () => {
      const items = [
        mockItem({ id: '1', scope: 'harness:sheets', title: 'add feature' }),
        mockItem({ id: '2', scope: 'operator', title: 'fix scheduler' }),
      ];
      mockReadImprovementItems.mockResolvedValue(items);
      mockBuildDigest.mockReturnValue({
        total: 2,
        open: 2,
        byKind: { bug: 0, change: 2, feature: 0 },
        autoEligible: [],
        humanQueue: items,
      });

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'triage-all' }, ctx)) as any;

      expect(result.content).toBeDefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(true);
      expect(response.mode).toBe('triage-all');
      expect(response.decisions).toBeDefined();
      expect(Array.isArray(response.decisions)).toBe(true);
      expect(response.decisions.length).toBe(2);

      // Check that decisions are populated
      const productDecision = response.decisions.find((d: any) => d.id === '1');
      const processDecision = response.decisions.find((d: any) => d.id === '2');
      expect(productDecision.decision).toBe('place');
      expect(processDecision.decision).toBe('gate');

      // Human-queue items carry the P-040 rank breakdown for the Queen's walk.
      expect(productDecision.rankScore).toBe(1);
      expect(productDecision.rankFeatures).toEqual(['blocking-impact: 1.00']);
    });

    it('includes the Queen\'s instructions in the response', async () => {
      mockReadImprovementItems.mockResolvedValue([]);
      mockBuildDigest.mockReturnValue({
        total: 0,
        open: 0,
        byKind: { bug: 0, change: 0, feature: 0 },
        autoEligible: [],
        humanQueue: [],
      });

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'triage-all' }, ctx)) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.note).toContain('Queen');
      expect(response.note).toContain('triage-one');
    });
  });

  describe('handler - triage-one mode', () => {
    it('requires ideaId and rejects without it', async () => {
      mockReadImprovementItems.mockResolvedValue([]);
      mockBuildDigest.mockReturnValue({
        total: 0,
        open: 0,
        byKind: { bug: 0, change: 0, feature: 0 },
        autoEligible: [],
        humanQueue: [],
      });

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'triage-one' }, ctx)) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('ideaId');
    });

    it('requires decision and reason, rejects if missing', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler(
        { mode: 'triage-one', ideaId: 'idea-1' },
        ctx,
      )) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('decision');
      expect(response.error).toContain('reason');
    });

    it('records the Queen\'s decision for a single idea', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler(
        {
          mode: 'triage-one',
          ideaId: 'idea-123',
          decision: 'place',
          reason: 'Ready to implement',
        },
        ctx,
      )) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(true);
      expect(response.mode).toBe('triage-one');
      expect(response.ideaId).toBe('idea-123');
      expect(response.decision).toBe('place');
      expect(response.reason).toBe('Ready to implement');
      expect(response.lifecycle).toBeDefined();
      expect(response.lifecycle.state).toBe('triaged');
      expect(response.lifecycle.triageDecision).toBe('place');
    });

    it('accepts valid triage decisions', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const decisions: Array<'place' | 'gate' | 'gym' | 'reject'> = [
        'place',
        'gate',
        'gym',
        'reject',
      ];

      for (const decision of decisions) {
        const result = (await triageTool.handler(
          {
            mode: 'triage-one',
            ideaId: `idea-${decision}`,
            decision,
            reason: `Test ${decision}`,
          },
          ctx,
        )) as any;

        const response = JSON.parse(result.content[0].text);
        expect(response.ok).toBe(true);
        expect(response.decision).toBe(decision);
      }
    });

    it('includes guidance for next steps in the response', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler(
        {
          mode: 'triage-one',
          ideaId: 'idea-1',
          decision: 'place',
          reason: 'Ready',
        },
        ctx,
      )) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.note).toBeDefined();
      expect(response.note).toContain('work_items');
    });
  });

  describe('handler - unknown mode', () => {
    it('returns error for unknown mode', async () => {
      mockReadImprovementItems.mockResolvedValue([]);
      mockBuildDigest.mockReturnValue({
        total: 0,
        open: 0,
        byKind: { bug: 0, change: 0, feature: 0 },
        autoEligible: [],
        humanQueue: [],
      });

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'unknown' as any }, ctx)) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('Unknown mode');
    });
  });
});
