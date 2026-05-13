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
      'logins',
      'keys',
      'git',
      'voice-devices',
      'mobile-pairing',
      'backups',
      'auto-update',
      'telemetry',
    ]);
  });

  it('exactly 3 required steps (embedded-pg, workspace, agents)', () => {
    const required = SETUP_STEPS.filter((s) => s.required).map((s) => s.id);
    expect(required).toEqual(['embedded-pg', 'workspace', 'agents']);
  });

  it('findStep returns the matching definition', () => {
    expect(findStep('agents')?.title).toBe('Coding agents');
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
