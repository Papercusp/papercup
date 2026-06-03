/**
 * Unit coverage for the 405-Method-Not-Allowed resolver.
 * See ../method-not-allowed.ts.
 */
import { describe, it, expect } from 'vitest';
import { allowedMethodsFor } from '../method-not-allowed';
import { ALL_ROUTES } from '../routes';
import { isCatchAll } from '../register';

describe('method-not-allowed resolver', () => {
  const literals = ALL_ROUTES.filter((r) => !isCatchAll(r.path) && !r.path.includes(':'));

  it('a known literal path resolves its registered method', () => {
    const sample = literals[0];
    expect(sample, 'no literal routes registered').toBeDefined();
    expect(allowedMethodsFor(sample.path)).toContain(sample.method.toUpperCase());
  });

  it('an unknown path resolves to no methods (→ stays 404, not 405)', () => {
    expect(allowedMethodsFor('/definitely-not-a-real-route-xyz-123')).toEqual([]);
    // a single unknown segment must NOT be caught by the excluded /:transport
    // catch-all (that would be a false 405).
    expect(allowedMethodsFor('/totally-bogus')).toEqual([]);
  });

  it('a wrong verb on a known path yields a non-empty allow-set excluding it', () => {
    // find a path registered for exactly one method, then probe the others.
    const byPath = new Map<string, Set<string>>();
    for (const r of ALL_ROUTES) {
      if (isCatchAll(r.path) || r.path.includes(':')) continue;
      (byPath.get(r.path) ?? byPath.set(r.path, new Set()).get(r.path)!).add(r.method.toUpperCase());
    }
    const singleMethod = [...byPath.entries()].find(([, m]) => m.size === 1);
    expect(singleMethod, 'expected at least one single-method literal route').toBeDefined();
    const [path, methods] = singleMethod!;
    const only = [...methods][0];
    const wrong = only === 'GET' ? 'DELETE' : 'GET';
    const allowed = allowedMethodsFor(path);
    expect(allowed).toContain(only);
    expect(allowed).not.toContain(wrong); // → handler returns 405 for `wrong`
  });
});
