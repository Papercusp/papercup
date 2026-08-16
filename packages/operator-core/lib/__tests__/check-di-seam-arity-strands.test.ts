/**
 * EI-19448665215423873 — a DI seam whose call ARITY is narrower than the production
 * default it replaces silently makes a property untestable without failing any test.
 * Pins the fixed live instance (`inference-gateway/gateway.ts`'s `governorFor`, which
 * used to drop `accountId`) as a regression fixture: the guard must flag the pre-fix
 * shape and stay silent on the post-fix shape.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { findArityStrandsInSource } from '../../../../scripts/check-di-seam-arity-strands.mjs';

describe('findArityStrandsInSource', () => {
  it('flags a seam call that drops an identifier the default branch receives', () => {
    const src = `
      const g = deps.governorFor ? deps.governorFor(model)
                                  : governorForBackend('claude-code', model, undefined, accountId);
    `;
    const findings = findArityStrandsInSource(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].seam).toBe('deps.governorFor');
    expect(findings[0].missing).toEqual(['accountId']);
  });

  it('does NOT flag the fixed shape — the seam call now forwards every dropped identifier', () => {
    const src = `
      const g = deps.governorFor ? deps.governorFor(model, accountId)
                                  : governorForBackend('claude-code', model, undefined, accountId);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('ignores a literal `undefined` placeholder arg — it is not an in-scope value being dropped', () => {
    const src = `
      const x = deps.seam ? deps.seam(a) : real(a, undefined);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('ignores non-identifier arguments on the default branch (literals, property access)', () => {
    const src = `
      const x = deps.seam ? deps.seam(a) : real(a, 'literal', obj.prop, 42);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('does not flag when the whenFalse branch is not a call on the tested property', () => {
    const src = `
      const x = deps.seam ? somethingElse(a, b) : real(a, b, c);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });

  it('does not flag a ternary whose condition is not a property access', () => {
    const src = `
      const x = flag ? doA(a, b) : doB(a, b, c);
    `;
    expect(findArityStrandsInSource(src)).toHaveLength(0);
  });
});
