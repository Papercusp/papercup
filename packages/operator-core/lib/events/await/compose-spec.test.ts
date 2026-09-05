import { describe, it, expect } from 'vitest';
import {
  classifyNode,
  composedWakeSummary,
  ComposedSpecError,
  flattenLeaves,
  MAX_TREE_DEPTH,
  MAX_TREE_LEAVES,
  normalizeRoot,
  resolveLeafKey,
  specDepth,
  specIdentity,
  validateSpec,
  type ComposedSpec,
} from './compose-spec';

describe('classifyNode', () => {
  it('recognizes a leaf { event, when? }', () => {
    expect(classifyNode({ event: 'work-item:created' })).toEqual({ kind: 'leaf', event: 'work-item:created', when: undefined });
    const withWhen = classifyNode({ event: 'x', when: { 'args.k': 'v' } });
    expect(withWhen).toMatchObject({ kind: 'leaf', event: 'x', when: { 'args.k': 'v' } });
  });

  it('maps combinators to their k-of-n threshold: all=n, any=1, some=require', () => {
    expect(classifyNode({ all: [{ event: 'a' }, { event: 'b' }, { event: 'c' }] })).toMatchObject({ kind: 'combinator', op: 'all', required: 3 });
    expect(classifyNode({ any: [{ event: 'a' }, { event: 'b' }] })).toMatchObject({ kind: 'combinator', op: 'any', required: 1 });
    expect(classifyNode({ some: { require: 2, of: [{ event: 'a' }, { event: 'b' }, { event: 'c' }] } })).toMatchObject({
      kind: 'combinator',
      op: 'some',
      required: 2,
    });
  });

  it('rejects an event-level `not` with the timeout-observes-absence message', () => {
    expect(() => classifyNode({ not: { event: 'a' } })).toThrow(ComposedSpecError);
    expect(() => classifyNode({ not: { event: 'a' } })).toThrow(/timeout/i);
  });

  it('rejects a some.require that exceeds its of-count (could never fire)', () => {
    expect(() => classifyNode({ some: { require: 3, of: [{ event: 'a' }, { event: 'b' }] } })).toThrow(/never fire/);
  });

  it('rejects some.require < 1 and non-integer', () => {
    expect(() => classifyNode({ some: { require: 0, of: [{ event: 'a' }] } })).toThrow(/require/);
    expect(() => classifyNode({ some: { require: 1.5, of: [{ event: 'a' }, { event: 'b' }] } })).toThrow(/integer/);
  });

  it('rejects empty combinator arrays', () => {
    expect(() => classifyNode({ all: [] })).toThrow(/non-empty/);
    expect(() => classifyNode({ any: [] })).toThrow(/non-empty/);
    expect(() => classifyNode({ some: { require: 1, of: [] } })).toThrow(/non-empty/);
  });

  it('rejects a combinator with extra keys (not a sole key)', () => {
    expect(() => classifyNode({ all: [{ event: 'a' }], any: [{ event: 'b' }] })).toThrow(/exactly one key/);
  });

  it('rejects a leaf carrying extra keys, and an empty/non-string event', () => {
    expect(() => classifyNode({ event: 'a', foo: 1 })).toThrow(/extra key/);
    expect(() => classifyNode({ event: '' })).toThrow(/non-empty string/);
    expect(() => classifyNode({ event: 5 })).toThrow(/non-empty string/);
  });

  it('rejects a non-object and an unknown node shape', () => {
    expect(() => classifyNode('x' as unknown)).toThrow(ComposedSpecError);
    expect(() => classifyNode({ foo: 1 })).toThrow(/neither a leaf .* nor a combinator/);
  });
});

describe('normalizeRoot', () => {
  it('wraps a bare-leaf root in a one-child all so the root is always a combinator', () => {
    expect(normalizeRoot({ event: 'a' })).toEqual({ all: [{ event: 'a' }] });
  });
  it('leaves a combinator root unchanged', () => {
    const spec: ComposedSpec = { any: [{ event: 'a' }, { event: 'b' }] };
    expect(normalizeRoot(spec)).toBe(spec);
  });
});

