/**
 * Tests for the per-bee claim SPEC schema + validator
 * (`hybrid-bee-scheduler-work-stealing-2026-06-22`, Phases 1–2).
 *
 * Covers: a fully-featured valid spec, the default spec, and each invalid case
 * the validator must reject with a clear, field-named error — unknown filter
 * field, unknown filter op, unknown rank term, bad version, op/value mismatch,
 * weighted-mode without weights, floor fields in the filter, and unknown keys.
 */
import { describe, it, expect } from 'vitest';
import {
  validateClaimSpec,
  claimSpecSchema,
  DEFAULT_CLAIM_SPEC,
  CURRENT_SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  ITEM_FIELDS,
  FILTERABLE_ITEM_FIELDS,
  FILTER_OPS,
  RANK_FUNCTIONS,
  type ClaimSpec,
} from './claim-spec';

/** A maximal, valid spec exercising the full vocabulary (mirrors the plan's worked example). */
const fullSpec: ClaimSpec = {
  specVersion: '1.0',
  specId: 'sched-7f3a',
  revision: 4,
  basedOn: 'catalog:throughput-router@2',
  boundModel: 'claude-opus-4.8',
  view: {
    filter: {
      all: [
        { field: 'kind', op: 'in', value: ['feature', 'bug'] },
        { field: 'risk_tier', op: '<=', value: 2 },
        {
          any: [
            { field: 'tags', op: 'contains', value: 'sync' },
            { field: 'paths', op: 'glob', value: 'libs/sync/**' },
          ],
        },
        { not: { field: 'tags', op: 'contains', value: 'owner-gated' } },
      ],
    },
  },
  rank: {
    mode: 'lexicographic',
    terms: [
      { expr: 'priority', dir: 'desc' },
      { expr: 'affinity(bee.held_paths,item.paths)', dir: 'desc' },
      { expr: 'model_fit(bee.model,item)', dir: 'desc' },
      { expr: 'age', dir: 'asc' },
    ],
  },
  limits: { maxConcurrentClaims: 1, claimTtlSec: 1800 },
};

describe('validateClaimSpec — valid specs', () => {
  it('accepts a fully-featured spec exercising every vocabulary feature', () => {
    const r = validateClaimSpec(fullSpec);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.spec).toMatchObject({ specId: 'sched-7f3a', revision: 4 });
  });

  it('accepts a minimal spec — empty view, single rank term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 's1',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a valid weighted-mode spec with weights on every term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'w1',
      revision: 1,
      view: {},
      rank: {
        mode: 'weighted',
        terms: [
          { expr: 'priority', dir: 'desc', weight: 2 },
          { expr: 'est_cost', dir: 'asc', weight: 0.5 },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts each known rank function as a term head', () => {
    for (const fn of RANK_FUNCTIONS) {
      const expr = fn === 'redundancy_need' ? 'redundancy_need' : `${fn}(x,y)`;
      const r = validateClaimSpec({
        specVersion: '1.0',
        specId: `rf-${fn}`,
        revision: 0,
        view: {},
        rank: { mode: 'lexicographic', terms: [{ expr, dir: 'desc' }] },
      });
      expect(r.ok, `rank function ${fn} should validate`).toBe(true);
    }
  });

  it('warns (but stays ok) when a weight is set in lexicographic mode', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'lw',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc', weight: 3 }] },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('ignored in mode "lexicographic"'))).toBe(true);
  });
});

