/**
 * Unit coverage for the pure completion-time generator-expansion helpers (P-043).
 */
import { describe, it, expect } from 'vitest';
import { selectCompletionTimeWaves, planGeneratorChildren } from './expand-generators';
import { FanoutCapError } from '@papercusp/fanout-resolver';
import type { PromoteWave } from './promote-policy';

const genWave = (id: string, from_feature: string, titleTpl = 'Fix {item}'): PromoteWave => ({
  id,
  generate: { for_each: { from_feature }, feature_template: { title: titleTpl } },
});

describe('selectCompletionTimeWaves', () => {
  it('matches a from_feature wave by feature id', () => {
    const policy = { waves: [genWave('w2', 'F-SCAN')] };
    expect(selectCompletionTimeWaves(policy, 'F-SCAN').map((w) => w.id)).toEqual(['w2']);
  });

  it('matches by title when the id does not match', () => {
    const policy = { waves: [genWave('w2', 'Scan all routes')] };
    expect(selectCompletionTimeWaves(policy, 'F-XYZ', 'Scan all routes').map((w) => w.id)).toEqual(['w2']);
  });

  it('ignores promote-time resolvers (items/glob/sql) and static waves', () => {
    const policy = {
      waves: [
        { id: 'static', features: [{ title: 'X' }] } as PromoteWave,
        { id: 'glob', generate: { for_each: { glob: '**/*.ts' }, feature_template: { title: 'T {item}' } } } as PromoteWave,
        genWave('comp', 'F-SCAN'),
      ],
    };
    expect(selectCompletionTimeWaves(policy, 'F-SCAN').map((w) => w.id)).toEqual(['comp']);
  });

  it('returns nothing when no wave sources from this feature', () => {
    expect(selectCompletionTimeWaves({ waves: [genWave('w2', 'F-OTHER')] }, 'F-SCAN')).toEqual([]);
  });
});

describe('planGeneratorChildren', () => {
  const wave = genWave('w2', 'F-SCAN', 'Add test for {item}');

  it('mints one child per item, blocked_by the source, with generated_by provenance', () => {
    const children = planGeneratorChildren(wave, ['/a', '/b'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(children).toHaveLength(2);
    expect(children[0].title).toBe('Add test for /a');
    expect(children[0].blocked_by).toEqual(['F-SCAN']);
    expect(children[0].source_plan_slug).toBe('p');
    expect(children[0].metadata.generated_by).toEqual({ plan: 'p', wave: 'w2', source: 'F-SCAN' });
    expect(children[0].id).toMatch(/^F-GEN-[a-z0-9]{7}$/);
  });

  it('is idempotent: same (plan, wave, item) → same deterministic id', () => {
    const a = planGeneratorChildren(wave, ['/a'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    const b = planGeneratorChildren(wave, ['/a'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(a[0].id).toBe(b[0].id);
  });

  it('different items / waves / plans → different ids', () => {
    const id = (item: string, slug = 'p', w = wave) =>
      planGeneratorChildren(w, [item], { planSlug: slug, sourceFeatureId: 'F-SCAN' })[0].id;
    expect(id('/a')).not.toBe(id('/b'));
    expect(id('/a')).not.toBe(id('/a', 'other-plan'));
    expect(id('/a')).not.toBe(id('/a', 'p', genWave('w3', 'F-SCAN', 'Add test for {item}')));
  });

  it('dedupes + trims items', () => {
    const children = planGeneratorChildren(wave, [' /a ', '/a', '/b', ''], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(children.map((c) => c.title).sort()).toEqual(['Add test for /a', 'Add test for /b']);
  });

  it('throws FanoutCapError over the cap (never truncates)', () => {
    const many = Array.from({ length: 5 }, (_, i) => `i-${i}`);
    expect(() => planGeneratorChildren(wave, many, { planSlug: 'p', sourceFeatureId: 'F-SCAN', cap: 3 })).toThrow(
      FanoutCapError,
    );
  });

  it('folds the template acceptance bullets into the child summary', () => {
    const w: PromoteWave = {
      id: 'w2',
      generate: {
        for_each: { from_feature: 'F-SCAN' },
        feature_template: { title: 'Fix {item}', acceptance: ['{item} returns 200'] },
      },
    };
    const children = planGeneratorChildren(w, ['/a'], { planSlug: 'p', sourceFeatureId: 'F-SCAN' });
    expect(children[0].summary).toContain('/a returns 200');
  });
});
