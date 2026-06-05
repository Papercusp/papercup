import { describe, it, expect } from 'vitest';
import { rebuildCustomInstructions } from './learning-shared';

describe('rebuildCustomInstructions', () => {
  it('returns null when there is no signal', () => {
    expect(rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 0, forgetAllCount: 0,
      byKind: { edit: {}, delete: {} },
    })).toBeNull();
  });

  it('returns null when counts are below the noise floor', () => {
    expect(rebuildCustomInstructions({
      totalEdits: 1, totalDeletes: 2, forgetAllCount: 0,
      byKind: { edit: { preference: 2 }, delete: { project: 1 } },
    })).toBeNull();
  });

  it('emits a conservative-extraction hint when deletes dominate', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 1, totalDeletes: 5, forgetAllCount: 0,
      byKind: { edit: {}, delete: {} },
    });
    expect(out).toContain('over-extraction');
    expect(out).toContain('5 memories');
  });

  it('emits a literal-extraction hint when edits dominate', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 8, totalDeletes: 2, forgetAllCount: 0,
      byKind: { edit: {}, delete: {} },
    });
    expect(out).toContain('Extract more literally');
    expect(out).toContain('8 memories');
  });

  it('forget-all triggers a strong reset hint regardless of other counts', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 0, forgetAllCount: 1,
      byKind: { edit: {}, delete: {} },
    });
    expect(out).toContain('full memory reset');
    expect(out).toContain('high-confidence');
  });

  it('per-kind delete pattern triggers conservative hint for that kind', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 0, forgetAllCount: 0,
      byKind: { edit: {}, delete: { preference: 5 } },
    });
    expect(out).toContain('kind=preference');
    expect(out).toContain('conservative');
  });

  it('per-kind edit pattern triggers literal hint for that kind', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 0, forgetAllCount: 0,
      byKind: { edit: { project: 4 }, delete: {} },
    });
    expect(out).toContain('kind=project');
    expect(out).toContain('literally');
  });

  it('combines multiple hints into one markdown block', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 3, totalDeletes: 6, forgetAllCount: 1,
      byKind: { edit: { project: 3 }, delete: { preference: 4 } },
    });
    expect(out).toMatch(/^## Adaptive extraction notes/);
    expect(out).toContain('full memory reset');
    expect(out).toContain('over-extraction');
    expect(out).toContain('kind=preference');
    expect(out).toContain('kind=project');
  });

  it('respects a custom noise floor', () => {
    // With floor=10, 5 deletes is below threshold → no hint
    expect(rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 5, forgetAllCount: 0,
      byKind: { edit: {}, delete: {} },
      noiseFloor: 10,
    })).toBeNull();
    // With floor=2, 5 deletes is above threshold → hint
    expect(rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 5, forgetAllCount: 0,
      byKind: { edit: {}, delete: {} },
      noiseFloor: 2,
    })).toContain('over-extraction');
  });

  it('"5 deletes vs 0 edits" emits delete-dominance branch (covers tie-break)', () => {
    const out = rebuildCustomInstructions({
      totalEdits: 0, totalDeletes: 5, forgetAllCount: 0,
      byKind: { edit: {}, delete: {} },
    });
    expect(out).toContain('over-extraction');
    expect(out).not.toContain('Extract more literally');
  });
});