describe('specDepth / flattenLeaves', () => {
  it('depth: leaf=1, combinator-of-leaves=2, nested=3', () => {
    expect(specDepth({ event: 'a' })).toBe(1);
    expect(specDepth({ all: [{ event: 'a' }, { event: 'b' }] })).toBe(2);
    expect(specDepth({ all: [{ event: 'a' }, { any: [{ event: 'b' }, { event: 'c' }] }] })).toBe(3);
  });
  it('flattenLeaves collects every leaf in DFS order', () => {
    const leaves = flattenLeaves({ all: [{ event: 'a' }, { some: { require: 1, of: [{ event: 'b' }, { event: 'c' }] } }] });
    expect(leaves.map((l) => l.event)).toEqual(['a', 'b', 'c']);
  });
});

describe('validateSpec', () => {
  it('accepts a valid nested tree and returns its leaves + depth', () => {
    const res = validateSpec({ any: [{ event: 'work-item:created' }, { all: [{ event: 'a' }, { event: 'b' }] }] });
    expect(res.depth).toBe(3);
    expect(res.leaves.map((l) => l.event)).toEqual(['work-item:created', 'a', 'b']);
  });

  it(`rejects depth > ${MAX_TREE_DEPTH}`, () => {
    // all → any → all → leaves = depth 4
    const tooDeep: ComposedSpec = { all: [{ any: [{ all: [{ event: 'a' }, { event: 'b' }] }] }] };
    expect(() => validateSpec(tooDeep)).toThrow(/depth/);
  });

  it(`rejects leaves > ${MAX_TREE_LEAVES}`, () => {
    const many: ComposedSpec = { any: Array.from({ length: MAX_TREE_LEAVES + 1 }, (_, i) => ({ event: `e${i}` })) };
    expect(() => validateSpec(many)).toThrow(/leaves/);
  });

  it('accepts anchored pattern + macro leaves, rejects a too-broad glob', () => {
    expect(() => validateSpec({ any: [{ event: 'work-item:done:*' }, { event: '@plan:my-plan' }] })).not.toThrow();
    expect(() => validateSpec({ any: [{ event: '*' }] })).toThrow(/too broad/);
  });
});

describe('resolveLeafKey', () => {
  it('expands @macros and passes globs / exact keys through', () => {
    expect(resolveLeafKey('@plan:foo')).toBe('plan-item:done:foo:*');
    expect(resolveLeafKey('work-item:done:*')).toBe('work-item:done:*');
    expect(resolveLeafKey('lock:grant:t1')).toBe('lock:grant:t1');
  });
});

describe('composedWakeSummary', () => {
  it('distinguishes a satisfied trip from a timeout', () => {
    expect(composedWakeSummary({ satisfied: true, firedCount: 2, leafCount: 3 })).toMatch(/consumed.*satisfied — 2\/3/);
    expect(composedWakeSummary({ satisfied: false, firedCount: 1, leafCount: 3 })).toMatch(/consumed.*timed out — only 1\/3/);
  });
});

/**
 * EI-14793: `specIdentity` is what lets a composed re-arm supersede the caller's own prior
 * tree. Two directions matter and they fail differently, so both are pinned here:
 *
 *  - too NARROW (equivalent specs read as different) → no supersede → the reported bug
 *    survives: roots accumulate and one event fires N wakes.
 *  - too WIDE (different specs collide) → a re-arm cancels a tree the caller still needs
 *    and a wake is LOST — silent, and strictly worse than the bug being fixed.
 */
