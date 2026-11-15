import { describe, expect, it } from 'vitest';
import { selectSpecQualitySubjectRow } from './spec-quality';

// WI-6554700010049218: a harness move leaves the old plan row superseded, and the
// spec-quality subject must still resolve to the single live row.
describe('selectSpecQualitySubjectRow', () => {
  const live = { plan_slug: 'moved-plan', harness_slug: 'papercusp', status: 'draft' };
  const moved = { plan_slug: 'moved-plan', harness_slug: 'oddsmith-hive', status: 'superseded' };

  it('resolves the single live row when a superseded copy shares the slug', () => {
    expect(selectSpecQualitySubjectRow([moved, live])).toEqual({ planSlug: 'moved-plan', harnessSlug: 'papercusp' });
    expect(selectSpecQualitySubjectRow([live, moved])).toEqual({ planSlug: 'moved-plan', harnessSlug: 'papercusp' });
  });

  it('resolves a lone row whose status is unknown', () => {
    expect(selectSpecQualitySubjectRow([{ plan_slug: 'p', harness_slug: 'h', status: null }]))
      .toEqual({ planSlug: 'p', harnessSlug: 'h' });
  });

  it('stays ambiguous when two live rows collide', () => {
    expect(selectSpecQualitySubjectRow([live, { ...live, harness_slug: 'other', status: 'active' }])).toBeNull();
  });

  it('refuses when only superseded rows remain or nothing matched', () => {
    expect(selectSpecQualitySubjectRow([moved])).toBeNull();
    expect(selectSpecQualitySubjectRow([])).toBeNull();
  });
});
