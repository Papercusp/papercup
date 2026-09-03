import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import { projectBoundedPayload } from '@papercusp/tooldef';
import { analyzePlanDagParallelism, RELEASE_GATE_RE } from './plan-dag-parallelism';

const item = (args: {
  id: string;
  status?: PlanItem['storedStatus'];
  blockedBy?: string[];
  phase?: string | null;
  text?: string;
}): PlanItem => ({
  id: args.id,
  text: args.text ?? args.id,
  storedStatus: args.status ?? 'todo',
  importance: 'normal',
  blockedBy: args.blockedBy ?? [],
  decisionRefs: [],
  phase: args.phase ?? null,
  lineNumber: 1,
  rawLine: `- **${args.id}** \`${args.status ?? 'todo'}\` ${args.text ?? args.id}`,
});

describe('analyzePlanDagParallelism', () => {
  it('counts disjoint foundational leaves as executable width and ignores their completed root', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', status: 'done', phase: 'Phase 1' }),
      item({ id: 'P-002', blockedBy: ['P-001'], phase: 'Phase 2' }),
      item({ id: 'P-003', blockedBy: ['P-001'], phase: 'Phase 2' }),
      item({ id: 'P-004', blockedBy: ['P-001'], phase: 'Phase 2' }),
    ]);

    expect(result).toMatchObject({
      nonTerminal: 3,
      readyWidth: 3,
      readyItemIds: ['P-002', 'P-003', 'P-004'],
      criticalPathDepth: 1,
      blockingEdges: [],
    });
  });

  it('reports a serialized critical path and every currently blocking edge', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', phase: 'Phase 1' }),
      item({ id: 'P-002', blockedBy: ['P-001'], phase: 'Phase 2' }),
      item({ id: 'P-003', blockedBy: ['P-002'], phase: 'Phase 3' }),
    ]);

    expect(result.readyWidth).toBe(1);
    expect(result.criticalPathDepth).toBe(3);
    expect(result.criticalPathSummary).toBe('depth=3: P-001 -> P-002 -> P-003');
    expect(result.criticalPathItemIds).toEqual(['P-001', 'P-002', 'P-003']);
    expect(result.blockingEdges.map(({ itemId, blockerId }) => `${itemId}<-${blockerId}`)).toEqual([
      'P-002<-P-001',
      'P-003<-P-002',
    ]);
  });

  it('identifies fan-in, later-phase inversions, and release gates blocking foundational work', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', phase: 'Phase 1', text: 'Implement provider foundation', blockedBy: ['P-003'] }),
      item({ id: 'P-002', phase: 'Phase 1', text: 'Build storage adapter' }),
      item({ id: 'P-003', phase: 'Phase 4', text: 'Beta distribution release gate' }),
      item({ id: 'P-004', phase: 'Phase 5', text: 'Integrate providers', blockedBy: ['P-001', 'P-002'] }),
    ]);

    expect(result.fanInChokepoints).toEqual([{ itemId: 'P-004', blockerIds: ['P-001', 'P-002'] }]);
    expect(result.topFanInChokepointsSummary).toBe('top=1/1: P-004(2)<-[P-001,P-002]');
    expect(result.phaseInversions).toEqual([{
      itemId: 'P-001',
      itemPhase: 'Phase 1',
      blockerId: 'P-003',
      blockerPhase: 'Phase 4',
    }]);
    expect(result.releaseGateBlocksBuild).toEqual([{
      itemId: 'P-001',
      itemPhase: 'Phase 1',
      blockerId: 'P-003',
      blockerPhase: 'Phase 4',
    }]);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      'phase-inversion',
      'gate-foundation-inversion',
      // P-003 is a release gate carrying no prerequisites of its own while P-001/P-002 build work
      // is still open — a true positive of gate-without-dependency, and a different defect from the
      // inversion above: that one says the edge points the wrong way, this one says the gate is
      // claimable right now.
      'gate-without-dependency',
    ]);
    expect(result.findings[0]).toMatchObject({
      classification: 'advisory',
      confidence: 'medium',
      nodes: ['P-001', 'P-003'],
      edges: [{ subject: 'P-001', dependency: 'P-003' }],
      provenance: expect.arrayContaining(['dependency-graph-admission-and-health-2026-08-26#D-005']),
      suggestedAction: expect.any(String),
    });
  });

  it('keeps ordinary diamonds healthy and suppresses an explicitly-rationalized serial chain', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', phase: 'Phase 1' }),
      item({ id: 'P-002', phase: 'Phase 2', blockedBy: ['P-001'] }),
      item({ id: 'P-003', phase: 'Phase 2', blockedBy: ['P-001'] }),
      { ...item({ id: 'P-004', phase: 'Phase 3', blockedBy: ['P-002', 'P-003'] }), decisionRefs: ['D-001'] },
    ]);

    expect(result.findings).toEqual([
      expect.objectContaining({
        code: 'narrow-or-deep-topology',
        suppressedBy: { kind: 'structured-rationale', refs: ['D-001'] },
      }),
    ]);
  });

  it('emits a high-degree finding only beyond the healthy multiple-blocker shape', () => {
    const blockers = ['P-001', 'P-002', 'P-003', 'P-004'].map((id) => item({ id, phase: 'Phase 1' }));
    const result = analyzePlanDagParallelism([
      ...blockers,
      item({ id: 'P-005', phase: 'Phase 2', blockedBy: blockers.map(({ id }) => id) }),
    ]);

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'high-degree-node',
      nodes: ['P-005', 'P-001', 'P-002', 'P-003', 'P-004'],
      evidence: { topologyMetrics: { fanIn: 4 } },
    }));
  });

  it('terminates on cycles and reports their members as non-ready', () => {
    const result = analyzePlanDagParallelism([
      item({ id: 'P-001', blockedBy: ['P-002'] }),
      item({ id: 'P-002', blockedBy: ['P-001'] }),
    ]);

    expect(result.readyWidth).toBe(0);
    expect(result.criticalPathDepth).toBeGreaterThan(0);
    expect(result.criticalPathDepth).toBeLessThanOrEqual(2);
    expect(result.nonReadyItems).toEqual([
      expect.objectContaining({ itemId: 'P-001', reason: 'cycle' }),
      expect.objectContaining({ itemId: 'P-002', reason: 'cycle' }),
    ]);
  });

  it('keeps semantic DAG summaries legible when the generic result cap truncates the raw arrays', () => {
    const chain = Array.from({ length: 30 }, (_, index) => {
      const id = `P-${String(index + 1).padStart(3, '0')}`;
      const blockerId = index === 0 ? undefined : `P-${String(index).padStart(3, '0')}`;
      return item({ id, blockedBy: blockerId ? [blockerId] : [] });
    });
    const fanIn = Array.from({ length: 7 }, (_, index) => item({
      id: `P-${String(index + 31).padStart(3, '0')}`,
      blockedBy: chain.slice(0, index + 2).map(({ id }) => id),
    }));
    const result = analyzePlanDagParallelism([...chain, ...fanIn]);

    expect(result.criticalPathSummary).toContain('depth=30: P-001 -> P-002');
    expect(result.criticalPathSummary).toContain('… +6 item(s) …');
    expect(result.criticalPathSummary).toContain('P-029 -> P-030');
    expect(result.topFanInChokepointsSummary).toContain(
      'top=5/7: P-037(8)<-[P-001,P-002,P-003,P-004,…+4]',
    );

    const projected = projectBoundedPayload(
      { parallelism: result },
      { toolName: 'plans:start', tier: 'trimmed', targetChars: 7_000 },
    );
    const bounded = projected.parallelism as Record<string, unknown>;

    expect(bounded.criticalPathSummary).toBe(result.criticalPathSummary);
    expect(bounded.topFanInChokepointsSummary).toBe(result.topFanInChokepointsSummary);
    expect(Array.isArray(bounded.criticalPathItemIds)).toBe(true);
    expect((bounded.criticalPathItemIds as unknown[]).length).toBeLessThan(result.criticalPathItemIds.length);
    expect(projected._projection.omittedCount).toBeGreaterThan(0);
  });
});

