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

/**
 * WI-6554700010009519 — the guard knew ONE spelling (un-awaited `X.s ? X.s(…) : d(…)`), so the
 * live dao-hr/onboarding.ts narrowing `await (deps.adminPerson?.() ?? resolveHiringActor(key, …))`
 * (4 sites) passed unseen while its ternary twin in engagement-changes.ts was flagged. The same
 * gap hid six more strands behind `await`ed branches. Each spelling below must be caught, and the
 * three measured false-positive shapes must stay silent.
 */
describe('findArityStrandsInSource — every spelling of "seam if present, else default"', () => {
  const missingOf = (src: string) =>
    findArityStrandsInSource(src).map((f: { missing: string[] }) => [...f.missing].sort());

  it('flags the optional-call nullish form — the onboarding.ts shape', () => {
    const findings = findArityStrandsInSource(`
      const actor = await (deps.adminPerson?.() ?? resolveHiringActor(key, { sql }));
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ seam: 'deps.adminPerson', form: 'nullish', missing: ['key'] });
  });

  it('reports every identifier the nullish seam drops', () => {
    expect(missingOf(`const x = deps.x?.() ?? dflt(a, b);`)).toEqual([['a', 'b']]);
  });

  it('flags the optional-call || form', () => {
    const findings = findArityStrandsInSource(`const x = deps.x?.(a) || dflt(a, b);`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ form: 'or', missing: ['b'] });
  });

  it('looks through await on both ternary branches', () => {
    expect(missingOf(`const t = deps.hasToolchain ? await deps.hasToolchain() : await probe(sourceRoot);`)).toEqual([
      ['sourceRoot'],
    ]);
  });

  it.each([
    ['!= null', `deps.x != null ? deps.x(a) : dflt(a, b)`],
    ['!== undefined', `deps.x !== undefined ? deps.x(a) : dflt(a, b)`],
    ['reversed operands', `undefined !== deps.x ? deps.x(a) : dflt(a, b)`],
    ["typeof === 'function'", `typeof deps.x === 'function' ? deps.x(a) : dflt(a, b)`],
    ['negated: !X.s', `!deps.x ? dflt(a, b) : deps.x(a)`],
    ['negated: === undefined', `deps.x === undefined ? dflt(a, b) : deps.x(a)`],
    ["negated: typeof !== 'function'", `typeof deps.x !== 'function' ? dflt(a, b) : deps.x(a)`],
  ])('recognises the %s condition and picks the seam branch from it', (_label, expr) => {
    expect(missingOf(`const v = ${expr};`)).toEqual([['b']]);
  });

  it('stays silent on the fixed onboarding shape — the seam forwards key', () => {
    expect(findArityStrandsInSource(`const a = await (deps.adminPerson?.(key) ?? resolveHiringActor(key, { sql }));`)).toEqual(
      [],
    );
  });

  it('does not treat a NON-optional call as a seam (`map.get(k) ?? build(k, ctx)` is a plain fallback)', () => {
    expect(findArityStrandsInSource(`const v = cache.get(k) ?? build(k, ctx);`)).toEqual([]);
  });

  it('does not flag `(deps.x ?? dflt)(…)` — both receive identical arguments by construction', () => {
    expect(findArityStrandsInSource(`const v = (deps.x ?? dflt)(a, b);`)).toEqual([]);
  });

  it("does not count the seam's own receiver as dropped, but still reports anything else", () => {
    expect(findArityStrandsInSource(`const m = opts.read ? await opts.read() : await dflt(opts);`)).toEqual([]);
    expect(missingOf(`const m = opts.read ? await opts.read() : await dflt(opts, ws);`)).toEqual([['ws']]);
  });

  it('does not flag a transaction wrapper that delegates to the default', () => {
    const src = `
      const a = typeof sql.begin === 'function' ? await sql.begin(run) : await run(sql);
      const b = typeof tx.savepoint === 'function' ? await tx.savepoint((sp) => run(sp)) : await run(tx);
      const c = typeof t.savepoint === 'function' ? await t.savepoint((x) => run(x as unknown as Sql)) : await run(sql);
    `;
    expect(findArityStrandsInSource(src)).toEqual([]);
  });

  it('does not flag two members of ONE receiver — the arities are its interface contract', () => {
    expect(findArityStrandsInSource(`const p = () => source.peek?.() ?? source.active(keyOf);`)).toEqual([]);
  });
});
