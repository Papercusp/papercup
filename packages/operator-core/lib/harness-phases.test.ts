/**
 * Coverage for harness-phases: phasePhaseLabel (query-string → Phase, defaulting
 * to staging) and phasePath (staging → project.path; testing/production → a
 * config.json override or the `<path>--<phase>` convention). Uses real temp
 * dirs — phasePath reads config via require('node:fs'), which a module mock
 * wouldn't intercept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phasePath, phasePhaseLabel, ALL_PHASES } from './harness-phases';

let withConfig: string; // temp project dir that HAS .papercusp/config.json
let noConfig: string; // temp project dir with no config

beforeAll(() => {
  withConfig = mkdtempSync(join(tmpdir(), 'phase-cfg-'));
  mkdirSync(join(withConfig, '.papercusp'), { recursive: true });
  writeFileSync(
    join(withConfig, '.papercusp', 'config.json'),
    JSON.stringify({ phases: { testing: { path: '/custom/testing' } } }),
  );
  noConfig = mkdtempSync(join(tmpdir(), 'phase-nocfg-'));
});
afterAll(() => {
  rmSync(withConfig, { recursive: true, force: true });
  rmSync(noConfig, { recursive: true, force: true });
});

describe('phasePhaseLabel', () => {
  it('passes through the three known phases', () => {
    expect(phasePhaseLabel('staging')).toBe('staging');
    expect(phasePhaseLabel('testing')).toBe('testing');
    expect(phasePhaseLabel('production')).toBe('production');
  });
  it('defaults unknown / undefined to staging', () => {
    expect(phasePhaseLabel(undefined)).toBe('staging');
    expect(phasePhaseLabel('garbage')).toBe('staging');
  });
  it('ALL_PHASES is the canonical triple', () => {
    expect([...ALL_PHASES].sort()).toEqual(['production', 'staging', 'testing']);
  });
});

describe('phasePath', () => {
  it('staging resolves to project.path verbatim', () => {
    expect(phasePath({ path: '/proj' }, 'staging')).toBe('/proj');
  });

  it('testing uses the config.json override when present', () => {
    expect(phasePath({ path: withConfig }, 'testing')).toBe('/custom/testing');
  });

  it('falls back to <path>--<phase> when no config override exists', () => {
    // withConfig has a testing override but NO production override → convention.
    expect(phasePath({ path: withConfig }, 'production')).toBe(`${withConfig}--production`);
    // noConfig has no config file at all → convention for any non-staging phase.
    expect(phasePath({ path: noConfig }, 'testing')).toBe(`${noConfig}--testing`);
  });
});
