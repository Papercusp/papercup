import { describe, expect, it } from 'vitest';
import assertTool from './agent-tools/facts/assert';
import {
  detectFactMeasurements,
  factMeasurementHint,
  formatFactMeasurementHint,
  MEASUREMENT_CONTEXT_WINDOW,
} from './fact-measurement-detector';

describe('fact measurement detector — moving numbers get an advisory', () => {
  it('flags the incident shape: measured status counts that can change after the write', () => {
    const signals = detectFactMeasurements(
      'Measured at 20:50Z: 0 adjudicated, 142 keyword-triage candidates, 214 unchecked. Recheck the file later.',
    );
    expect(signals.map((signal) => signal.value)).toEqual(['0', '142', '214']);
  });

  it('flags an as-of status count and a working-tree delta', () => {
    const signals = detectFactMeasurements(
      'As of now the status has 7 open items; the working tree reports +31/-8 uncommitted changes.',
    );
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.some((signal) => signal.value === '7')).toBe(true);
    expect(signals.some((signal) => signal.value.includes('+31'))).toBe(true);
  });

  it('does not warn on fixed numeric prose without moving-state language', () => {
    const fixed = [
      'Migration 689 has a 3-step process.',
      'The convention requires 3 claims before review.',
      'The suite runs 155 tests in 12 seconds.',
      'See commit abc1234 for the rationale; the 1200-char cap is intentional.',
    ];
    for (const body of fixed) expect(detectFactMeasurements(body), body).toEqual([]);
  });

  it('keeps distant state language from making an unrelated number look measured', () => {
    const body = `12345 ${'x'.repeat(MEASUREMENT_CONTEXT_WINDOW * 3)} current status is stable`;
    expect(detectFactMeasurements(body)).toEqual([]);
  });

  it('is fail-soft for non-string input and bounded large input', () => {
    expect(detectFactMeasurements(null)).toEqual([]);
    const body = 'currently 12 open items '.repeat(5_000);
    const started = Date.now();
    expect(factMeasurementHint(body)).toMatch(/measurement-like|Advisory only/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('renders a null clean case and a useful non-blocking advisory', () => {
    expect(formatFactMeasurementHint([])).toBeNull();
    const hint = factMeasurementHint('currently 4 unchecked rows')!;
    expect(hint).toContain('invariant conclusion');
    expect(hint).toContain('remeasure');
    expect(hint).toMatch(/write succeeded|nothing was blocked/i);
  });

  it('documents the right authoring path in live facts:assert guidance', () => {
    const notWhen = assertTool.guidance?.notWhen ?? '';
    expect(notWhen).toMatch(/not a live measurement/i);
    expect(notWhen).toMatch(/invariant conclusion/i);
    expect(notWhen).toMatch(/remeasure/i);
    expect(notWhen).toMatch(/historical/i);
    expect(assertTool.args.shape.subjectVolatile.description).toMatch(/SNAPSHOT|15 minutes/);
    expect(assertTool.args.shape.measuredAt.description).toMatch(/ISO timestamp|subjectVolatile/);
  });
});
