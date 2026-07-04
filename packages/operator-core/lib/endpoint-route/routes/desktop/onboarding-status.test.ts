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
      `${URL_BASE}?chosen=omp-meridian&forcePick=1&embeddingsSkipped=1&tutorial=1`,
      'linux',
    );
    expect(parsed).toEqual({
      chosen: 'omp-meridian',
      forcePick: true,
      embeddingsSkipped: true,
      tutorial: true,
      os: 'linux',
    });
  });

  it('rejects an unknown framework as null', () => {
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=gpt-cli`, 'linux').chosen).toBeNull();
  });

  it('rejects omp-meridian on win32 (not an allowed framework there)', () => {
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=omp-meridian`, 'win32').chosen).toBeNull();
    expect(parseOnboardingQuery(`${URL_BASE}?chosen=codex`, 'win32').chosen).toBe('codex');
  });
});
