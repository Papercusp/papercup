import { describe, expect, it } from 'vitest';
import { buildGdpvalPrediction } from './run';
import type { BenchTask } from '../types';

const task = (gm: Record<string, unknown>): BenchTask => ({ benchmark: 'gdpval', instanceId: 't1', problemStatement: 'do the thing', graderMeta: gm });

describe('gdpval run — buildGdpvalPrediction', () => {
  it('maps a normal task + deliverable (no excludeReason)', () => {
    const p = buildGdpvalPrediction(
      task({ occupation: 'Lawyers', sector: 'Legal', rubric: 'clarity', referenceDeliverableText: 'the expert memo' }),
      { deliverableText: 'my memo' },
    );
    expect(p).toMatchObject({ taskId: 't1', occupation: 'Lawyers', sector: 'Legal', modelDeliverable: 'my memo', referenceDeliverable: 'the expert memo' });
    expect(p.excludeReason).toBeUndefined();
  });

  it('excludes when the expert reference is unreadable (cannot grade fairly)', () => {
    const p = buildGdpvalPrediction(task({ referenceExcludeReason: 'binary video' }), { deliverableText: 'my deliverable' });
    expect(p.excludeReason).toMatch(/reference unreadable.*binary video/);
  });

  it('excludes when the arm produced no readable deliverable', () => {
    const p = buildGdpvalPrediction(task({ referenceDeliverableText: 'ref' }), { deliverableText: '   ' });
    expect(p.excludeReason).toMatch(/no readable deliverable/);
  });

  it('reference-unreadable takes precedence over empty-deliverable', () => {
    const p = buildGdpvalPrediction(task({ referenceExcludeReason: 'cad file' }), { deliverableText: '' });
    expect(p.excludeReason).toMatch(/reference unreadable/);
  });
});
