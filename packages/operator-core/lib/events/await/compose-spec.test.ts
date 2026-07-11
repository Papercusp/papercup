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
    expect(composedWakeSummary({ satisfied: true, firedCount: 2, leafCount: 3 })).toMatch(/satisfied — 2\/3/);
    expect(composedWakeSummary({ satisfied: false, firedCount: 1, leafCount: 3 })).toMatch(/timed out — only 1\/3/);
  });
});
