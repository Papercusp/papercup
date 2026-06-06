import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import triageTool from './triage';
import type { ScoredItem } from '../../harness/improvements/digest';

// Mock the dependencies
vi.mock('../../harness/improvements/read-items');
vi.mock('../../harness/improvements/digest');
vi.mock('../coordination/identity');

const mockReadImprovementItems = vi.mocked(readImprovementItems);
const mockBuildDigest = vi.mocked(buildDigest);

describe('improvements:triage tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockItem = (p: Partial<ScoredItem> & { id: string }): ScoredItem => ({
    id: p.id,
    kind: p.kind || 'change',
    severity: p.severity || 'minor',
    title: p.title || 'test idea',
    scope: p.scope || 'harness:papercup',
    paths: p.paths || [],
    score: p.score || 0.5,
    recurrenceDecay: p.recurrenceDecay || 1,
    createdAt: p.createdAt || new Date().toISOString(),
    ...p,
  });

  it('has correct tool metadata', () => {
    expect(triageTool).toBeDefined();
    expect(triageTool.name).toBe('improvements:triage');
    expect(triageTool.description).toContain('type-route');
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
      const result = await triageTool.handler({ mode: 'summary' }, ctx);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(true);
      expect(response.mode).toBe('summary');
      expect(response.digest.total).toBe(2);
      expect(response.triageSummary).toBeDefined();
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
      const result = await triageTool.handler({}, ctx);

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
      const result = await triageTool.handler({ mode: 'triage-all' }, ctx);

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
      const result = await triageTool.handler({ mode: 'triage-all' }, ctx);

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
      const result = await triageTool.handler({ mode: 'triage-one' }, ctx);

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('ideaId');
    });

    it('requires decision and reason, rejects if missing', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = await triageTool.handler(
        { mode: 'triage-one', ideaId: 'idea-1' },
        ctx,
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('decision');
      expect(response.error).toContain('reason');
    });

    it('records the Queen\'s decision for a single idea', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = await triageTool.handler(
        {
          mode: 'triage-one',
          ideaId: 'idea-123',
          decision: 'place',
          reason: 'Ready to implement',
        },
        ctx,
      );

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
        const result = await triageTool.handler(
          {
            mode: 'triage-one',
            ideaId: `idea-${decision}`,
            decision,
            reason: `Test ${decision}`,
          },
          ctx,
        );

        const response = JSON.parse(result.content[0].text);
        expect(response.ok).toBe(true);
        expect(response.decision).toBe(decision);
      }
    });

    it('includes guidance for next steps in the response', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = await triageTool.handler(
        {
          mode: 'triage-one',
          ideaId: 'idea-1',
          decision: 'place',
          reason: 'Ready',
        },
        ctx,
      );

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
      const result = await triageTool.handler({ mode: 'unknown' as any }, ctx);

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('Unknown mode');
    });
  });
});
