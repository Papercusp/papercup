import { describe, it, expect } from 'vitest';
import { harnessScopeMismatch } from './work-items';

/**
 * EI-19393623437103599 — the recurrence guard for a SILENT cross-harness retarget.
 *
 * `getWorkItem(id, harness?)` does not apply `harness` to the issue-family branch, so a
 * caller can name one pot and be handed another pot's row with no signal whatsoever.
 * That is how ~3h of writes — checkpoints, a claim, and finally a terminal completion —
 * landed on a stranger's work-item on 2026-08-03: `WI-1` was minted by one store and
 * re-resolved against another, because `WI-<n>` ids come from a PER-DATABASE sequence
 * (D-008 / migration 142) that starts at 1 in every store.
 *
 * The premise these tests pin is deliberately narrow: we do NOT assert that the lookup
 * filters by harness (it must not — 56 of 77 call sites pass one, often loosely, and
 * filtering would convert a rare wrong-row into a broad silent `null`). We assert only
 * that a CONTRADICTION — caller named a harness, resolver returned a different one — is
 * detectable, so destructive writes can refuse on it.
 */
describe('harnessScopeMismatch — cross-harness retarget detection', () => {
  it('flags the live WI-1 case: asked for one harness, resolved another', () => {
    // Reproduced against the real store 2026-08-03T01:41Z:
    //   work_items:get { ids:['WI-1'], harness:'hello-world-hive' }
    //     -> returned the papercusp 2026-07-18 task, echoing harness:'papercusp'
    expect(harnessScopeMismatch({ harness: 'papercusp' }, 'hello-world-hive')).toEqual({
      requested: 'hello-world-hive',
      resolved: 'papercusp',
    });
  });

  it('is silent when the harnesses agree (the overwhelmingly common path)', () => {
    expect(harnessScopeMismatch({ harness: 'papercusp' }, 'papercusp')).toBeNull();
  });

  it('is silent when the caller named no harness — nothing was contradicted', () => {
    // A caller that supplied no scope cannot have been answered off-scope. This is what
    // keeps the guard from firing across the ~21 call sites that pass no harness at all.
    expect(harnessScopeMismatch({ harness: 'papercusp' }, undefined)).toBeNull();
    expect(harnessScopeMismatch({ harness: 'papercusp' }, null)).toBeNull();
    expect(harnessScopeMismatch({ harness: 'papercusp' }, '')).toBeNull();
  });

  it('is silent for an unscoped row — absence of a harness is not disagreement', () => {
    // Workspace-global / unhomed rows legitimately carry no harness. Treating that as a
    // contradiction would refuse writes to every one of them.
    expect(harnessScopeMismatch({ harness: null }, 'papercusp')).toBeNull();
    expect(harnessScopeMismatch({ harness: undefined }, 'papercusp')).toBeNull();
    expect(harnessScopeMismatch({ harness: '' }, 'papercusp')).toBeNull();
  });

  it('is case- and whitespace-SENSITIVE — harness slugs are exact identifiers', () => {
    // Deliberate: slugs are exact keys, not fuzzy labels. A near-miss is still a
    // different pot, and quietly normalising one would re-open the hole this closes.
    expect(harnessScopeMismatch({ harness: 'papercusp' }, 'Papercusp')).toEqual({
      requested: 'Papercusp',
      resolved: 'papercusp',
    });
  });

  it('reports BOTH sides, so a refusal can name what it actually got', () => {
    // The failure was unrecoverable-by-inspection precisely because nothing echoed the
    // row that came back. A refusal must be able to print both.
    const mismatch = harnessScopeMismatch({ harness: 'oddsmith' }, 'papercusp');
    expect(mismatch).not.toBeNull();
    expect(mismatch?.requested).toBe('papercusp');
    expect(mismatch?.resolved).toBe('oddsmith');
  });
});
