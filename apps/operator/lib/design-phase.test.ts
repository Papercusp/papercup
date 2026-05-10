import { describe, it, expect } from 'vitest';
import {
  computeNeedsDesign,
  assertDesignGate,
  DesignGateError,
  initialDesignPhaseFields,
} from './design-phase';

describe('computeNeedsDesign', () => {
  it('flags UI keywords', () => {
    expect(computeNeedsDesign({ title: 'add settings page' })).toBe(true);
    expect(computeNeedsDesign({ title: 'redesign the operator panel' })).toBe(true);
    expect(computeNeedsDesign({ title: 'new modal for token approval' })).toBe(true);
  });

  it('flags copy / i18n changes', () => {
    expect(computeNeedsDesign({ title: 'fix typo in error message' })).toBe(true);
    expect(computeNeedsDesign({ title: 'add empty-state copy for inbox' })).toBe(true);
  });

  it('flags route changes', () => {
    expect(computeNeedsDesign({ title: 'add /reports route' })).toBe(true);
  });

  it('flags iconography', () => {
    expect(computeNeedsDesign({ title: 'swap icon set to lucide' })).toBe(true);
  });

  it('flags by declared globs intersecting UI globs', () => {
    expect(
      computeNeedsDesign({
        title: 'persistence layer',
        declaredGlobs: ['app/**/page.tsx'],
      }),
    ).toBe(true);
    expect(
      computeNeedsDesign({
        title: 'persistence layer',
        declaredGlobs: ['lib/db/queries.ts'],
      }),
    ).toBe(false);
  });

  it('skips backend / infra / refactor / bugfix work', () => {
    expect(computeNeedsDesign({ title: 'add postgres index' })).toBe(false);
    expect(computeNeedsDesign({ title: 'refactor token bucket' })).toBe(false);
    expect(computeNeedsDesign({ title: 'fix race in worker pool' })).toBe(false);
    expect(computeNeedsDesign({ title: 'upgrade prisma to 5.x' })).toBe(false);
    expect(computeNeedsDesign({ title: 'add CI step for migrations' })).toBe(false);
  });

  it('honors force-on / force-off', () => {
    expect(computeNeedsDesign({ title: 'add postgres index', flagged: 'force-on' })).toBe(true);
    expect(computeNeedsDesign({ title: 'redesign operator panel', flagged: 'force-off' })).toBe(
      false,
    );
  });

  it('reads from summary and scopeText, not just title', () => {
    expect(
      computeNeedsDesign({
        title: 'feature X',
        summary: 'adds a new dashboard panel for viewing things',
      }),
    ).toBe(true);
    expect(
      computeNeedsDesign({
        title: 'feature X',
        scopeText: 'requires a new modal and an updated empty-state copy',
      }),
    ).toBe(true);
  });
});

describe('assertDesignGate', () => {
  it('passes when design is not needed', () => {
    expect(() =>
      assertDesignGate('f1', { needsDesign: false, designStatus: null }),
    ).not.toThrow();
  });

  it('passes when design is accepted', () => {
    expect(() =>
      assertDesignGate('f1', { needsDesign: true, designStatus: 'accepted' }),
    ).not.toThrow();
  });

  it('passes when design is ignored', () => {
    expect(() =>
      assertDesignGate('f1', { needsDesign: true, designStatus: 'ignored' }),
    ).not.toThrow();
  });

  it('throws when design is needed but pending', () => {
    expect(() =>
      assertDesignGate('f1', { needsDesign: true, designStatus: 'pending' }),
    ).toThrow(DesignGateError);
  });

  it('throws when design is needed but null', () => {
    expect(() =>
      assertDesignGate('f1', { needsDesign: true, designStatus: null }),
    ).toThrow(DesignGateError);
  });

  it('error carries featureId and designStatus', () => {
    try {
      assertDesignGate('feat-42', { needsDesign: true, designStatus: 'pending' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DesignGateError);
      expect((e as DesignGateError).featureId).toBe('feat-42');
      expect((e as DesignGateError).designStatus).toBe('pending');
    }
  });
});

describe('initialDesignPhaseFields', () => {
  it('returns null status + false flags by default', () => {
    const f = initialDesignPhaseFields({ title: 'add settings page' });
    expect(f.needsDesign).toBe(true);
    expect(f.designStatus).toBeNull();
    expect(f.designSpecId).toBeNull();
    expect(f.discardedDesignWork).toBe(false);
  });

  it('respects heuristic = false', () => {
    const f = initialDesignPhaseFields({ title: 'add postgres index' });
    expect(f.needsDesign).toBe(false);
  });
});
