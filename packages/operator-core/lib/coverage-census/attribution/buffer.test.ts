/**
 * Unit tests for the traffic-evidence buffer.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * WHAT THESE ARE FOR. The buffer decides what one `coverage_evidence` row MEANS: which calls
 * collapse into one binding, and which verdict survives when they disagree. Both are decisions
 * a reader of the table cannot second-guess later — by then the discarded observations are
 * gone — so they are pinned here rather than left to be inferred from the implementation.
 */

import { describe, expect, it } from 'vitest';
import { EvidenceBuffer, bindingKey, type TrafficObservation } from './buffer';

const obs = (over: Partial<TrafficObservation> = {}): TrafficObservation => ({
  kind: 'http-route',
  surfaceId: 'GET /api/widgets',
  verdict: 'pass',
  runGroupId: 'run-1',
  testFile: 'packages/operator-core/lib/a.test.ts',
  testCase: 'serves widgets',
  ...over,
});

describe('bindingKey', () => {
  it('cannot collide across a field boundary', () => {
    // The concrete hazard: a printable separator would let a tool named `a:b` under kind `a`
    // produce the same key as kind `a` + surfaceId `b`. The NUL separator makes that
    // impossible, because NUL cannot appear inside any of the four values.
    const a = bindingKey({ kind: 'a', surfaceId: 'b:c', testFile: null, testCase: null });
    const b = bindingKey({ kind: 'a:b', surfaceId: 'c', testFile: null, testCase: null });
    expect(a).not.toBe(b);
  });

  it('treats a null test file/case as its own identity, not as a wildcard', () => {
    const withCase = bindingKey({ kind: 'k', surfaceId: 's', testFile: 'f', testCase: 'c' });
    const withoutCase = bindingKey({ kind: 'k', surfaceId: 's', testFile: 'f', testCase: null });
    expect(withCase).not.toBe(withoutCase);
  });
});

describe('EvidenceBuffer collapse', () => {
  it('collapses repeated calls of one binding into a single row, counting them', () => {
    const buf = new EvidenceBuffer();
    buf.record(obs());
    buf.record(obs());
    buf.record(obs());

    const rows = buf.peek();
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(3);
  });

  it('keeps distinct rows per test case, which is what case-level coverage means', () => {
    const buf = new EvidenceBuffer();
    buf.record(obs({ testCase: 'case one' }));
    buf.record(obs({ testCase: 'case two' }));
    expect(buf.size).toBe(2);
  });

  it('keeps distinct rows per surface', () => {
    const buf = new EvidenceBuffer();
    buf.record(obs({ surfaceId: 'GET /api/widgets' }));
    buf.record(obs({ surfaceId: 'POST /api/widgets' }));
    expect(buf.size).toBe(2);
  });
});

describe('EvidenceBuffer verdict merge', () => {
  it('keeps the WORST verdict regardless of arrival order', () => {
    // Order-independence is the whole point: if the surviving verdict depended on which call
    // landed last, the same defect would be reported differently between two identical runs.
    const passThenError = new EvidenceBuffer();
    passThenError.record(obs({ verdict: 'pass' }));
    passThenError.record(obs({ verdict: 'error' }));

    const errorThenPass = new EvidenceBuffer();
    errorThenPass.record(obs({ verdict: 'error' }));
    errorThenPass.record(obs({ verdict: 'pass' }));

    expect(passThenError.peek()[0].verdict).toBe('error');
    expect(errorThenPass.peek()[0].verdict).toBe('error');
  });

  it('ranks error above fail above pass above skip', () => {
    const check = (a: TrafficObservation['verdict'], b: TrafficObservation['verdict'], win: string) => {
      const buf = new EvidenceBuffer();
      buf.record(obs({ verdict: a }));
      buf.record(obs({ verdict: b }));
      expect(buf.peek()[0].verdict).toBe(win);
    };
    check('skip', 'pass', 'pass');
    check('pass', 'fail', 'fail');
    check('fail', 'error', 'error');
  });

  it('carries the details of the worst observation, not the last', () => {
    const buf = new EvidenceBuffer();
    buf.record(obs({ verdict: 'error', details: { httpStatus: 500 } }));
    buf.record(obs({ verdict: 'pass', details: { httpStatus: 200 } }));
    expect(buf.peek()[0].details).toMatchObject({ httpStatus: 500 });
  });
});

describe('EvidenceBuffer generated flag', () => {
  it('is generated only when EVERY observation was generated', () => {
    // A fuzzer hitting a surface a hand-written test already covers must not be able to erase
    // the hand-written evidence — `generated` is exactly the flag the L3 intent tier reads.
    const buf = new EvidenceBuffer();
    buf.record(obs({ generated: true }));
    buf.record(obs({ generated: false }));
    expect(buf.peek()[0].generated).toBe(false);

    const allGenerated = new EvidenceBuffer();
    allGenerated.record(obs({ generated: true }));
    allGenerated.record(obs({ generated: true }));
    expect(allGenerated.peek()[0].generated).toBe(true);
  });
});

describe('EvidenceBuffer bounds', () => {
  it('drops NEW bindings past the ceiling and counts the drop rather than growing', () => {
    const buf = new EvidenceBuffer({ maxBindings: 2 });
    expect(buf.record(obs({ surfaceId: 'a' }))).toBe(true);
    expect(buf.record(obs({ surfaceId: 'b' }))).toBe(true);
    expect(buf.record(obs({ surfaceId: 'c' }))).toBe(false);

    expect(buf.size).toBe(2);
    expect(buf.dropped).toBe(1);
  });

  it('still accepts repeat observations of an EXISTING binding when full', () => {
    // Refusing these would silently under-count a surface that is already tracked, which is a
    // worse outcome than the memory the row already occupies.
    const buf = new EvidenceBuffer({ maxBindings: 1 });
    buf.record(obs({ surfaceId: 'a' }));
    expect(buf.record(obs({ surfaceId: 'a' }))).toBe(true);
    expect(buf.peek()[0].calls).toBe(2);
  });
});

describe('EvidenceBuffer drain', () => {
  it('empties the buffer so a second flush cannot rewrite the same rows', () => {
    const buf = new EvidenceBuffer();
    buf.record(obs());
    expect(buf.drain()).toHaveLength(1);
    expect(buf.size).toBe(0);
    expect(buf.drain()).toHaveLength(0);
  });
});
