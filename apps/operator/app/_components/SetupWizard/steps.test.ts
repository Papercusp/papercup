import { describe, it, expect } from 'vitest';
import { SETUP_STEPS, findStep } from './steps';

describe('Setup Wizard steps', () => {
  it('exactly 12 steps in fixed order', () => {
    expect(SETUP_STEPS).toHaveLength(12);
    expect(SETUP_STEPS.map((s) => s.id)).toEqual([
      'os-permissions',
      'embedded-pg',
      'workspace',
      'agents',
      'local-model',
      'logins',
      'keys',
      'git',
      'mobile-pairing',
      'backups',
      'auto-update',
      'telemetry',
    ]);
  });

  it('exactly 4 required steps (embedded-pg, workspace, agents, keys)', () => {
    const required = SETUP_STEPS.filter((s) => s.required).map((s) => s.id);
    // `logins` is deliberately OPTIONAL (owner call 2026-06-12): sign-in
    // can happen later from Settings or a terminal, and API keys are an
    // alternative credential path — the wizard must not gate on it.
    // `keys` IS required (owner 2026-07-06): the OpenAI embeddings key powers
    // mem0 memory + semantic search, so it's a required setup step (skippable
    // with a warning, but the setup reads incomplete until it's added).
    expect(required).toEqual(['embedded-pg', 'workspace', 'agents', 'keys']);
  });

  it('findStep returns the matching definition', () => {
    expect(findStep('agents')?.title).toBe('Agent Runtime');
    expect(findStep('telemetry')?.summary).toMatch(/diagnostic/i);
  });

  it('findStep returns undefined for unknown / null / empty', () => {
    expect(findStep('does-not-exist')).toBeUndefined();
    expect(findStep(null)).toBeUndefined();
    expect(findStep(undefined)).toBeUndefined();
    expect(findStep('')).toBeUndefined();
  });

  it('every step has a non-empty title and summary', () => {
    for (const s of SETUP_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });
});