describe('validateClaimSpec — the default spec', () => {
  it('the exported DEFAULT_CLAIM_SPEC validates clean', () => {
    const r = validateClaimSpec(DEFAULT_CLAIM_SPEC);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('default spec is the baseline: empty view, revision 0, current version', () => {
    expect(DEFAULT_CLAIM_SPEC.revision).toBe(0);
    expect(DEFAULT_CLAIM_SPEC.specVersion).toBe(CURRENT_SPEC_VERSION);
    expect(DEFAULT_CLAIM_SPEC.view.filter).toBeUndefined();
    expect(DEFAULT_CLAIM_SPEC.rank.terms.length).toBeGreaterThan(0);
  });
});

describe('validateClaimSpec — invalid: filter vocabulary', () => {
  it('rejects an unknown filter field', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'x',
      revision: 0,
      view: { filter: { field: 'nonsense', op: '=', value: 1 } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('field'))).toBe(true);
  });

  it('rejects an unknown filter op', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'x',
      revision: 0,
      view: { filter: { field: 'priority', op: '~=', value: 1 } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('op'))).toBe(true);
  });

  it('rejects a floor field (blocked / cursed) in the filter — floors are not spec-controlled', () => {
    for (const field of ['blocked', 'cursed']) {
      const r = validateClaimSpec({
        specVersion: '1.0',
        specId: 'floor',
        revision: 0,
        view: { filter: { field, op: '=', value: false } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      });
      expect(r.ok, `${field} must not be filterable`).toBe(false);
    }
  });

  it('rejects op/value mismatch — `in` without an array', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'm',
      revision: 0,
      view: { filter: { field: 'kind', op: 'in', value: 'feature' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('requires an array'))).toBe(true);
  });

  it('rejects op/value mismatch — numeric comparator with a string', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'm2',
      revision: 0,
      view: { filter: { field: 'risk_tier', op: '<=', value: 'two' } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('numeric'))).toBe(true);
  });

  it('rejects op/value mismatch — scalar comparator with an array', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'm3',
      revision: 0,
      view: { filter: { field: 'kind', op: '=', value: ['feature', 'bug'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('single scalar'))).toBe(true);
  });

  it('validates nested combinators and reports the deep path of a bad leaf', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'nested',
      revision: 0,
      view: {
        filter: { all: [{ any: [{ field: 'kind', op: 'in', value: 'feature' }] }] },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('view.filter.all[0].any[0]'))).toBe(true);
  });
});

describe('validateClaimSpec — invalid: rank vocabulary', () => {
  it('rejects an unknown rank term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'r',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'made_up_metric', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unknown rank term'))).toBe(true);
  });

  it('rejects an unknown rank FUNCTION head', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'rfn',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'bogus(bee.x,item.y)', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unknown rank term') && e.includes('bogus'))).toBe(true);
  });

  it('rejects weighted mode missing a weight on a term', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'wm',
      revision: 0,
      view: {},
      rank: {
        mode: 'weighted',
        terms: [
          { expr: 'priority', dir: 'desc', weight: 1 },
          { expr: 'age', dir: 'asc' }, // missing weight
        ],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('requires a finite "weight"'))).toBe(true);
  });

  it('rejects an empty rank.terms array', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'e',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [] },
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateClaimSpec — invalid: version + structure', () => {
  it('rejects an unsupported spec version', () => {
    const r = validateClaimSpec({
      specVersion: '0.9',
      specId: 'v',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unsupported spec version'))).toBe(true);
  });

  it('rejects a missing required field (specId)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('specId'))).toBe(true);
  });

  it('rejects a negative revision', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'neg',
      revision: -1,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('revision'))).toBe(true);
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'extra',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      bonusMutableQueryFragment: { sneaky: true },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object input without throwing', () => {
    for (const bad of [null, undefined, 42, 'spec', []]) {
      const r = validateClaimSpec(bad);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects an invalid limits value (zero TTL)', () => {
    const r = validateClaimSpec({
      specVersion: '1.0',
      specId: 'lim',
      revision: 0,
      view: {},
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'desc' }] },
      limits: { claimTtlSec: 0 },
    });
    expect(r.ok).toBe(false);
  });
});

describe('claim-spec vocabulary exports', () => {
  it('filterable fields exclude the floor fields blocked + cursed', () => {
    expect(ITEM_FIELDS).toContain('blocked');
    expect(ITEM_FIELDS).toContain('cursed');
    expect(FILTERABLE_ITEM_FIELDS).not.toContain('blocked');
    expect(FILTERABLE_ITEM_FIELDS).not.toContain('cursed');
  });

  it('the schema parses the default spec directly (Zod layer agrees with the validator)', () => {
    expect(() => claimSpecSchema.parse(DEFAULT_CLAIM_SPEC)).not.toThrow();
  });

  it('exposes a non-empty op + version vocabulary', () => {
    expect(FILTER_OPS.length).toBeGreaterThan(0);
    expect(SUPPORTED_SPEC_VERSIONS).toContain(CURRENT_SPEC_VERSION);
  });
});
