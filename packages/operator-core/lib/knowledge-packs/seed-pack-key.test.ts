/**
 * resolveSeedPackKey — the `learning.pack` → `knowledge.pack` read precedence
 * (cupboard-public-release-2026-07-12 P-001).
 *
 * The case worth pinning is the CONFLICT: a pre-rename blueprint that extends a
 * first-party base and overrides the seed pack resolves with BOTH keys set, and
 * a naive `knowledge ?? learning` would silently seed the BASE's pack instead of
 * the one the author asked for.
 */
import { describe, it, expect } from 'vitest';
import { resolveSeedPackKey } from './seed-pack-key';

describe('resolveSeedPackKey (P-001 rename compat)', () => {
  it('prefers the canonical knowledge.pack', () => {
    expect(resolveSeedPackKey({ knowledge: { pack: 'coding' } })).toEqual({
      packId: 'coding',
      deprecatedKey: false,
    });
  });

  it('falls back to the deprecated learning.pack (a pre-rename blueprint)', () => {
    expect(resolveSeedPackKey({ learning: { pack: 'my-pack' } })).toEqual({
      packId: 'my-pack',
      deprecatedKey: true,
    });
  });

  it('a LEGACY override beats the base\'s INHERITED knowledge.pack — the wrong-pack regression', () => {
    // A pre-rename blueprint that extends `coding` and overrides the seed pack:
    // the merge carries knowledge.pack='coding' (inherited) AND learning.pack=
    // 'my-pack' (the author's own line). The author must win.
    const r = resolveSeedPackKey({ knowledge: { pack: 'coding' }, learning: { pack: 'my-pack' } });
    expect(r.packId).toBe('my-pack');
    expect(r.deprecatedKey).toBe(true);
    expect(r.conflict).toEqual({ knowledge: 'coding', learning: 'my-pack' });
  });

  it('agreeing keys are not a conflict (a copied-forward blueprint)', () => {
    const r = resolveSeedPackKey({ knowledge: { pack: 'coding' }, learning: { pack: 'coding' } });
    expect(r).toEqual({ packId: 'coding', deprecatedKey: false });
  });

  it('declares no pack ⇒ no packId (caller applies the global default)', () => {
    expect(resolveSeedPackKey({}).packId).toBeUndefined();
    expect(resolveSeedPackKey(null).packId).toBeUndefined();
    expect(resolveSeedPackKey({ knowledge: {}, learning: {} }).packId).toBeUndefined();
  });

  it('treats a blank/whitespace pack as undeclared', () => {
    expect(resolveSeedPackKey({ knowledge: { pack: '   ' } }).packId).toBeUndefined();
    expect(resolveSeedPackKey({ knowledge: { pack: '  ' }, learning: { pack: 'x' } })).toEqual({
      packId: 'x',
      deprecatedKey: true,
    });
  });
});
