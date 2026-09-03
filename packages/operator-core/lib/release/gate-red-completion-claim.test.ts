import { describe, expect, it } from 'vitest';
import {
  gateRedCompletionClaimWarning,
  looksLikeGateRedFixClaim,
} from './gate-red-completion-claim';
import type { FrozenRepairEditMarker } from './frozen-repair-edit-marker';
import type { PathContainment } from './judged-sha-containment';

const marker: FrozenRepairEditMarker = {
  candidate: 'c'.repeat(40),
  repairHead: 'r'.repeat(40),
  phase: 'repair-in-progress',
  failingPaths: ['a/failing.test.ts', 'b/failing.test.ts'],
  updatedAtMs: 1,
};

/** Containment stub: every path in `contained` is carried by the judged sha. */
const containment =
  (contained: string[]) =>
  (paths: string[]): PathContainment[] =>
    paths.map((path) => ({
      path,
      containedInJudgedSha: contained.includes(path),
      judgedBlob: contained.includes(path) ? 'same' : 'old',
      stagingBlob: 'same',
    }));

describe('looksLikeGateRedFixClaim', () => {
  it('recognises the phrasings agents actually use', () => {
    for (const summary of [
      'Fixed 7 gate reds',
      'fixed the gate-red on the checkpoint',
      'greened the gate',
      'the gate is green now',
      'cleared a green-checkpoint red',
      'fixed 3 of 10 gate reds',
    ]) {
      expect(looksLikeGateRedFixClaim({ summary }), summary).toBe(true);
    }
  });

  it('does NOT fire on ordinary closes — a nagging check gets ignored', () => {
    for (const summary of [
      'Fixed a flaky test in the sync resolver',
      'Added a red border to the settings panel',
      'Refactored the gateway client',
      'Updated the README',
    ]) {
      expect(looksLikeGateRedFixClaim({ summary }), summary).toBe(false);
    }
  });

  it('reads every evidence field, not just the summary', () => {
    expect(looksLikeGateRedFixClaim({ testResult: 'gate red cleared' })).toBe(true);
    expect(looksLikeGateRedFixClaim({ verifiedHow: 'greened the gate' })).toBe(true);
    expect(looksLikeGateRedFixClaim(undefined)).toBe(false);
  });
});

describe('gateRedCompletionClaimWarning (P-006)', () => {
  it('flags a gate-red claim whose fixes the judged sha does NOT carry', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts', 'b/failing.test.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w).toBeDefined();
    expect(w?.uncontainedPaths).toEqual(['a/failing.test.ts', 'b/failing.test.ts']);
    expect(w?.judgedSha).toBe(marker.repairHead);
    expect(w?.detail).toContain('GATE CANNOT SEE');
    expect(w?.detail).toContain("op:'admit'");
  });

  it('is SILENT when the judged sha carries every named failing path', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts', 'b/failing.test.ts'] },
      { marker, containment: containment(['a/failing.test.ts', 'b/failing.test.ts']) },
    );
    expect(w).toBeUndefined();
  });

  it('flags a PARTIAL claim — the mixed case is the one that reads as success', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts', 'b/failing.test.ts'] },
      { marker, containment: containment(['a/failing.test.ts']) },
    );
    expect(w?.uncontainedPaths).toEqual(['b/failing.test.ts']);
    expect(w?.containedPaths).toEqual(['a/failing.test.ts']);
  });

  it('is silent when nothing is frozen — an ordinary commit IS the judged lineage', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['a/failing.test.ts'] },
      { marker: null, containment: containment([]) },
    );
    expect(w).toBeUndefined();
  });

  it('is silent for a close that makes no gate claim, even with uncontained paths', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Refactored the resolver', filesChanged: ['a/failing.test.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w).toBeUndefined();
  });

  it('judges ONLY paths in the failing set — unrelated files are not this bug', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed 2 gate reds', filesChanged: ['unrelated/file.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w).toBeUndefined();
  });

  it('normalizes declared paths before matching the failing set', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed a gate red', filesChanged: ['./a/failing.test.ts'] },
      { marker, containment: containment([]) },
    );
    expect(w?.uncontainedPaths).toEqual(['a/failing.test.ts']);
  });

  it('is silent when no paths were declared — it cannot judge, so it does not guess', () => {
    expect(
      gateRedCompletionClaimWarning({ summary: 'Fixed 2 gate reds' }, { marker }),
    ).toBeUndefined();
  });

  it('fails OPEN when the containment probe throws — never blocks a close', () => {
    const w = gateRedCompletionClaimWarning(
      { summary: 'Fixed a gate red', filesChanged: ['a/failing.test.ts'] },
      {
        marker,
        containment: () => {
          throw new Error('git exploded');
        },
      },
    );
    expect(w).toBeUndefined();
  });
});
