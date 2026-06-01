import { describe, it, expect } from 'vitest';
import { SETUP_STEPS, findStep } from './steps';

describe('Setup Wizard steps', () => {
  it('exactly 11 steps in fixed order', () => {
    expect(SETUP_STEPS).toHaveLength(11);
    expect(SETUP_STEPS.map((s) => s.id)).toEqual([
      'os-permissions',
      'embedded-pg',
      'workspace',
      'agents',
      'logins',
      'keys',
      'git',
      'mobile-pairing',
      'backups',
      'auto-update',
      'telemetry',
    ]);
  });

  it('exactly 4 required steps (embedded-pg, workspace, agents, logins)', () => {
    const required = SETUP_STEPS.filter((s) => s.required).map((s) => s.id);
    // `logins` is required — "agents cannot run without it" (steps.ts).
    expect(required).toEqual(['embedded-pg', 'workspace', 'agents', 'logins']);
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
