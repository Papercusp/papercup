import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { operatorMemoryStoreDir } from './memory-store-dir';

describe('operatorMemoryStoreDir', () => {
  test('uses PAPERCUSP_HOME when the process sets one', () => {
    expect(operatorMemoryStoreDir({ PAPERCUSP_HOME: '/tmp/fixture-home/.papercusp' }))
      .toBe('/tmp/fixture-home/.papercusp');
  });

  test('falls back to ~/.papercusp when PAPERCUSP_HOME is unset or blank', () => {
    const live = path.join(os.homedir(), '.papercusp');
    expect(operatorMemoryStoreDir({})).toBe(live);
    expect(operatorMemoryStoreDir({ PAPERCUSP_HOME: '  ' })).toBe(live);
  });

  test('reads the environment at call time, not at import', () => {
    const previous = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = '/tmp/set-after-import';
      expect(operatorMemoryStoreDir()).toBe('/tmp/set-after-import');
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = previous;
    }
  });
});
