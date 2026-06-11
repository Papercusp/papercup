/**
 * Cupboard base-URL resolution (relocated with the module from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCupboardBaseUrl } from './base-url';

const ORIGINAL_ENV = process.env.PAPERCUSP_CUPBOARD_URL;
beforeEach(() => { delete process.env.PAPERCUSP_CUPBOARD_URL; });
afterEach(() => {
  if (ORIGINAL_ENV !== undefined) process.env.PAPERCUSP_CUPBOARD_URL = ORIGINAL_ENV;
  else delete process.env.PAPERCUSP_CUPBOARD_URL;
});

describe('resolveCupboardBaseUrl', () => {
  it('defaults to the canonical host when no env var', () => {
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.papercusp.com');
  });

  it('uses PAPERCUSP_CUPBOARD_URL when set', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.example.com';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.example.com');
  });

  it('strips trailing slashes', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = 'https://cupboard.example.com/';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.example.com');
  });

  it('falls back to default on blank env var', () => {
    process.env.PAPERCUSP_CUPBOARD_URL = '   ';
    expect(resolveCupboardBaseUrl()).toBe('https://cupboard.papercusp.com');
  });
});
