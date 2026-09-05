/**
 * CLAUDE.md's "is the gate judging MY code" row must keep naming the SUBJECT of
 * `judgingContainsPath` and routing the real question to `marker` (EI-20429780229915918;
 * sibling of `gate-candidate-ref.test.ts` / `executable-claims.test.ts`, same P-004 family).
 *
 * WHY THIS ROW IS PINNED. The row used to read "ONLY trust a `true`, and read
 * `missingReason` before believing a `false`" — every caution spent on the `false`, none on
 * the `true`. But the `true` is the direction that fails SILENTLY: a `true` about the wrong
 * subject is indistinguishable from a `true` about the right one. An agent monitoring a red
 * gate across wakes picks ONE stable probe path so readings are comparable, gets `true` on
 * every read about a file unrelated to its fix, and reads it as "my fix is in the candidate".
 * Measured near-miss: it would have claimed an incident two other agents were working and
 * retracted a correct workspace fact 30s after it was re-asserted.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. The first
 * control is the exact pre-fix row that produced the near-miss.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROW_PREFIX = '| is the gate judging MY code |';

/** Pure, so the rule is testable against fixtures and not only against the live file. */
export function judgeGateJudgingRow(row: string): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  // The instrument that actually answers "is MY change in the candidate".
  if (!/markerJudging|`marker`/.test(row)) {
    violations.push('row does not route to the marker instrument (`markerJudging` / `marker`)');
  }
  // The subject must be named: a containment predicate is only as meaningful as its subject.
  if (!/THE PATH YOU PASSED/i.test(row)) {
    violations.push('row does not say the verdict is about the PATH THE CALLER PASSED');
  }
  // The retired phrasing: caution spent entirely on the `false`.
  if (/ONLY trust a `true`,/.test(row)) {
    violations.push('row still carries the unqualified "ONLY trust a `true`," phrasing');
  }
  return { ok: violations.length === 0, violations };
}

/** Extract the row, refusing a silent zero-match rather than passing vacuously. */
function rowFrom(file: string): string {
  const body = readFileSync(file, 'utf8');
  const row = body.split('\n').find((l) => l.startsWith(ROW_PREFIX));
  if (!row) {
    throw new Error(
      `${file} has no "${ROW_PREFIX}" row — the pin cannot pass vacuously. If the routing ` +
        `table was restructured, update this doc-claim rather than deleting the guidance.`,
    );
  }
  return row;
}

describe('CLAUDE.md gate-judging path-subject claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the exact pre-fix row that produced the EI-20429780229915918 near-miss', () => {
      const verdict = judgeGateJudgingRow(
        '| is the gate judging MY code | `changeInCandidate.judgingContainsPath` — but ONLY ' +
          'trust a `true`, and read `missingReason` before believing a `false` (see below) | ' +
          "assuming a red is about your change — a run judging a candidate without it isn't |",
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/ONLY trust a `true`/);
      expect(verdict.violations.join('\n')).toMatch(/PATH THE CALLER PASSED/);
    });

    it('catches a row that names the subject but drops the route to `marker`', () => {
      const verdict = judgeGateJudgingRow(
        '| is the gate judging MY code | `judgingContainsPath` answers only about THE PATH ' +
          'YOU PASSED | assuming a red is about your change |',
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/marker/);
    });

    it('accepts a row carrying both the subject and the route', () => {
      const verdict = judgeGateJudgingRow(
        '| is the gate judging MY code | `changeInCandidate.markerJudging` — pass `marker`. ' +
          '`judgingContainsPath` answers only about THE PATH YOU PASSED | trusting a bare ' +
          '`true` from a probe path |',
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.violations).toEqual([]);
    });
  });

  it('CLAUDE.md names the subject and routes to the marker instrument', () => {
    const verdict = judgeGateJudgingRow(rowFrom(join(ROOT, 'CLAUDE.md')));
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('AGENTS.md — the twin projection of the same part — carries the same row', () => {
    const agents = join(ROOT, 'AGENTS.md');
    // Both files project from one doc-part, so a divergence means the projection drifted.
    if (!existsSync(agents)) return;
    const verdict = judgeGateJudgingRow(rowFrom(agents));
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
