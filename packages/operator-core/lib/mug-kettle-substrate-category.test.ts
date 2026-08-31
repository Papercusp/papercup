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

  it('directs filename-keyed UI substrate to SUBSTRATE_UI, never the baseline', () => {
    expect(substrateRemediationLines([{ category: 'ui', substrate: true }])).toEqual([
      "For ui findings, read the component: a live pot-named surface that does NOT offer Mug/Kettle/Cup belongs in the census's reason-carrying SUBSTRATE_UI map — not in this baseline; otherwise gate it.",
    ]);
  });

  it('keeps an ordinary ungated UI finding on the reviewed-baseline lane', () => {
    const lines = substrateRemediationLines([{ category: 'ui', substrate: false }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reviewed baseline');
    expect(lines[0]).not.toContain('SUBSTRATE_UI');
  });

  it('does not tell a system-action finding to enter SUBSTRATE_SYMBOLS', () => {
    const lines = substrateRemediationLines([{ category: 'system-action' }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reviewed baseline');
    expect(lines[0]).toContain('function-name keyed');
    expect(lines[0]).not.toContain("belongs in the census's SUBSTRATE_SYMBOLS");
  });

  it('keeps mixed finding categories on their own remediation lanes', () => {
    const lines = substrateRemediationLines([
      { category: 'wake' },
      { category: 'ui', substrate: true },
      { category: 'system-action' },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('SUBSTRATE_SYMBOLS');
    expect(lines[1]).toContain('SUBSTRATE_UI');
    expect(lines[2]).toContain('reviewed baseline');
  });
});
