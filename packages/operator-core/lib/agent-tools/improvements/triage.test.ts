import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readImprovementItems, countImprovementItems } from '../../harness/improvements/read-items';
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
const mockCountImprovementItems = vi.mocked(countImprovementItems);
const mockBuildDigest = vi.mocked(buildDigest);
const mockApplyTriageDecision = vi.mocked(applyTriageDecision);

describe('improvements:triage tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The corpus COUNT(*) is read alongside the windowed item read. Without an explicit
    // resolved value the automock returns `undefined` (not a promise), so the handler's
    // `.catch(...)` throws — give it a default every test inherits.
    mockCountImprovementItems.mockResolvedValue(0);
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

  it('opts out of the ambient workspace transaction while doing its own issue reads/writes', () => {
    expect((triageTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('allows queue-wide triage reads to outlive the generic 60s dispatcher budget', () => {
    expect((triageTool as unknown as { timeoutSec?: number }).timeoutSec).toBe(300);
  });

  const mockItem = (p: Partial<ScoredItem> & { id: string }): ScoredItem => ({
    kind: 'change',
    severity: 'minor',
    title: 'test idea',
    scope: 'harness:papercup',
    tier: 'human',
    score: 0.5,
    ageDays: 0,
    tierReason: 'test reason',
    ...p,
  });

  // buildDigest's return type (ImprovementDigest) has grown beyond the handful of
  // fields these tests assert on; a complete-shape helper keeps the mocks valid
  // without restating every field at each call site.
  const mockDigest = (p: Partial<ImprovementDigest>): ImprovementDigest => ({
    generatedAt: new Date(0).toISOString(),
    total: 0,
    returned: 0,
    windowed: false,
    open: 0,
    byKind: { bug: 0, change: 0, feature: 0 },
    bySeverity: {},
    byState: {},
    autoEligible: [],
    humanQueue: [],
    likelyDuplicates: [],
    likelyDuplicatesScope: null,
    recurringSignatures: [],
    diagnosisClusters: { clusters: [], considered: 0, unshaped: 0, ritualExcluded: 0 },
    headline: 'test digest',
    ...p,
  });

  // WI-1206660 — the window must never be reported as the corpus.
  //
  // This tool reads a fixed 100-row window. Before this guard it called buildDigest with
  // NO corpusTotal, so `total` fell back to candidates.length and `windowed` came back
  // FALSE — an affirmative "nothing was truncated" on a backlog orders of magnitude
  // larger. `improvements:digest` had already fixed exactly this (EI-18790490225750395
  // D2) and the sibling never adopted it.
  describe('corpus total vs window (WI-1206660)', () => {
    it('reads the TRUE corpus COUNT with the SAME filter as the windowed read and threads it into buildDigest', async () => {
      const items = [mockItem({ id: '1' })];
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockCountImprovementItems.mockResolvedValue(4321);
      mockBuildDigest.mockReturnValue(mockDigest({ total: 4321, returned: 1, windowed: true, open: 1 }));

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'summary' }, ctx)) as any;
      const response = JSON.parse(result.content[0].text);

      // Same filter on both legs — a count over a DIFFERENT filter is not this tool's total.
      expect(mockCountImprovementItems.mock.calls[0]?.[0]).toEqual(mockReadImprovementItems.mock.calls[0]?.[0]);
      expect(mockBuildDigest.mock.calls[0]?.[1]).toMatchObject({ corpusTotal: 4321 });
      // The bound travels with the result, so a floor cannot be quoted as a total.
      expect(response.coverage).toMatchObject({ window: 100, examined: 1, corpusTotal: 4321, windowed: true });
    });

    it('degrades to the prior behaviour when the corpus COUNT fails, rather than sinking the triage', async () => {
      mockReadImprovementItems.mockResolvedValue([mockItem({ id: '1' })] as unknown as ImprovementCandidate[]);
      mockCountImprovementItems.mockRejectedValue(new Error('count blew up'));
      mockBuildDigest.mockReturnValue(mockDigest({ total: 1, returned: 1, open: 1 }));

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'summary' }, ctx)) as any;
      const response = JSON.parse(result.content[0].text);

      expect(response.ok).toBe(true);
      expect(mockBuildDigest.mock.calls[0]?.[1]).toMatchObject({ corpusTotal: undefined });
      expect(response.coverage.corpusTotal).toBeNull();
    });

    it('retriage-all reports complete:false when it only re-routed the window', async () => {
      const items = [mockItem({ id: '1' }), mockItem({ id: '2' })];
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockCountImprovementItems.mockResolvedValue(900);
      mockBuildDigest.mockReturnValue(
        mockDigest({ total: 900, returned: 2, windowed: true, open: 2, autoEligible: items }),
      );

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'retriage-all' }, ctx)) as any;
      const response = JSON.parse(result.content[0].text);

      // `scanned` counts the window; `complete` is the field that answers whether the
      // standing backlog was actually re-routed.
      expect(response.scanned).toBe(2);
      expect(response.complete).toBe(false);
      expect(response.remaining).toBe(898);
      // Default scope is still the corpus — the id-scoped fields below stay null so a
      // reader can never mistake an unscoped run for a cohort sweep.
      expect(response.coverage).toMatchObject({ scope: 'corpus', requested: null, missing: null });
    });
  });

  // EI-19374906980984233 — a backlog COHORT (390 rows mis-routed by the 2026-07-19→08-02
  // triage collapse) is unreachable through the ranked first-window read, and widening the
  // WRITE to the whole corpus was declined on purpose in this file. `ids` is the scoped
  // third option: mutate exactly the rows the caller named.
  describe('cohort scope via ids (EI-19374906980984233)', () => {
    it('pushes ids into the READ as a SQL predicate on both legs, not a post-filter', async () => {
      const items = [mockItem({ id: 'a' }), mockItem({ id: 'b' })];
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockCountImprovementItems.mockResolvedValue(2);
      mockBuildDigest.mockReturnValue(mockDigest({ total: 2, returned: 2, open: 2, autoEligible: items }));

      const ctx = { principalIdentity: 'test-agent' } as any;
      await triageTool.handler({ mode: 'retriage-all', ids: ['a', 'b'] }, ctx);

      // A post-filter would read the first N of the corpus and then shrink it, which looks
      // identical to success. The predicate has to reach SQL.
      expect(mockReadImprovementItems.mock.calls[0]?.[0]).toMatchObject({ issueIds: ['a', 'b'] });
      // WI-1206660's invariant survives the new scope: one filter, both legs.
      expect(mockCountImprovementItems.mock.calls[0]?.[0]).toEqual(mockReadImprovementItems.mock.calls[0]?.[0]);
    });

    it('re-routes exactly the named cohort and reports complete over the REQUESTED ids', async () => {
      const items = [mockItem({ id: 'a' }), mockItem({ id: 'b' })];
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockCountImprovementItems.mockResolvedValue(2);
      mockBuildDigest.mockReturnValue(mockDigest({ total: 2, returned: 2, open: 2, autoEligible: items }));

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'retriage-all', ids: ['a', 'b'] }, ctx)) as any;
      const response = JSON.parse(result.content[0].text);

      expect(mockApplyTriageDecision).toHaveBeenCalledTimes(2);
      expect(mockApplyTriageDecision.mock.calls.map((c) => c[0].id).sort()).toEqual(['a', 'b']);
      expect(response.complete).toBe(true);
      expect(response.completeOver).toBe('requested-ids');
      expect(response.coverage).toMatchObject({ scope: 'requested-ids', requested: 2, missing: 0, missingIds: [] });
      // `remaining` counts corpus rows left untouched; under an id scope the read never
      // tried to cover the corpus, so it must read NOT-MEASURED rather than 0.
      expect(response.remaining).toBeNull();
    });

    it('reports complete:false when a requested id never came back (already terminal, wrong topic, other harness)', async () => {
      const items = [mockItem({ id: 'a' })];
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockCountImprovementItems.mockResolvedValue(1);
      mockBuildDigest.mockReturnValue(mockDigest({ total: 1, returned: 1, open: 1, autoEligible: items }));

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'retriage-all', ids: ['a', 'gone'] }, ctx)) as any;
      const response = JSON.parse(result.content[0].text);

      // The whole point: a sweep that silently skipped half its cohort must not report
      // success just because everything it DID read succeeded.
      expect(response.applied).toBe(1);
      expect(response.complete).toBe(false);
      expect(response.coverage).toMatchObject({ requested: 2, missing: 1, missingIds: ['gone'] });
    });

    it('refuses ids on triage-one instead of silently dropping them', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler(
        { mode: 'triage-one', ideaId: 'a', decision: 'place', reason: 'r', ids: ['b'] },
        ctx,
      )) as any;
      const response = JSON.parse(result.content[0].text);

      expect(response.ok).toBe(false);
      expect(response.error).toContain('triage-one does not accept `ids`');
      expect(mockApplyTriageDecision).not.toHaveBeenCalled();
    });

    it('caps a single cohort pass at the window size so one call can never become an unbounded bulk mutation', () => {
      const schema = triageTool.args as any;
      expect(schema.shape.ids.isOptional()).toBe(true);
      expect(() => schema.parse({ mode: 'retriage-all', ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) })).toThrow();
      expect(() => schema.parse({ mode: 'retriage-all', ids: [] })).toThrow();
      expect(schema.parse({ mode: 'retriage-all', ids: ['a'] }).ids).toEqual(['a']);
    });
  });

  it('has correct tool metadata', () => {
    expect(triageTool).toBeDefined();
    expect(triageTool.name).toBe('improvements:triage');
    expect(triageTool.description).toContain('D-005 taxonomy');
    expect(triageTool.guidance).toBeDefined();
    expect(triageTool.guidance?.when).toBeDefined();
  });

  describe('handler - summary mode', () => {
    it('returns digest summary without applying decisions', async () => {
      const items = [
        mockItem({ id: '1', scope: 'harness:sheets' }),
        mockItem({ id: '2', scope: 'operator' }),
      ];
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockBuildDigest.mockReturnValue(
        mockDigest({ total: 2, open: 2, byKind: { bug: 0, change: 2, feature: 0 }, humanQueue: items }),
      );

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
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockBuildDigest.mockReturnValue(
        mockDigest({ total: 1, open: 1, byKind: { bug: 0, change: 1, feature: 0 }, humanQueue: items }),
      );

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
      mockReadImprovementItems.mockResolvedValue(items as unknown as ImprovementCandidate[]);
      mockBuildDigest.mockReturnValue(
        mockDigest({ total: 2, open: 2, byKind: { bug: 0, change: 2, feature: 0 }, humanQueue: items }),
      );

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'triage-all' }, ctx)) as any;

      expect(result.content).toBeDefined();
      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(true);
      expect(response.mode).toBe('triage-all');
      expect(response.previewOnly).toBe(true);
      expect(response.persisted).toBe(false);
      expect(response.appliedCount).toBe(0);
      expect(response.decisions).toBeDefined();
      expect(Array.isArray(response.decisions)).toBe(true);
      expect(response.decisions.length).toBe(2);
      expect(mockApplyTriageDecision).not.toHaveBeenCalled();

      // Check that decisions are populated
      const productDecision = response.decisions.find((d: any) => d.id === '1');
      const processDecision = response.decisions.find((d: any) => d.id === '2');
      expect(productDecision.decision).toBe('place');
      expect(processDecision.decision).toBe('gate');

      // Human-queue items carry the P-040 rank breakdown for the Queen's walk.
      expect(productDecision.rankScore).toBe(1);
      expect(productDecision.rankFeatures).toEqual(['blocking-impact: 1.00']);
    });

    // This assertion used to require the note to name the "Mug". That tier is RETIRED
    // (permanently — its gate flag was deleted), and the note was rewritten accordingly,
    // so the test had been red in CI ever since while asserting a vocabulary the product
    // no longer has. Pin what the note must actually carry instead: triage-all is a
    // PREVIEW, and triage-one is the verb that records a decision. Naming the caller was
    // never the invariant — an agent acting on this note needs to know it persisted
    // nothing, which is the half a stale actor-name check silently stopped guarding.
    it('tells the caller triage-all persisted nothing and names the verb that does', async () => {
      mockReadImprovementItems.mockResolvedValue([]);
      mockBuildDigest.mockReturnValue(mockDigest({}));

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'triage-all' }, ctx)) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.note).toContain('PREVIEW ONLY');
      expect(response.note).toContain('persists nothing');
      expect(response.note).toContain('triage-one');
      // The retired tier must not creep back into agent-facing copy.
      expect(response.note).not.toContain('Mug');
    });
  });

  describe('handler - triage-one mode', () => {
    it('skips the queue-wide digest and ranking prelude for a targeted decision', async () => {
      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler(
        {
          mode: 'triage-one',
          ideaId: 'idea-target',
          decision: 'place',
          reason: 'Targeted triage should not scan the full queue',
        },
        ctx,
      )) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(true);
      expect(response.mode).toBe('triage-one');
      expect(mockReadImprovementItems).not.toHaveBeenCalled();
      expect(mockBuildDigest).not.toHaveBeenCalled();
    });

    it('requires ideaId and rejects without it', async () => {
      mockReadImprovementItems.mockResolvedValue([]);
      mockBuildDigest.mockReturnValue(mockDigest({}));

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
      mockBuildDigest.mockReturnValue(mockDigest({}));

      const ctx = { principalIdentity: 'test-agent' } as any;
      const result = (await triageTool.handler({ mode: 'unknown' as any }, ctx)) as any;

      const response = JSON.parse(result.content[0].text);
      expect(response.ok).toBe(false);
      expect(response.error).toContain('Unknown mode');
    });
  });
});
