import { describe, it, expect } from 'vitest';
import { classifyIdeaType, triageIdea, summarizeTriages } from './triage';
import type { ScoredItem } from './digest';

function idea(p: Partial<ScoredItem> & { id: string }): ScoredItem {
  return {
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
  };
}

describe('classifyIdeaType', () => {
  it('classifies operator-scope ideas as process', () => {
    const result = classifyIdeaType(
      idea({ id: 'i1', scope: 'operator', title: 'fix harness scheduler' }),
    );
    expect(result.type).toBe('process');
    expect(result.reason).toContain('operator');
  });

  it('classifies harness:papercup as process', () => {
    const result = classifyIdeaType(
      idea({ id: 'i2', scope: 'harness:papercup', title: 'improve orchestrator' }),
    );
    expect(result.type).toBe('process');
    expect(result.reason).toContain('papercup');
  });

  it('classifies other harness scopes as product', () => {
    const result = classifyIdeaType(
      idea({ id: 'i3', scope: 'harness:sheets', title: 'add pivot tables' }),
    );
    expect(result.type).toBe('product');
    expect(result.reason).toContain('sheets');
  });

  it('defaults to process when scope is missing', () => {
    const result = classifyIdeaType(
      idea({ id: 'i4', scope: undefined, title: 'something vague' }),
    );
    expect(result.type).toBe('process');
  });
});

describe('triageIdea', () => {
  it('routes product-type ideas to place', () => {
    const result = triageIdea(
      idea({ id: 'p1', scope: 'harness:sheets', kind: 'bug', title: 'formula broken' }),
    );
    expect(result.decision).toBe('place');
    expect(result.target).toBe('harness:sheets');
  });

  it('routes process-type ideas to gate', () => {
    const result = triageIdea(
      idea({ id: 'proc1', scope: 'operator', kind: 'change', title: 'redesign QA' }),
    );
    expect(result.decision).toBe('gate');
    expect(result.target).toBe('human-review');
    expect(result.reason).toContain('process');
  });

  it('gates harness:papercup ideas (even product-classified) with caution', () => {
    const result = triageIdea(
      idea({ id: 'pp1', scope: 'harness:papercup', kind: 'feature', title: 'new orchestrator branch' }),
    );
    expect(result.decision).toBe('gate');
  });

  it('distinguishes decision rationale by classification', () => {
    const product = triageIdea(idea({ id: 'p', scope: 'harness:other' }));
    const process = triageIdea(idea({ id: 'proc', scope: 'operator' }));
    expect(product.reason).toContain('project code');
    expect(process.reason).toContain('process');
  });
});

describe('summarizeTriages', () => {
  it('counts triage decisions across a batch', () => {
    const items = [
      idea({ id: '1', scope: 'harness:sheets' }),      // place
      idea({ id: '2', scope: 'harness:sheets' }),      // place
      idea({ id: '3', scope: 'operator' }),             // gate
      idea({ id: '4', scope: 'harness:papercup' }),    // gate
    ];
    const summary = summarizeTriages(items);
    expect(summary.total).toBe(4);
    expect(summary.byDecision.place).toBe(2);
    expect(summary.byDecision.gate).toBe(2);
    expect(summary.byDecision.gym).toBe(0);
    expect(summary.byDecision.reject).toBe(0);
  });

  it('counts idea types correctly', () => {
    const items = [
      idea({ id: '1', scope: 'harness:sheets' }),  // product
      idea({ id: '2', scope: 'operator' }),         // process
      idea({ id: '3', scope: 'harness:other' }),   // product
    ];
    const summary = summarizeTriages(items);
    expect(summary.byType.product).toBe(2);
    expect(summary.byType.process).toBe(1);
  });

  it('handles empty batch gracefully', () => {
    const summary = summarizeTriages([]);
    expect(summary.total).toBe(0);
    expect(summary.byDecision.place).toBe(0);
    expect(summary.byDecision.gate).toBe(0);
  });

  it('includes highlights for the Queen to review', () => {
    const items = [
      idea({ id: 'maj', severity: 'critical', scope: 'operator', title: 'critical security issue' }),
      idea({ id: 'min', severity: 'minor', scope: 'harness:sheets' }),
    ];
    const summary = summarizeTriages(items);
    expect(summary.highlights).toBeDefined();
    expect(Array.isArray(summary.highlights)).toBe(true);
  });
});
