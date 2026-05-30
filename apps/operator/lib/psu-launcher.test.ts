import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planValue,
  selectionsFromArgs,
  resumeArgsFor,
  AGENTS,
  NO_PLAN,
} from '../scripts/psu-launcher.mjs';

describe('psu-launcher arg parsing', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      picker: true,
      resume: false,
      agent: null,
      workspace: null,
      harness: null,
      plan: null,
      noPlan: false,
    });
  });

  it('parses the scripting-escape flags', () => {
    expect(
      parseArgs(['--no-picker', '--agent=claude', '--workspace=ws1', '--harness=papercup', '--plan=my-plan']),
    ).toEqual({
      picker: false,
      resume: false,
      agent: 'claude',
      workspace: 'ws1',
      harness: 'papercup',
      plan: 'my-plan',
      noPlan: false,
    });
  });

  it('parses --resume', () => {
    expect(parseArgs(['--resume']).resume).toBe(true);
  });

  it('parses --no-plan', () => {
    expect(parseArgs(['--no-picker', '--agent=omp', '--harness=x', '--no-plan']).noPlan).toBe(true);
  });

  it('resumeArgsFor maps each agent to its wrapper + resume args', () => {
    expect(resumeArgsFor({ agent: 'claude', cwd: '/x' })).toEqual({
      wrapperBin: 'claude-su',
      args: ['--continue'],
    });
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: 'thr-1' })).toEqual({
      wrapperBin: 'omp-su',
      args: ['-r', 'thr-1'],
    });
    expect(resumeArgsFor({ agent: 'omp', cwd: '/x', ompThreadId: null })).toEqual({
      wrapperBin: 'omp-su',
      args: ['-c'],
    });
    expect(resumeArgsFor({ agent: 'codex', cwd: '/x' })).toEqual({
      wrapperBin: 'codex-su',
      args: ['resume', '--last'],
    });
    expect(() => resumeArgsFor({ agent: 'gemini', cwd: '/x' })).toThrow();
  });

  it('planValue maps the NO_PLAN sentinel + empties to null', () => {
    expect(planValue(NO_PLAN)).toBeNull();
    expect(planValue('')).toBeNull();
    expect(planValue(null)).toBeNull();
    expect(planValue('real-plan')).toBe('real-plan');
  });

  it('selectionsFromArgs resolves --no-plan to a null plan + passes workspace', () => {
    expect(
      selectionsFromArgs({ agent: 'omp', workspace: 'ws1', harness: 'papercup', plan: null, noPlan: true }),
    ).toEqual({
      agent: 'omp',
      workspace: 'ws1',
      harness: 'papercup',
      plan: null,
    });
  });

  it('selectionsFromArgs keeps --plan when --no-plan is absent; null workspace when omitted', () => {
    expect(selectionsFromArgs({ agent: 'codex', workspace: null, harness: null, plan: 'p', noPlan: false })).toEqual({
      agent: 'codex',
      workspace: null,
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
