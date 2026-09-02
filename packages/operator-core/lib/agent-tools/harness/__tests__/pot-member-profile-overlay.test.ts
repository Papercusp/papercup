/**
 * hive-blueprint-generalization P-021 — the Hive→member domain-profile overlay. A
 * member harness born into a generic-hive inherits the Hive's judge-acceptance +
 * artifacts-output so the deliverable is actually gated; a coding hive overlays nothing
 * (its members stay byte-identical). The fix for the live-smoke finding that the
 * acceptance gate was declared on the Hive but deliverables finalize in the member.
 */
import { describe, it, expect } from 'vitest';
import { hiveMemberProfileOverlay } from '../create';

describe('hiveMemberProfileOverlay', () => {
  it('propagates a generic-hive deliverable profile (judge + artifacts)', () => {
    const overlay = hiveMemberProfileOverlay({
      acceptance: { kind: 'judge' },
      output: { kind: 'artifacts' },
    });
    expect(overlay.acceptance).toEqual({ kind: 'judge' });
    expect(overlay.output).toEqual({ kind: 'artifacts' });
  });

  it('propagates human-gate acceptance', () => {
    expect(hiveMemberProfileOverlay({ acceptance: { kind: 'human-gate' } }).acceptance).toEqual({
      kind: 'human-gate',
    });
  });

  it('overlays NOTHING for a coding hive (acceptance none/tests, output repo-commit)', () => {
    // The schema defaults a coding hive to acceptance:none + output:repo-commit.
    expect(hiveMemberProfileOverlay({ acceptance: { kind: 'none' }, output: { kind: 'repo-commit' } })).toEqual({});
    expect(hiveMemberProfileOverlay({ acceptance: { kind: 'tests' } })).toEqual({});
    expect(hiveMemberProfileOverlay({})).toEqual({});
  });

  it('propagates only the non-coding facet when mixed (judge acceptance, repo-commit output)', () => {
    const overlay = hiveMemberProfileOverlay({ acceptance: { kind: 'judge' }, output: { kind: 'repo-commit' } });
    expect(overlay.acceptance).toEqual({ kind: 'judge' });
    expect(overlay.output).toBeUndefined();
  });

  it('propagates a non-repo-commit output sink (external-action / work-item-payload)', () => {
    expect(hiveMemberProfileOverlay({ output: { kind: 'external-action' } }).output).toEqual({
      kind: 'external-action',
    });
  });
});
