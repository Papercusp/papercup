import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVAL_BATTERY_SOURCE_HASHES } from './battery';
import { captureSourceHash } from './source-identity';

describe('loaded evaluator source identity', () => {
  it('captures content at module load rather than looking up a later checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-source-'));
    try {
      const path = join(dir, 'module.ts');
      writeFileSync(path, 'export const policy = 1;');
      const loaded = captureSourceHash(pathToFileURL(path).href);
      writeFileSync(path, 'export const policy = 2;');
      expect(loaded).toBe(createHash('sha256').update('export const policy = 1;').digest('hex'));
      expect(captureSourceHash(pathToFileURL(path).href)).not.toBe(loaded);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps unavailable module bytes unknown', () => {
    expect(captureSourceHash('data:text/javascript,export default 1')).toBeNull();
    expect(captureSourceHash(pathToFileURL(join(tmpdir(), 'missing-evaluator', 'module.ts')).href)).toBeNull();
  });

  it('retains each engine, judge, parser, scoring and pause boundary independently', () => {
    expect(Object.keys(EVAL_BATTERY_SOURCE_HASHES).sort()).toEqual(
      ['engine', 'judge', 'parser', 'ratePause', 'scoring', 'sourceIdentity']);
    expect(Object.isFrozen(EVAL_BATTERY_SOURCE_HASHES)).toBe(true);
    for (const value of Object.values(EVAL_BATTERY_SOURCE_HASHES)) expect(value).toMatch(/^[a-f0-9]{64}$/);
  });
});
