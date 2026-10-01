import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertHostAdmission, capacityHost } from './host-admission';

describe('host-admission', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'caphost-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const scriptsIn = (withOperator: boolean) => {
    const dir = path.join(root, 'scripts', 'agent-capacity');
    mkdirSync(dir, { recursive: true });
    if (withOperator) {
      mkdirSync(path.join(root, 'packages', 'operator-core'), { recursive: true });
      writeFileSync(path.join(root, 'packages', 'operator-core', 'package.json'), '{}');
    }
    return dir;
  };

  it('refuses to start sessions inside the Papercusp tree without a pc-heavy slot', () => {
    const dir = scriptsIn(true);
    expect(capacityHost(dir)).toBe('papercusp-tree');
    expect(() => assertHostAdmission(dir, {})).toThrow(/pc-heavy/);
    expect(() => assertHostAdmission(dir, { PC_HEAVY_BYPASS: '0' })).toThrow(/without admission/);
  });

  it('admits a run inside the Papercusp tree that holds a pc-heavy slot', () => {
    expect(assertHostAdmission(scriptsIn(true), { PC_HEAVY_BYPASS: '1' })).toBe('papercusp-tree');
  });

  it('admits a ramp VM, where the scripts were copied without the operator', () => {
    expect(assertHostAdmission(scriptsIn(false), {})).toBe('dedicated');
  });

  it('classifies this checkout as the Papercusp tree', () => {
    expect(capacityHost(__dirname)).toBe('papercusp-tree');
  });
});
