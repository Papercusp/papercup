import { describe, expect, it } from 'vitest';
import { decoratePlanItemStalePathRefs } from './get';

describe('plans:get stalePathRefs decoration (EI-20049758099997696)', () => {
  it('decorates only the plan item whose cited path is unresolvable', () => {
    const refs = { 'P-002': ['apps/operator/app/_components/LeftSidebar.tsx'] };
    expect(decoratePlanItemStalePathRefs({ id: 'P-001', text: 'still current' }, refs)).toEqual({
      id: 'P-001',
      text: 'still current',
    });

    const stale = decoratePlanItemStalePathRefs({ id: 'P-002', text: 'remove the old sidebar' }, refs);
    expect(stale.stalePathRefs).toEqual(['apps/operator/app/_components/LeftSidebar.tsx']);
    expect(stale.stalePathRefsNote).toContain('Advisory only');
    expect(stale.stalePathRefsNote).toContain('not semantic staleness');
    expect(stale.stalePathRefsNote).toContain('absence of this field does not verify the item');
  });
});
