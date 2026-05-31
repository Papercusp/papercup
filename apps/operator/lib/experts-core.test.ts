/**
 * Coverage for experts-core's pure/config helpers: the EXPERT_ID / FEEDBACK_ID
 * id patterns, and readExpertCaps (per-featureSize default agent/round caps with
 * a per-harness config.json override + invalid-value fallback). Real temp
 * config; PG/fs-backed expert functions are out of scope here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPERT_ID_RE, FEEDBACK_ID_RE, readExpertCaps } from './experts-core';

describe('id patterns', () => {
  it('EXPERT_ID_RE matches EXP-<3+ digits>', () => {
    expect(EXPERT_ID_RE.test('EXP-001')).toBe(true);
    expect(EXPERT_ID_RE.test('EXP-1234')).toBe(true);
    expect(EXPERT_ID_RE.test('EXP-12')).toBe(false); // needs >= 3 digits
    expect(EXPERT_ID_RE.test('exp-001')).toBe(false);
    expect(EXPERT_ID_RE.test('FB-001')).toBe(false);
  });
  it('FEEDBACK_ID_RE matches FB-<3+ digits>', () => {
    expect(FEEDBACK_ID_RE.test('FB-001')).toBe(true);
    expect(FEEDBACK_ID_RE.test('FB-9')).toBe(false);
    expect(FEEDBACK_ID_RE.test('EXP-001')).toBe(false);
  });
});

describe('readExpertCaps', () => {
  let dir: string;
  let configPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'experts-'));
    mkdirSync(join(dir, '.harness'), { recursive: true });
    configPath = join(dir, '.harness', 'config.json');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const writeConfig = (o: unknown) => writeFileSync(configPath, JSON.stringify(o));

  it('returns per-featureSize defaults when there is no config', () => {
    rmSync(configPath, { force: true });
    expect(readExpertCaps(dir, { featureSize: 'small' })).toEqual({ maxAgents: 2, maxRounds: 1 });
    expect(readExpertCaps(dir, { featureSize: 'standard' })).toEqual({ maxAgents: 4, maxRounds: 3 });
    expect(readExpertCaps(dir, { featureSize: 'large' })).toEqual({ maxAgents: 10, maxRounds: 5 });
  });

  it('defaults an absent featureSize to standard', () => {
    rmSync(configPath, { force: true });
    expect(readExpertCaps(dir, {} as never)).toEqual({ maxAgents: 4, maxRounds: 3 });
  });

  it('applies a config.json override', () => {
    writeConfig({ expert: { maxAgents: 7, maxRounds: 9 } });
    expect(readExpertCaps(dir, { featureSize: 'standard' })).toEqual({ maxAgents: 7, maxRounds: 9 });
  });

  it('falls back to the size default for a partial / invalid override', () => {
    writeConfig({ expert: { maxAgents: 7 } }); // maxRounds absent
    expect(readExpertCaps(dir, { featureSize: 'standard' })).toEqual({ maxAgents: 7, maxRounds: 3 });
    writeConfig({ expert: { maxAgents: 0, maxRounds: 'x' } }); // both invalid
    expect(readExpertCaps(dir, { featureSize: 'standard' })).toEqual({ maxAgents: 4, maxRounds: 3 });
  });
});
