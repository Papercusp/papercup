import { describe, it, expect } from 'vitest';
import { planVariantOverlay, type VariantOverlay } from '../variant-overlay';

/**
 * A variant is a prompt-override overlay (D-010); promotion writes the same
 * overlay into a dedicated harness via setPromptOverride (D-012). planVariantOverlay
 * validates the roles and produces the ordered setPromptOverride ops to apply.
 * v1 mutates prompts only (D-015) — `models` is reserved and never produces an op.
 */
describe('planVariantOverlay', () => {
  it('emits no ops for the baseline (empty overlay) — the measuring stick', () => {
    const overlay: VariantOverlay = { promptOverrides: {} };
    expect(planVariantOverlay(overlay).promptOverrideOps).toEqual([]);
  });

  it('emits one op per overridden role, with the prompt markdown', () => {
    const overlay: VariantOverlay = {
      promptOverrides: { worker: '# worker v2', validator: '# validator v2' },
    };
    const { promptOverrideOps } = planVariantOverlay(overlay);
    expect(promptOverrideOps).toEqual([
      { role: 'validator', promptMd: '# validator v2' },
      { role: 'worker', promptMd: '# worker v2' },
    ]);
  });

  it('orders ops deterministically by role regardless of input key order', () => {
    const a = planVariantOverlay({ promptOverrides: { worker: 'w', validator: 'v' } });
    const b = planVariantOverlay({ promptOverrides: { validator: 'v', worker: 'w' } });
    expect(a.promptOverrideOps).toEqual(b.promptOverrideOps);
  });

  it('rejects an unknown role — protects the frozen judge from being overlaid as a harness role', () => {
    expect(() => planVariantOverlay({ promptOverrides: { judge: 'should not exist' } })).toThrow(/judge/);
    expect(() => planVariantOverlay({ promptOverrides: { nonsense: 'x' } })).toThrow(/nonsense/);
  });

  it('allows mutating the validator (D-003 — only the external judge is frozen)', () => {
    const { promptOverrideOps } = planVariantOverlay({ promptOverrides: { validator: '# stricter' } });
    expect(promptOverrideOps).toEqual([{ role: 'validator', promptMd: '# stricter' }]);
  });

  it('does not emit prompt ops for reserved `models` mutations (D-015)', () => {
    const overlay: VariantOverlay = { promptOverrides: { worker: 'w' }, models: { worker: 'some-model' } };
    expect(planVariantOverlay(overlay).promptOverrideOps).toEqual([{ role: 'worker', promptMd: 'w' }]);
  });
});