describe('specIdentity', () => {
  it('is stable across two separately-constructed but identical specs', () => {
    // The reporter's actual idle-park spec, built twice.
    const a: ComposedSpec = { any: [{ event: 'work-item:created:*' }, { event: 'work-item:unblocked:*' }] };
    const b: ComposedSpec = { any: [{ event: 'work-item:created:*' }, { event: 'work-item:unblocked:*' }] };
    expect(specIdentity(a)).toBe(specIdentity(b));
  });

  it('ignores sibling ORDER — {any:[a,b]} and {any:[b,a]} wait for the same thing', () => {
    const ab: ComposedSpec = { any: [{ event: 'work-item:created:*' }, { event: 'work-item:unblocked:*' }] };
    const ba: ComposedSpec = { any: [{ event: 'work-item:unblocked:*' }, { event: 'work-item:created:*' }] };
    expect(specIdentity(ab)).toBe(specIdentity(ba));
  });

  it('ignores `when` KEY ORDER but not its content', () => {
    const k1: ComposedSpec = { event: 'x', when: { 'args.a': 1, 'args.b': 2 } as never };
    const k2: ComposedSpec = { event: 'x', when: { 'args.b': 2, 'args.a': 1 } as never };
    expect(specIdentity(k1)).toBe(specIdentity(k2));

    const different: ComposedSpec = { event: 'x', when: { 'args.a': 1, 'args.b': 99 } as never };
    expect(specIdentity(k1)).not.toBe(specIdentity(different));
  });

  // ── the too-WIDE direction: each of these MUST stay distinct, or a re-arm eats a live wait
  it('distinguishes combinator KIND — any is not all', () => {
    const leaves: ComposedSpec[] = [{ event: 'a' }, { event: 'b' }];
    expect(specIdentity({ any: leaves })).not.toBe(specIdentity({ all: leaves }));
  });

  it('distinguishes the some{} THRESHOLD', () => {
    const of: ComposedSpec[] = [{ event: 'a' }, { event: 'b' }, { event: 'c' }];
    expect(specIdentity({ some: { require: 2, of } })).not.toBe(specIdentity({ some: { require: 3, of } }));
  });

  it('distinguishes different leaf events, and a bare leaf from a filtered one', () => {
    expect(specIdentity({ event: 'a' })).not.toBe(specIdentity({ event: 'b' }));
    expect(specIdentity({ event: 'a' })).not.toBe(specIdentity({ event: 'a', when: { 'args.k': 'v' } as never }));
  });

  it('distinguishes a SUBSET from a superset — an extra branch is a different wait', () => {
    const two: ComposedSpec = { any: [{ event: 'a' }, { event: 'b' }] };
    const three: ComposedSpec = { any: [{ event: 'a' }, { event: 'b' }, { event: 'c' }] };
    expect(specIdentity(two)).not.toBe(specIdentity(three));
  });

  /**
   * FALSIFIABILITY CONTROL (permanent, not a probe): a deliberately-weak identity that keys
   * only on the SET of leaf events, ignoring combinator kind and threshold — the most likely
   * way to write this function wrong. It must COLLIDE on exactly the cases the tests above
   * separate. Without this, those `not.toBe` assertions could be passing for a reason no one
   * has checked; with it, the cases are proven to discriminate rather than assumed to.
   */
  const leafSetIdentity = (spec: ComposedSpec): string =>
    flattenLeaves(spec)
      .map((l) => l.event)
      .sort()
      .join(',');

  it('CONTROL: a leaf-set-only identity collides where specIdentity correctly separates', () => {
    const leaves: ComposedSpec[] = [{ event: 'a' }, { event: 'b' }];
    const of: ComposedSpec[] = [{ event: 'a' }, { event: 'b' }, { event: 'c' }];

    // The weak implementation cannot tell these apart...
    expect(leafSetIdentity({ any: leaves })).toBe(leafSetIdentity({ all: leaves }));
    expect(leafSetIdentity({ some: { require: 2, of } })).toBe(leafSetIdentity({ some: { require: 3, of } }));

    // ...and the real one does. If this pair ever agrees, the assertions above are vacuous.
    expect(specIdentity({ any: leaves })).not.toBe(specIdentity({ all: leaves }));
    expect(specIdentity({ some: { require: 2, of } })).not.toBe(specIdentity({ some: { require: 3, of } }));
  });

  it('agrees with normalizeRoot: a bare leaf and its wrapped form are one identity', () => {
    // compose.ts computes identity on the NORMALIZED spec, so these must not diverge —
    // otherwise a bare-leaf re-arm would never supersede its own prior registration.
    const bare: ComposedSpec = { event: 'work-item:claimable' };
    expect(specIdentity(normalizeRoot(bare))).toBe(specIdentity({ all: [bare] }));
  });
});
