import { describe, expect, it } from 'vitest';
import evaluateSpecQualityTool from './evaluate-spec-quality';
import startPlanTool from './start';

// Keep the activation tool imports out of detector-only test runs.
describe('spec-quality activation guidance', () => {
  it('accepts only a valid exact specSetHash replay guard', () => {
    expect(
      evaluateSpecQualityTool.args.safeParse({
        harness: 'papercusp',
        slug: 'quality-plan',
        expectedSpecSetHash: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      evaluateSpecQualityTool.args.safeParse({
        harness: 'papercusp',
        slug: 'quality-plan',
        expectedSpecSetHash: 'not-a-hash',
      }).success,
    ).toBe(false);
  });

  it('publishes the scorecard → automatically routed audit → start sequence', () => {
    const evaluateGuidance = [
      evaluateSpecQualityTool.description,
      evaluateSpecQualityTool.guidance?.when,
      evaluateSpecQualityTool.guidance?.returns,
      evaluateSpecQualityTool.guidance?.chaining,
    ].join('\n');
    const evaluateChain = evaluateSpecQualityTool.guidance?.chaining ?? '';
    const startGuidance = [
      startPlanTool.description,
      startPlanTool.guidance?.when,
      startPlanTool.guidance?.chaining,
    ].join('\n');

    for (const guidance of [evaluateGuidance, startGuidance]) {
      expect(guidance).toContain('plans:evaluate-spec-quality');
      expect(guidance).toContain('scorecards:emit');
      expect(guidance).toContain('grading-integrity');
      expect(guidance).toContain('plans:start');
    }
    expect(evaluateGuidance).toContain('automatically route the independent non-author');
    expect(evaluateGuidance).toContain('scorecards:repair');
    expect(evaluateGuidance).not.toContain('capability:launch-agent');
    expect(evaluateGuidance).toContain('Never recruit the auditor yourself');
    expect(evaluateChain.indexOf('plans:evaluate-spec-quality')).toBeLessThan(evaluateChain.indexOf('scorecards:emit'));
    expect(evaluateChain.indexOf('scorecards:emit')).toBeLessThan(evaluateChain.indexOf('grading-integrity'));
    expect(evaluateChain.indexOf('grading-integrity')).toBeLessThan(evaluateChain.indexOf('plans:start'));
  });
});
