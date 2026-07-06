import { describe, expect, it } from 'vitest';
import { parseOnboardingQuery } from './onboarding-status';

const URL_BASE = 'http://127.0.0.1:3070/api/desktop/onboarding-status';

describe('parseOnboardingQuery', () => {
  it('defaults: no choices', () => {
    expect(parseOnboardingQuery(URL_BASE, 'linux')).toEqual({
      chosen: null,
      forcePick: false,
      embeddingsSkipped: false,
      tutorial: false,
      os: 'linux',
    });
  });

  it('parses a valid chosen framework + flags', () => {
    const parsed = parseOnboardingQuery(
      `${URL_BASE}?chosen=codex&forcePick=1&embeddingsSkipped=1&tutorial=1`,
      'linux',
    );
    expect(parsed).toEqual({
      chosen: 'codex',
      forcePick: true,
      embeddingsSkipped: true,
      tutorial: true,
      os: 'linux',
    });
  });

  it('rejects an unknown framework as null', () => {
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=gpt-cli`, 'linux').chosen).toBeNull();
    // omp-meridian is decommissioned — no longer an allowed framework.
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=omp-meridian`, 'linux').chosen).toBeNull();
  });

  it('accepts claude + codex on win32', () => {
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=claude`, 'win32').chosen).toBe('claude');
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=codex`, 'win32').chosen).toBe('codex');
  });
});
