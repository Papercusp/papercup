import { describe, expect, it } from 'vitest';

import {
  decideAdvance,
  parseStatusPorcelainZ,
  type AdvanceDecisionInput,
} from './hive-git/worktree-advance';

function decide(input: Partial<AdvanceDecisionInput> = {}) {
  return decideAdvance({
    localHead: 'local-sha',
    target: 'target-sha',
    targetContainedInLocal: false,
    localContainedInTarget: true,
    dirtyPaths: [],
    incomingPaths: [],
    ...input,
  });
}

describe('worktree advance policy', () => {
  it('noops when the local head already equals the target', () => {
    expect(decide({ localHead: 'same', target: 'same' })).toEqual({
      kind: 'noop',
      reason: 'identical',
    });
  });

  it('noops when the local head is already ahead of the target', () => {
    expect(decide({ targetContainedInLocal: true })).toEqual({
      kind: 'noop',
      reason: 'local-ahead',
    });
  });

  it('refuses a non-fast-forward target as diverged', () => {
    expect(decide({ localContainedInTarget: false })).toEqual({
      kind: 'diverged',
    });
  });

  it('defers when dirty paths overlap the incoming paths', () => {
    expect(
      decide({
        dirtyPaths: ['a.txt', 'scratch.txt'],
        incomingPaths: ['a.txt', 'b.txt'],
      }),
    ).toEqual({
      kind: 'deferred-dirty',
      overlap: ['a.txt'],
    });
  });

  it('allows an unborn head when incoming changes are disjoint from local dirt', () => {
    expect(
      decide({
        localHead: null,
        dirtyPaths: ['notes.md'],
        incomingPaths: ['src/main.ts'],
      }),
    ).toEqual({
      kind: 'advance',
    });
  });

  it('parses porcelain -z output, including rename source+destination and dedupes paths', () => {
    const raw = [
      ' M a.txt',
      '?? scratch.txt',
      'R  renamed.txt',
      'old-name.txt',
      'R  renamed.txt',
      'old-name.txt',
      '',
    ].join('\0');

    expect(parseStatusPorcelainZ(raw)).toEqual([
      'a.txt',
      'scratch.txt',
      'renamed.txt',
      'old-name.txt',
    ]);
  });
});
