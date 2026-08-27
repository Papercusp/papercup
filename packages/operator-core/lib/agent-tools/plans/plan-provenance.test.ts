import { describe, expect, it } from 'vitest';
import {
  BLENDER_PLAN_CONTENT_MARKER,
  BLENDER_PLAN_SQL_PATTERN,
  isBlenderPlanContent,
  planOriginFromBlenderFlag,
  planProvenanceFromBlenderFlag,
} from './plan-provenance';

describe('canonical plan provenance', () => {
  it('recognizes only the exact frontmatter line', () => {
    expect(isBlenderPlanContent(`---${BLENDER_PLAN_CONTENT_MARKER}status: draft\n---`)).toBe(true);
    expect(isBlenderPlanContent('\norigin: su-ideate\n')).toBe(false);
    expect(isBlenderPlanContent('\nnotes: origin: scout\n')).toBe(false);
    expect(isBlenderPlanContent('\norigin: scout-extra\n')).toBe(false);
    expect(isBlenderPlanContent(null)).toBe(false);
  });

  it('keeps the SQL and in-memory marker identical', () => {
    expect(BLENDER_PLAN_SQL_PATTERN).toBe(`%${BLENDER_PLAN_CONTENT_MARKER}%`);
  });

  it('maps the projected flag to both public representations', () => {
    expect(planProvenanceFromBlenderFlag(true)).toBe('blender');
    expect(planProvenanceFromBlenderFlag(false)).toBe('outside-blender');
    expect(planProvenanceFromBlenderFlag(undefined)).toBe('outside-blender');
    expect(planOriginFromBlenderFlag(true)).toBe('scout');
    expect(planOriginFromBlenderFlag(false)).toBeNull();
  });
});
