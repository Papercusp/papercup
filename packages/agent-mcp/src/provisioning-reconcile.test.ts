/**
 * EI-2048: provisionSystemPrincipal must bring an already-provisioned principal's
 * capabilities up to the code-defined set WITHOUT rotating its bearer — the 2026-06-20
 * operator memory + locks grant never reached the live system_principals rows because
 * provision-without-force was a pure no-op, and the only way to apply it (`force`) rotates
 * the bearer (breaking live connections). The additive-merge decision is unit-tested here
 * (the SQL wiring is exercised by the provisioning integration path).
 */
import { describe, it, expect } from 'vitest';
import { normalizeCapabilities, reconcileCapabilities } from './provisioning';

describe('reconcileCapabilities (EI-2048 additive cap reconcile)', () => {
  it('reports the code caps the stored set lacks, and the union to persist', () => {
    const { missing, merged } = reconcileCapabilities(
      ['memory:read', 'plans:read'],
      ['memory:read', 'plans:read', 'memory:write', 'locks:write'],
    );
    expect(missing).toEqual(['memory:write', 'locks:write']);
    expect(new Set(merged)).toEqual(new Set(['memory:read', 'plans:read', 'memory:write', 'locks:write']));
  });

  it('is a no-op (empty missing) when the live row already has every code cap', () => {
    const { missing } = reconcileCapabilities(['a', 'b', 'c'], ['a', 'b']);
    expect(missing).toEqual([]); // code ⊆ stored → nothing to add → caller writes nothing
  });

  it('NEVER revokes: a stored cap absent from code is preserved (shrinking is attended-only)', () => {
    // 'extra:cap' is live but not in the code set — additive reconcile keeps it.
    const { missing, merged } = reconcileCapabilities(['extra:cap', 'memory:read'], ['memory:read', 'memory:write']);
    expect(missing).toEqual(['memory:write']); // only the genuinely-missing one is added
    expect(merged).toContain('extra:cap'); // not auto-revoked
    expect(merged).toContain('memory:write');
  });

  it('handles an empty stored set (treats every code cap as missing)', () => {
    const { missing, merged } = reconcileCapabilities([], ['x', 'y']);
    expect(missing).toEqual(['x', 'y']);
    expect(merged).toEqual(['x', 'y']);
  });

  it('preserves stored order then appends the missing caps (stable, deterministic)', () => {
    const { merged } = reconcileCapabilities(['b', 'a'], ['a', 'c']);
    expect(merged).toEqual(['b', 'a', 'c']); // existing order kept; only 'c' appended
  });
});

describe('normalizeCapabilities', () => {
  it('accepts JSON-stringified arrays returned by some postgres jsonb paths', () => {
    expect(normalizeCapabilities('["memory:read","locks:write",7,null]')).toEqual([
      'memory:read',
      'locks:write',
    ]);
  });
});
