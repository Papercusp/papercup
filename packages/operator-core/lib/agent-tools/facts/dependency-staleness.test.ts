/**
 * P-008 (b) — the pure half of dependency staleness
 * (unified-agent-state-plane-2026-07-27).
 *
 * Everything asserted here runs without PG, a cell registry, or a dispatcher.
 * That is the point: the three-valued verdict is only worth trusting if every
 * branch of it — including the two that must NOT collapse into each other
 * ("unchanged" vs "could not tell") — is directly exercisable.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  digestCellValue,
  renderObservedValue,
  evaluateDependencyStaleness,
  observationKey,
  type CurrentCellObservation,
} from './dependency-staleness';
import { FACT_DEPENDENCY_OBSERVED_CHARS, type FactDependency } from '../../agent-facts/store';

const dep = (over: Partial<FactDependency> = {}): FactDependency => ({
  cell: 'pipeline.myChange',
  observedAt: '2026-07-27T00:00:00.000Z',
  digest: digestCellValue('deployed'),
  observed: 'deployed',
  ...over,
});

const now = (entries: Record<string, CurrentCellObservation>) => new Map(Object.entries(entries));

describe('canonicalJson — order-independent for objects, order-SENSITIVE for arrays', () => {
  it('sorts object keys at every depth, so a resolver reordering its result is not a change', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('KEEPS array order — a reordered list is genuine new information', () => {
    // The distinction that matters: `{a,b}` and `{b,a}` are the same value;
    // `[a,b]` and `[b,a]` are not (think pipeline stages).
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('treats undefined-valued keys as absent, so an optional field appearing as undefined is not a change', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('does not throw on a cycle — this runs inside a fail-soft fold, far from its cause', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).not.toThrow();
  });

  it('normalizes non-finite numbers rather than emitting invalid JSON', () => {
    expect(canonicalJson({ n: NaN })).toBe(canonicalJson({ n: null }));
  });
});

describe('digestCellValue — the ONE comparison both halves share', () => {
  it('is stable across key order (the failure that would report everything stale forever)', () => {
    expect(digestCellValue({ x: 1, y: 2 })).toBe(digestCellValue({ y: 2, x: 1 }));
  });

  it('separates values that differ', () => {
    expect(digestCellValue('pushed')).not.toBe(digestCellValue('deployed'));
  });

  it('distinguishes null from the string "null" — a digest over prose would not', () => {
    expect(digestCellValue(null)).not.toBe(digestCellValue('null'));
  });
});

describe('renderObservedValue — a label, never the comparison input', () => {
  it('clips past the bound and marks the elision', () => {
    const rendered = renderObservedValue('x'.repeat(FACT_DEPENDENCY_OBSERVED_CHARS + 50));
    expect(rendered.length).toBe(FACT_DEPENDENCY_OBSERVED_CHARS);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('passes a short string through verbatim (no JSON quoting on the common case)', () => {
    expect(renderObservedValue('deployed')).toBe('deployed');
  });

  it('⚠ two DIFFERENT long values can render identically — which is why renderings are never compared', () => {
    const a = renderObservedValue(`${'x'.repeat(400)}A`);
    const b = renderObservedValue(`${'x'.repeat(400)}B`);
    expect(a).toBe(b);
    expect(digestCellValue(`${'x'.repeat(400)}A`)).not.toBe(digestCellValue(`${'x'.repeat(400)}B`));
  });
});

describe('evaluateDependencyStaleness', () => {
  it('returns null when nothing was declared — no field beats a "fresh" that was never checked', () => {
    expect(evaluateDependencyStaleness([], now({}))).toBeNull();
  });

  it('FRESH when the digest still matches', () => {
    const v = evaluateDependencyStaleness([dep()], now({ 'pipeline.myChange': { digest: digestCellValue('deployed') } }));
    expect(v?.status).toBe('fresh');
    expect(v?.changed).toEqual([]);
    expect(v?.note).toContain('✓');
  });

  it('STALE when the value moved, and the note names the cell, the old value and the new one', () => {
    const v = evaluateDependencyStaleness(
      [dep()],
      now({ 'pipeline.myChange': { digest: digestCellValue('pushed'), observed: 'pushed' } }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual(['pipeline.myChange']);
    expect(v?.deps[0].status).toBe('changed');
    // D-012: staleness stops being a judgement call — the verdict must SHOW its work.
    expect(v?.note).toContain('pipeline.myChange');
    expect(v?.note).toContain('deployed');
    expect(v?.note).toContain('pushed');
  });

  it('UNDETERMINABLE, never fresh, when the cell was unreadable at ASSERT time', () => {
    // No anchor was ever captured, so there is nothing to compare against —
    // even though the cell reads perfectly well right now.
    const v = evaluateDependencyStaleness(
      [dep({ digest: undefined, observed: undefined, unknown: 'not-measured' })],
      now({ 'pipeline.myChange': { digest: digestCellValue('deployed') } }),
    );
    expect(v?.status).toBe('undeterminable');
    expect(v?.undeterminable).toEqual(['pipeline.myChange']);
    expect(v?.deps[0].detail).toMatch(/never been verifiable/);
  });

  it('UNDETERMINABLE, never fresh, when the cell is unreadable NOW', () => {
    const v = evaluateDependencyStaleness([dep()], now({ 'pipeline.myChange': { unknown: 'resolver-failed' } }));
    expect(v?.status).toBe('undeterminable');
    expect(v?.deps[0].detail).toContain('resolver-failed');
  });

  it('UNDETERMINABLE when the cell is missing from the current map entirely', () => {
    const v = evaluateDependencyStaleness([dep()], now({}));
    expect(v?.status).toBe('undeterminable');
  });

  it('⚠ a CHANGED dependency wins over an undeterminable one — a real change is never masked', () => {
    // The precedence that matters: if any dependency demonstrably moved, the
    // fact is stale, however many others could not be checked. Reporting
    // `undeterminable` here would hide a verdict we actually have.
    const v = evaluateDependencyStaleness(
      [dep({ cell: 'a' }), dep({ cell: 'b' })],
      now({
        a: { digest: digestCellValue('moved'), observed: 'moved' },
        b: { unknown: 'not-measured' },
      }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.changed).toEqual(['a']);
    expect(v?.undeterminable).toEqual(['b']);
  });

  it('undeterminable dependencies alone NEVER manufacture a stale verdict', () => {
    const v = evaluateDependencyStaleness([dep({ cell: 'a' })], now({ a: { unknown: 'not-measured' } }));
    expect(v?.status).toBe('undeterminable');
    expect(v?.changed).toEqual([]);
    // The note must not read as an all-clear: "not confirmed current" and
    // "known to be stale" are different, and a reader has to be told which.
    expect(v?.note).toMatch(/NOT confirmed current/);
  });

  it('every declared dependency gets a verdict row, whatever its outcome', () => {
    const v = evaluateDependencyStaleness(
      [dep({ cell: 'a' }), dep({ cell: 'b' }), dep({ cell: 'c' })],
      now({ a: { digest: digestCellValue('deployed') }, b: { digest: digestCellValue('other') } }),
    );
    expect(v?.deps.map((d) => `${d.cell}:${d.status}`)).toEqual(['a:fresh', 'b:changed', 'c:undeterminable']);
  });

  it('carries observedAt onto each verdict so a reader can see HOW OLD the anchor is', () => {
    const v = evaluateDependencyStaleness([dep()], now({}));
    expect(v?.deps[0].observedAt).toBe('2026-07-27T00:00:00.000Z');
  });
});

describe('subject keying — a caller-relative cell is a different question per subject', () => {
  it('reads the observation under the (cell, subject) key, not the bare cell id', () => {
    const d = dep({ cell: 'git.pipelinePosition', subject: 'a.ts', digest: digestCellValue('deployed') });
    // Keyed by cell alone this would miss and report undeterminable.
    const v = evaluateDependencyStaleness(
      [d],
      now({ [observationKey('git.pipelinePosition', 'a.ts')]: { digest: digestCellValue('deployed') } }),
    );
    expect(v?.status).toBe('fresh');
    expect(v?.deps[0].subject).toBe('a.ts');
  });

  it('⚠ does NOT match another subject\'s reading — the wrong-answer case, not merely a weaker one', () => {
    // Two files both sitting perfectly still would otherwise report `changed`
    // against each other.
    const d = dep({ cell: 'git.pipelinePosition', subject: 'a.ts', digest: digestCellValue('deployed') });
    const v = evaluateDependencyStaleness(
      [d],
      now({ [observationKey('git.pipelinePosition', 'b.ts')]: { digest: digestCellValue('pushed') } }),
    );
    expect(v?.status).toBe('undeterminable');
    expect(v?.changed).toEqual([]);
  });

  it('keeps two subjects of the same cell independent', () => {
    const v = evaluateDependencyStaleness(
      [
        dep({ cell: 'c', subject: 'a.ts', digest: digestCellValue('deployed') }),
        dep({ cell: 'c', subject: 'b.ts', digest: digestCellValue('deployed') }),
      ],
      now({
        [observationKey('c', 'a.ts')]: { digest: digestCellValue('deployed') },
        [observationKey('c', 'b.ts')]: { digest: digestCellValue('moved'), observed: 'moved' },
      }),
    );
    expect(v?.status).toBe('stale');
    expect(v?.deps.map((x) => x.status)).toEqual(['fresh', 'changed']);
  });

  it('observationKey keeps a subjectless cell as its bare id (no key churn for global cells)', () => {
    expect(observationKey('deploy.3070.sha')).toBe('deploy.3070.sha');
    expect(observationKey('c', 'x')).not.toBe(observationKey('c', 'y'));
  });

  it('an over-budget dependency reports undeterminable NAMING the budget, never fresh', () => {
    // "we ran out of read budget" and "nothing changed" are different facts and
    // only one is safe to act on — so the detail must not send a reader hunting
    // a resolver that is working fine.
    const v = evaluateDependencyStaleness([dep({ cell: 'z' })], now({ z: { unknown: 'read-budget-exceeded' } }));
    expect(v?.status).toBe('undeterminable');
    expect(v?.deps[0].detail).toContain('read-budget-exceeded');
  });
});
