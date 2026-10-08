import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileEquityContracts, EQUITY_BUILD, EQUITY_CONTRACT_NAMES } from './compile';

describe('equity contract build', () => {
  it('pins the compiler/library and does not depend on Tokeny', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies['@openzeppelin/contracts']).toBe(EQUITY_BUILD.openzeppelin);
    expect(pkg.devDependencies.solc).toBe(EQUITY_BUILD.solc);
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(k => /tokeny|erc-3643|onchain-id/i.test(k))).toBe(false);
  });

  it('reproduces executable artifacts from pinned source', () => {
    const built = compileEquityContracts();
    const saved = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
    expect(built).toEqual(saved);
    for (const name of EQUITY_CONTRACT_NAMES) {
      expect(built.contracts[name].bytecode.length).toBeGreaterThan(100);
      expect(built.contracts[name].deployedBytecode.length / 2 - 1).toBeLessThanOrEqual(24_576);
    }
  }, 120_000);
});
