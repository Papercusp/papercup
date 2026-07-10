/**
 * worktree-advance.test.ts — G-7c ff-only advance DECISION core + porcelain
 * parsing, PURE (P-040 + P-036; no git). The policy pinned here: advance iff
 * ff AND dirty∩incoming=∅; never rewind; diverged/dirty are surfaced, never
 * clobbered. The git-apply half lives in worktree-advance.integration.test.ts.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/worktree-advance.test.ts
 */
import { describe, expect, it } from 'vitest';
import { type AdvanceDecisionInput, decideAdvance, parseStatusPorcelainZ } from './worktree-advance';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** A ff-eligible baseline input (local A → target B, clean tree). */
function ffInput(over: Partial<AdvanceDecisionInput> = {}): AdvanceDecisionInput {
  return {
    localHead: A,
    target: B,
    targetContainedInLocal: false,
    localContainedInTarget: true,
    dirtyPaths: [],
    incomingPaths: ['lib/f.ts'],
    ...over,
  };
}

describe('decideAdvance (G-7c pure policy)', () => {
  it('advances a clean fast-forward', () => {
    expect(decideAdvance(ffInput())).toEqual({ kind: 'advance' });
  });

  it('is a noop when already at the target (identical)', () => {
    expect(decideAdvance(ffInput({ localHead: B, target: B }))).toEqual({
      kind: 'noop',
      reason: 'identical',
    });
  });

  it('NEVER rewinds: a target already contained locally is a noop (local-ahead)', () => {
    expect(
      decideAdvance(ffInput({ targetContainedInLocal: true, localContainedInTarget: false })),
    ).toEqual({ kind: 'noop', reason: 'local-ahead' });
  });

  it('refuses a non-fast-forward target (diverged → manual)', () => {
    expect(
      decideAdvance(ffInput({ targetContainedInLocal: false, localContainedInTarget: false })),
    ).toEqual({ kind: 'diverged' });
  });

  it('defers when a dirty path overlaps the incoming change (G-7b)', () => {
    const d = decideAdvance(
      ffInput({ dirtyPaths: ['lib/f.ts', 'notes.md'], incomingPaths: ['lib/f.ts', 'lib/g.ts'] }),
    );
    expect(d).toEqual({ kind: 'deferred-dirty', overlap: ['lib/f.ts'] });
  });

  it('advances when dirty paths are disjoint from the incoming change (G-7b)', () => {
    expect(
      decideAdvance(ffInput({ dirtyPaths: ['notes.md'], incomingPaths: ['lib/f.ts'] })),
    ).toEqual({ kind: 'advance' });
  });

  it('an unborn HEAD is ff-eligible; the dirty-overlap rule alone protects the tree', () => {
    expect(
      decideAdvance(
        ffInput({ localHead: null, targetContainedInLocal: false, incomingPaths: ['f.txt'] }),
      ),
    ).toEqual({ kind: 'advance' });
    expect(
      decideAdvance(
        ffInput({
          localHead: null,
          targetContainedInLocal: false,
          dirtyPaths: ['f.txt'],
          incomingPaths: ['f.txt'],
        }),
      ),
    ).toEqual({ kind: 'deferred-dirty', overlap: ['f.txt'] });
  });

  it('dirty-overlap is checked even when the ancestry bits say ff (defense order)', () => {
    // Diverged + dirty: diverged wins (we refuse before considering dirt).
    expect(
      decideAdvance(
        ffInput({
          localContainedInTarget: false,
          dirtyPaths: ['lib/f.ts'],
          incomingPaths: ['lib/f.ts'],
        }),
      ),
    ).toEqual({ kind: 'diverged' });
  });
});

describe('parseStatusPorcelainZ', () => {
  it('parses modified / staged / untracked entries', () => {
    const raw = ' M lib/a.ts\0M  lib/b.ts\0?? new.txt\0';
    expect(parseStatusPorcelainZ(raw).sort()).toEqual(['lib/a.ts', 'lib/b.ts', 'new.txt']);
  });

  it('a rename counts BOTH sides as dirty', () => {
    const raw = 'R  renamed.ts\0original.ts\0 M other.ts\0';
    expect(parseStatusPorcelainZ(raw).sort()).toEqual(['original.ts', 'other.ts', 'renamed.ts']);
  });

  it('dedupes and survives empty input', () => {
    expect(parseStatusPorcelainZ('')).toEqual([]);
    const raw = 'MM twice.ts\0?? twice.ts\0';
    expect(parseStatusPorcelainZ(raw)).toEqual(['twice.ts']);
  });

  it('paths with spaces survive (-z is unquoted)', () => {
    const raw = ' M dir with space/a file.txt\0';
    expect(parseStatusPorcelainZ(raw)).toEqual(['dir with space/a file.txt']);
  });
});
