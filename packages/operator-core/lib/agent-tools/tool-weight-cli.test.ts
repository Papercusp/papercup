import { describe, expect, it, vi } from 'vitest';
import { BUDGET, HARD_CAP, type NamedToolWeight } from './tool-guidance-budget';
import {
  formatToolWeightReport,
  measureToolWeights,
  parseToolWeightArgs,
  runToolWeightCli,
} from './tool-weight-cli';

const weights: NamedToolWeight[] = [
  { name: 'small:tool', weight: 200 },
  { name: 'over:budget', weight: BUDGET + 7 },
  { name: 'over:hard-cap', weight: HARD_CAP + 4 },
];

describe('tool-weight CLI', () => {
  it('parses a single tool selector and JSON output flag', () => {
    expect(parseToolWeightArgs(['--json', 'over:budget'])).toEqual({
      all: false,
      json: true,
      selector: 'over:budget',
    });
  });

  it('rejects ambiguous selectors', () => {
    expect(() => parseToolWeightArgs(['--all', 'over:budget'])).toThrow(/either --all or a tool name/);
  });

  it('reports the runtime weight and exact trim for a selected tool', () => {
    const rows = measureToolWeights(weights, 'over:budget');
    const report = formatToolWeightReport(rows, weights.length, { selector: 'over:budget' });
    expect(report).toContain(`over:budget: ${BUDGET + 7} chars`);
    expect(report).toContain('cut at least 7 chars');
  });

  it('returns a non-zero status for an unknown runtime tool', () => {
    const error = vi.fn();
    expect(runToolWeightCli(['missing:tool'], weights, vi.fn(), error)).toBe(1);
    expect(error).toHaveBeenCalledWith('No runtime-projected tool named missing:tool');
  });
});
