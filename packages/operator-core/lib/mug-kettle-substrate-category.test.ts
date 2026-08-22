import { describe, expect, it } from 'vitest';
// @ts-ignore -- the runtime guard helpers are intentionally exercised from an ESM script.
import { findDanglingSubstrateSymbols, substrateRemediationLines } from '../../../scripts/lib/mug-kettle-substrate.mjs';

describe('mug/kettle substrate guidance', () => {
  it('rejects a substrate symbol the wake detector cannot consult', () => {
    expect(
      findDanglingSubstrateSymbols(
        ['resolvePotHomeSlug', 'pot-git-gc'],
        ['resolvePotHomeSlug', 'recordFire'],
      ),
    ).toEqual(['pot-git-gc']);
  });

  it('keeps function-keyed advice scoped to wake findings', () => {
    expect(substrateRemediationLines([{ category: 'wake' }])).toEqual([
      "For wake/function-call findings, a genuine shared-substrate site belongs in the census's SUBSTRATE_SYMBOLS — not in this baseline.",
    ]);
  });

  it('does not tell a system-action finding to enter SUBSTRATE_SYMBOLS', () => {
    const lines = substrateRemediationLines([{ category: 'system-action' }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reviewed baseline');
    expect(lines[0]).toContain('function-name keyed');
    expect(lines[0]).not.toContain("belongs in the census's SUBSTRATE_SYMBOLS");
  });
});
