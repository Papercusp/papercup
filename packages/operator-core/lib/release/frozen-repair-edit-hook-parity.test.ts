import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeRepoPath,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  frozenRepairEditWarning,
  projectFrozenRepairMarker,
  readFrozenRepairMarker,
  type FrozenRepairEditMarker,
} from './frozen-repair-edit-marker';
import { unwritablePath } from '../testing/unwritable-path';
// The installed hook is plain .mjs living outside this package on purpose (it runs detached
// from any repo). Importing it HERE is what makes the parity claim below checkable.
import {
  normalizeRepoPath as hookNormalizeRepoPath,
  warningFor as hookWarningFor,
  editedPathsFrom,
} from '../../../../apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs';

/**
 * The corpus is deliberately nastier than real input. The hook goes silent whenever its
 * normalization disagrees with the gate's, and silence is indistinguishable from "no
 * collision" — so the drift this pins would present as the hook simply never firing.
 */
const PATH_CORPUS = [
  'packages/operator-core/lib/release/x.test.ts',
  './packages/operator-core/lib/release/x.test.ts',
  '/packages/operator-core/lib/release/x.test.ts',
  '///packages/operator-core/lib/release/x.test.ts',
  'packages\\operator-core\\lib\\release\\x.test.ts',
  '  packages/operator-core/lib/release/x.test.ts  ',
  './a.ts',
  'a.ts',
  '',
  '   ',
  './/nested/./path.ts',
  'apps/operator/lib/release/green-checkpoint.ts',
];

describe('hook/gate path-normalization parity (P-004)', () => {
  it('the hook normalizes every corpus path exactly as the gate does', () => {
    for (const path of PATH_CORPUS) {
      expect(hookNormalizeRepoPath(path), `disagreement on ${JSON.stringify(path)}`).toBe(
        normalizeRepoPath(path),
      );
    }
  });

  it('is a real check — a deliberately-wrong normalizer is caught by this corpus', () => {
    // Control: without this, the parity test above could pass vacuously if the corpus
    // happened to contain nothing the two implementations treat differently.
    const wrong = (v: string) => String(v ?? '').trim(); // drops ./, /, and \ handling
    const disagreements = PATH_CORPUS.filter((p) => wrong(p) !== normalizeRepoPath(p));
    expect(disagreements.length).toBeGreaterThan(0);
  });
});

const marker: FrozenRepairEditMarker = {
  candidate: 'c'.repeat(40),
  repairHead: 'r'.repeat(40),
  phase: 'repair-in-progress',
  failingPaths: ['packages/operator-core/lib/release/x.test.ts'],
  updatedAtMs: 1,
};

describe('hook/module warning parity', () => {
  it('agrees with the TS implementation on whether to warn, across the corpus', () => {
    for (const path of PATH_CORPUS) {
      const hookWarned = hookWarningFor(marker, path) !== null;
      const tsWarned = frozenRepairEditWarning(marker, path) !== null;
      expect(hookWarned, `disagreement on ${JSON.stringify(path)}`).toBe(tsWarned);
    }
  });

  it('warns on the failing path however it is spelled', () => {
    for (const spelling of [
      'packages/operator-core/lib/release/x.test.ts',
      './packages/operator-core/lib/release/x.test.ts',
      'packages\\operator-core\\lib\\release\\x.test.ts',
    ]) {
      expect(hookWarningFor(marker, spelling)).not.toBeNull();
    }
  });

  it('stays silent on a path outside the failing set', () => {
    expect(hookWarningFor(marker, 'packages/operator-core/lib/release/other.ts')).toBeNull();
    expect(frozenRepairEditWarning(marker, 'packages/operator-core/lib/release/other.ts')).toBeNull();
  });

  it('stays silent when nothing is frozen', () => {
    expect(hookWarningFor(null, 'packages/operator-core/lib/release/x.test.ts')).toBeNull();
    expect(frozenRepairEditWarning(null, 'packages/operator-core/lib/release/x.test.ts')).toBeNull();
  });
});

describe('P-005: the message names the CONSEQUENCE and the one command', () => {
  const msg = frozenRepairEditWarning(marker, 'packages/operator-core/lib/release/x.test.ts') ?? '';

  it('leads with the outcome, not the rule', () => {
    expect(msg).toContain('WILL NOT REACH THE GATE');
  });

  it('names the sanctioned command', () => {
    expect(msg).toContain("op:'admit'");
  });

  it('does NOT lean on the prose that already failed', () => {
    // "remember freeze-and-converge" is precisely the guidance this plan exists because
    // it did not hold; the message must not fall back to restating the regime.
    expect(msg.toLowerCase()).not.toContain('remember freeze-and-converge');
  });

  it('names the judged sha so the reader can check it themselves', () => {
    expect(msg).toContain(marker.repairHead.slice(0, 12));
  });

  it('warns off the two moves that make it worse', () => {
    expect(msg).toContain('release:checkpoint-run');
    expect(msg).toContain('retire');
  });
});

describe('marker projection round-trip', () => {
  const queue = (phase: string): FrozenCandidateRepairQueue =>
    ({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase,
      failingTests: ['./a/b.test.ts', 'a/b.test.ts', 'c/d.test.ts'],
      updatedAtMs: 7,
    }) as unknown as FrozenCandidateRepairQueue;

  it('writes normalized, de-duplicated paths and reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frozen-marker-'));
    const path = join(dir, 'marker.json');
    try {
      projectFrozenRepairMarker(queue('repair-in-progress'), path);
      const read = readFrozenRepairMarker(path);
      expect(read?.failingPaths).toEqual(['a/b.test.ts', 'c/d.test.ts']);
      expect(read?.repairHead).toBe('r'.repeat(40));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the marker for a null queue, and for ready-to-test (no repair exists yet)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frozen-marker-'));
    const path = join(dir, 'marker.json');
    try {
      projectFrozenRepairMarker(queue('repair-in-progress'), path);
      expect(existsSync(path)).toBe(true);
      projectFrozenRepairMarker(queue('ready-to-test'), path);
      expect(existsSync(path)).toBe(false);

      projectFrozenRepairMarker(queue('repair-in-progress'), path);
      expect(existsSync(path)).toBe(true);
      projectFrozenRepairMarker(null, path);
      expect(existsSync(path)).toBe(false);
      expect(readFrozenRepairMarker(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on an unwritable path — a fs fault must not fail a release write', () => {
    expect(() =>
      projectFrozenRepairMarker(queue('repair-in-progress'), unwritablePath('marker.json')),
    ).not.toThrow();
  });

  it('reads a corrupt marker as absent rather than crashing the hook', () => {
    expect(readFrozenRepairMarker('/definitely/not/a/marker.json')).toBeNull();
  });
});

describe('editedPathsFrom covers the payload shapes the matcher admits', () => {
  it('reads a single-file Edit/Write payload', () => {
    expect(editedPathsFrom({ tool_input: { file_path: 'a.ts' } })).toEqual(['a.ts']);
  });

  it('reads every path of a MultiEdit payload', () => {
    expect(
      editedPathsFrom({ tool_input: { edits: [{ file_path: 'a.ts' }, { file_path: 'b.ts' }] } }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('returns nothing for a malformed payload instead of throwing', () => {
    expect(editedPathsFrom(undefined)).toEqual([]);
    expect(editedPathsFrom({})).toEqual([]);
    expect(editedPathsFrom({ tool_input: { edits: 'nope' } })).toEqual([]);
  });
});
