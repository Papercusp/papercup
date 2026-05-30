import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planValue,
  selectionsFromArgs,
  AGENTS,
  NO_PLAN,
} from '../scripts/psu-launcher.mjs';

describe('psu-launcher arg parsing', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      picker: true,
      agent: null,
      harness: null,
      plan: null,
      noPlan: false,
    });
  });

  it('parses the scripting-escape flags', () => {
    expect(parseArgs(['--no-picker', '--agent=claude', '--harness=papercup', '--plan=my-plan'])).toEqual({
      picker: false,
      agent: 'claude',
      harness: 'papercup',
      plan: 'my-plan',
      noPlan: false,
    });
  });

  it('parses --no-plan', () => {
    expect(parseArgs(['--no-picker', '--agent=omp', '--harness=x', '--no-plan']).noPlan).toBe(true);
  });

  it('planValue maps the NO_PLAN sentinel + empties to null', () => {
    expect(planValue(NO_PLAN)).toBeNull();
    expect(planValue('')).toBeNull();
    expect(planValue(null)).toBeNull();
    expect(planValue('real-plan')).toBe('real-plan');
  });

  it('selectionsFromArgs resolves --no-plan to a null plan', () => {
    expect(selectionsFromArgs({ agent: 'omp', harness: 'papercup', plan: null, noPlan: true })).toEqual({
      agent: 'omp',
      harness: 'papercup',
      plan: null,
    });
  });

  it('selectionsFromArgs keeps --plan when --no-plan is absent', () => {
    expect(selectionsFromArgs({ agent: 'codex', harness: null, plan: 'p', noPlan: false })).toEqual({
      agent: 'codex',
      harness: null,
      plan: 'p',
    });
  });

  it('selectionsFromArgs rejects an unknown agent', () => {
    expect(() => selectionsFromArgs({ agent: 'gemini', harness: 'x', plan: null, noPlan: false })).toThrow();
  });

  it('AGENTS lists exactly the three kinds', () => {
    expect(AGENTS).toEqual(['claude', 'omp', 'codex']);
  });
});
