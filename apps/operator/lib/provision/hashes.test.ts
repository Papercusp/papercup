import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeConfigHash,
  computeScriptHash,
  decideReprovision,
} from './hashes';

describe('computeConfigHash', () => {
  it('produces stable hashes regardless of key order', () => {
    const a = computeConfigHash({ a: 1, b: 2 });
    const b = computeConfigHash({ b: 2, a: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when values change', () => {
    expect(computeConfigHash({ a: 1 })).not.toBe(computeConfigHash({ a: 2 }));
  });

  it('respects provisioningFields projection', () => {
    const a = computeConfigHash({ region: 'us-east-1', pollingInterval: 30 }, ['region']);
    const b = computeConfigHash({ region: 'us-east-1', pollingInterval: 60 }, ['region']);
    expect(a).toBe(b);
  });

  it('treats null and missing differently', () => {
    expect(computeConfigHash({ a: null })).not.toBe(computeConfigHash({}));
  });
});

describe('computeScriptHash', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'shash-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('hashes a script file', async () => {
    const p = join(tmpDir, 'setup.sh');
    await fs.writeFile(p, '#!/bin/bash\necho hi\n');
    const h = await computeScriptHash(p);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when content changes', async () => {
    const p1 = join(tmpDir, 's1.sh');
    const p2 = join(tmpDir, 's2.sh');
    await fs.writeFile(p1, 'echo a');
    await fs.writeFile(p2, 'echo b');
    expect(await computeScriptHash(p1)).not.toBe(await computeScriptHash(p2));
  });
});

describe('decideReprovision', () => {
  const prev = {
    configHash: 'sha256:c1',
    scriptHash: 'sha256:s1',
    pluginVersion: '1.0.0',
  };

  it('fresh when no prior state', () => {
    expect(decideReprovision(null, prev)).toBe('fresh');
  });

  it('unchanged when all three match', () => {
    expect(decideReprovision(prev, prev)).toBe('unchanged');
  });

  it('script-changed wins over config + version mismatches', () => {
    expect(
      decideReprovision(prev, {
        configHash: 'sha256:c2',
        scriptHash: 'sha256:s2',
        pluginVersion: '2.0.0',
      }),
    ).toBe('script-changed');
  });

  it('version-major when major changes', () => {
    expect(
      decideReprovision(prev, { ...prev, pluginVersion: '2.0.0' }),
    ).toBe('version-major');
  });

  it('treats minor change like version-major (safe default)', () => {
    expect(
      decideReprovision(prev, { ...prev, pluginVersion: '1.1.0' }),
    ).toBe('version-major');
  });

  it('version-patch only for patch-level differences', () => {
    expect(
      decideReprovision(prev, { ...prev, pluginVersion: '1.0.1' }),
    ).toBe('version-patch');
  });

  it('config-only when only configHash differs', () => {
    expect(
      decideReprovision(prev, { ...prev, configHash: 'sha256:c2' }),
    ).toBe('config-only');
  });
});