// EI-22089706217678704. Reconstructed from the reporting incident: plan
// silent-intake-central-resolution-2026-09-01 carried a ship gate (P-011) and a test gate (P-010)
// with `blockedBy: []` while build items were unfinished, so promotion minted both unblocked and a
// drain member claimed-then-parked them back-to-back. The negative controls matter as much as the
// positives here: the edgeless-item population is large (measured 340 across the active plans) and
// only 83 of those are this shape, so a rule that fires on "no edges" alone would be noise.
describe('analyzePlanDagParallelism — gate-without-dependency', () => {
  const codes = (items: PlanItem[]): string[] =>
    analyzePlanDagParallelism(items)
      .findings.filter((f) => f.code === 'gate-without-dependency')
      .map((f) => f.nodes[0]);

  it('flags an edgeless SHIP gate while foundational build work is open', () => {
    expect(
      codes([
        item({ id: 'P-001', text: 'Implement the resolver backend' }),
        item({ id: 'P-011', text: 'Post-implementation acceptance: audit, rubric, grading, then ship' }),
      ]),
    ).toEqual(['P-011']);
  });

  it('flags the TEST gate that RELEASE_GATE_RE alone misses (the half the incident lost)', () => {
    // "Tests across every changed seam … as the final act" contains no release vocabulary at all.
    const text = 'Tests across every changed seam as the final act';
    expect(RELEASE_GATE_RE.test(text)).toBe(false); // control: why the release regex is not enough
    expect(
      codes([
        item({ id: 'P-001', text: 'Implement the admission routing core' }),
        item({ id: 'P-010', text }),
      ]),
    ).toEqual(['P-010']);
  });

  it('does NOT flag once the prerequisites are encoded (the repaired state)', () => {
    expect(
      codes([
        item({ id: 'P-001', text: 'Implement the resolver backend' }),
        item({ id: 'P-011', blockedBy: ['P-001'], text: 'Post-implementation acceptance, then ship' }),
      ]),
    ).toEqual([]);
  });

  it('does NOT flag a gate whose foundational work is already terminal', () => {
    expect(
      codes([
        item({ id: 'P-001', status: 'done', text: 'Implement the resolver backend' }),
        item({ id: 'P-011', text: 'Post-implementation acceptance, then ship' }),
      ]),
    ).toEqual([]);
  });

  it('does NOT flag ordinary edgeless build items — the large parallel population', () => {
    expect(
      codes([
        item({ id: 'P-001', text: 'Implement the resolver backend' }),
        item({ id: 'P-002', text: 'Add the storage adapter' }),
        item({ id: 'P-003', text: 'Wire the frontend provider' }),
      ]),
    ).toEqual([]);
  });

  it('is suppressed by a structured rationale on the gate item', () => {
    const gate: PlanItem = {
      ...item({ id: 'P-011', text: 'Post-implementation acceptance, then ship' }),
      decisionRefs: ['D-007'],
    };
    const found = analyzePlanDagParallelism([
      item({ id: 'P-001', text: 'Implement the resolver backend' }),
      gate,
    ]).findings.find((f) => f.code === 'gate-without-dependency');
    expect(found?.suppressedBy).toEqual({ kind: 'structured-rationale', refs: ['D-007'] });
  });
});
