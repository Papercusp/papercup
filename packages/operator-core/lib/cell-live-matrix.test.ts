import { describe, it, expect } from 'vitest';
import {
  judgeSquare,
  assessMatrix,
  compareAb,
  KNOWN_GAPS,
  gapKey,
  MATRIX_CONDITIONS,
  type CellObservation,
} from './cell-live-matrix';

/**
 * cell-live-matrix.test.ts — the hermetic half of P-004's live read matrix
 * (agent-state-plane-verification-2026-07-27).
 *
 * ⚠ THE ACCEPTANCE TEST FOR A DETECTOR IS "DOES IT RE-DERIVE A KNOWN DEFECT", NEVER
 * "DOES IT PASS". Two live defects were hand-proven against the raw resolver on BOTH
 * :3170 and :3070 BEFORE this logic was written — WI-6484 and WI-6485 — and the first
 * two suites below feed this module their VERBATIM observed shapes and require it to
 * find them independently. Without that, a verdict function that returned 'ok' for
 * everything would pass every other test in this file.
 *
 * The corresponding anti-test matters just as much and is the third suite: the healthy
 * squares measured in the same live run must NOT be flagged. A detector that fires on
 * `consecutiveReds: 0` or a genuinely-measured `false` is noise, and noise is trained
 * away within a day — which costs exactly the case it exists for.
 */

const HOISTED = { declaresHoist: true } as const;

/* -------------------------------------------------------------------------- */
/* THE KNOWN POSITIVES — verbatim live shapes, hand-proven before this module   */
/* -------------------------------------------------------------------------- */

describe('KNOWN POSITIVE #1 — WI-6484, re-derived from the verbatim live read', () => {
  /**
   * Measured 2026-07-27 on :3170 and :3070 (identical):
   *   state:read { cell:'git.pipelinePosition', as:'does/not/exist.ts' }
   *   → { status:'value', value:false, unknownHoist:{ key:'positionsUnknown', value:[] } }
   * while dev:pipeline_position for the same path reports
   *   notes:["No commit has touched 'does/not/exist.ts' yet."], targetSha:"", blockedOn:'committed'.
   */
  const observed: CellObservation = {
    cell: 'git.pipelinePosition',
    condition: 'subject-degrades',
    status: 'value',
    value: false,
    hoist: { key: 'positionsUnknown', value: [] },
    ...HOISTED,
  };

  it('finds it — a measured-empty channel behind a headline with nothing to measure', () => {
    const sq = judgeSquare(observed);
    expect(sq.verdict).toBe('unexplained-null');
    expect(sq.detail).toContain('MEASURED SILENCE');
  });

  /**
   * ⚠ THE SUBTLE HALF, and the reason this defect survived the WI-6444 fix. The headline
   * here degrades to `false`, not to null — a perfectly ordinary-looking boolean. A
   * detector keyed on "the value is null" would report this square GREEN forever.
   */
  it('does NOT depend on the value being null — the degradation is what is unexplained', () => {
    expect(judgeSquare(observed).verdict).toBe('unexplained-null');
    expect(judgeSquare({ ...observed, value: 0 }).verdict).toBe('unexplained-null');
    expect(judgeSquare({ ...observed, value: '' }).verdict).toBe('unexplained-null');
  });

  it('is filed, so it reports as a tracked gap rather than turning the gate red', () => {
    expect(KNOWN_GAPS[gapKey('git.pipelinePosition', 'subject-degrades')]).toBe('WI-6484');
    const out = assessMatrix([observed], { openGapItems: new Set(['WI-6484']) });
    expect(out.ok).toBe(true);
    expect(out.filedGaps).toHaveLength(1);
    expect(out.failing).toHaveLength(0);
  });

  it('⚠ MUTATION — with the filed defect CLOSED, the same square turns the gate RED', () => {
    const out = assessMatrix([observed], { openGapItems: new Set<string>() });
    expect(out.ok).toBe(false);
    expect(out.staleGaps).toHaveLength(1);
    expect(out.staleGaps[0]?.knownGap).toBe('WI-6484');
  });
});

describe('KNOWN POSITIVE #2 — WI-6485, re-derived from the verbatim live read', () => {
  /**
   * Measured 2026-07-27 on :3170 and :3070 (identical):
   *   state:read { cell:'gate.greenCheckpoint.candidate', as:'CLAUDE.md' }
   *   → { status:'value', value:null, unknownHoist:{ key:'verdictUnknown', value:[] },
   *       material:{ path:'changeInCandidate.judgingContainsPath', value:null } }
   * CLAUDE.md is committed, on staging, in main AND deployed — this is the
   * "subject WITH a value" square, not a degradation.
   */
  const observed: CellObservation = {
    cell: 'gate.greenCheckpoint.candidate',
    condition: 'subject-with-value',
    status: 'value',
    value: null,
    hoist: { key: 'verdictUnknown', value: [] },
    ...HOISTED,
  };

  const resolved: CellObservation = {
    ...observed,
    declaresAssessment: true,
    assessment: {
      status: 'resolved',
      path: 'assessments.gateCandidate',
      code: 'no-active-run',
      meaning: 'No gate run is in flight — a measured absence, not a failed read.',
      safeAction: 'Nothing to wait on; fire a checkpoint run if a verdict is needed now.',
      evidence: [
        { path: 'changeInCandidate.missingReason', value: null },
        { path: 'changeInCandidate.nextCandidateSha', value: 'next-candidate-sha' },
      ],
    },
  };

  it('finds it — a real subject produced a null with the channel claiming it looked', () => {
    const sq = judgeSquare(observed);
    expect(sq.verdict).toBe('unexplained-null');
  });

  it('D-009: the same raw null is honest once the resolver assesses it as no-active-run', () => {
    const sq = judgeSquare(resolved);
    expect(sq.verdict).toBe('ok');
    expect(sq.detail).toContain('no-active-run');
  });

  it('does not let a declared assessment disappear or become unavailable behind that raw null', () => {
    expect(judgeSquare({ ...resolved, assessment: null }).verdict).toBe('assessment-missing');
    expect(
      judgeSquare({
        ...resolved,
        assessment: {
          status: 'unavailable',
          path: 'assessments.gateCandidate',
          code: null,
          meaning: null,
          safeAction: 'Re-read the full resolver before acting.',
          evidence: [],
          unknown: { code: 'not-measured', detail: 'candidate assessment was not measured' },
        },
      }).verdict,
    ).toBe('assessment-unavailable');
  });

  it('accepts an unavailable assessment for the deliberately degrading subject', () => {
    expect(
      judgeSquare({
        ...resolved,
        condition: 'subject-degrades',
        assessment: {
          status: 'unavailable',
          path: 'assessments.gateCandidate',
          code: null,
          meaning: null,
          safeAction: 'Fix the supplied subject and re-read.',
          evidence: [],
          unknown: { code: 'insufficient-data', detail: 'the supplied subject does not resolve' },
        },
      }).verdict,
    ).toBe('ok');
  });

  it('does not accept a nominally resolved assessment whose evidence drifted', () => {
    if (resolved.assessment?.status !== 'resolved') throw new Error('fixture must resolve');
    expect(
      judgeSquare({
        ...resolved,
        assessment: {
          ...resolved.assessment,
          evidence: [{ path: 'changeInCandidate.missingReason', value: undefined, drifted: true }],
        },
      }).verdict,
    ).toBe('assessment-unavailable');
  });

  it('is filed on BOTH squares it surfaces through — one defect, two reachable paths', () => {
    expect(KNOWN_GAPS[gapKey('gate.greenCheckpoint.candidate', 'subject-with-value')]).toBe('WI-6485');
    expect(KNOWN_GAPS[gapKey('gate.greenCheckpoint.candidate', 'subject-degrades')]).toBe('WI-6485');
  });

  it('⚠ MUTATION — with WI-6485 closed, the square is stale-gap and the gate is RED', () => {
    const out = assessMatrix([observed], { openGapItems: new Set(['WI-6484']) });
    expect(out.ok).toBe(false);
    expect(out.staleGaps.map((s) => s.knownGap)).toEqual(['WI-6485']);
  });
});

/* -------------------------------------------------------------------------- */
/* THE ANTI-TEST — the healthy live squares must stay quiet                     */
/* -------------------------------------------------------------------------- */

describe('the healthy squares from the SAME live run are not flagged', () => {
  /**
   * ⚠ EACH OF THESE IS A REAL MEASURED ANSWER FROM THE 2026-07-27 RUN. A detector that
   * fires on any of them is noise, and a noisy gate is one agents learn to skip.
   */
  const healthy: Array<[string, CellObservation]> = [
    [
      'gate.greenCheckpoint.verdict — a genuinely measured ZERO (consecutiveReds)',
      {
        cell: 'gate.greenCheckpoint.verdict',
        condition: 'subject-with-value',
        status: 'value',
        value: 0,
        hoist: { key: 'verdictUnknown', value: [{ leg: 'changeInCandidate.judgingSha' }] },
        ...HOISTED,
      },
    ],
    [
      'git.mainBehindStaging — a genuinely measured FALSE',
      {
        cell: 'git.mainBehindStaging',
        condition: 'subject-with-value',
        status: 'value',
        value: false,
        hoist: { key: 'verdictUnknown', value: [{ leg: 'changeInCandidate.judgingSha' }] },
        ...HOISTED,
      },
    ],
    [
      'deploy.3070.sha — a real sha',
      {
        cell: 'deploy.3070.sha',
        condition: 'subject-with-value',
        status: 'value',
        value: '42123c7841cd4a2ad86e5efb2beda80ca6117488',
        hoist: { key: 'verdictUnknown', value: [{ leg: 'changeInCandidate.judgingSha' }] },
        ...HOISTED,
      },
    ],
    [
      'git.pipelinePosition on a REAL path — deployed true, channel measured-empty',
      {
        cell: 'git.pipelinePosition',
        condition: 'subject-with-value',
        status: 'value',
        value: true,
        hoist: { key: 'positionsUnknown', value: [] },
        ...HOISTED,
      },
    ],
    [
      'agent.goal for a live holder — a real WI ref',
      {
        cell: 'agent.goal',
        condition: 'subject-with-value',
        status: 'value',
        value: 'WI-6483',
        hoist: { key: 'goalUnknown', value: null },
        ...HOISTED,
      },
    ],
    [
      'agent.goal for an unknown owner — a null EXPLAINED by a loud channel',
      {
        cell: 'agent.goal',
        condition: 'subject-degrades',
        status: 'value',
        value: null,
        hoist: { key: 'goalUnknown', value: 'nothing-held' },
        ...HOISTED,
      },
    ],
  ];

  for (const [label, obs] of healthy) {
    it(`stays quiet: ${label}`, () => {
      expect(judgeSquare(obs).verdict).toBe('ok');
    });
  }

  /**
   * ⚠ THE NARROWNESS IS LOAD-BEARING, so it gets its own assertion rather than resting
   * on the cases above. A truthiness test instead of a null test would flag the
   * measured `0` and the measured `false` — two of the six healthy squares, i.e. a
   * one-third false-positive rate on the very first run.
   */
  it('a measured 0 / false / empty-string is a VALUE, never an unexplained null', () => {
    const mk = (value: unknown): CellObservation => ({
      cell: 'x.y',
      condition: 'subject-with-value',
      status: 'value',
      value,
      hoist: { key: 'k', value: [] },
      ...HOISTED,
    });
    expect(judgeSquare(mk(0)).verdict).toBe('ok');
    expect(judgeSquare(mk(false)).verdict).toBe('ok');
    expect(judgeSquare(mk('')).verdict).toBe('ok');
    // ...and the null it IS meant to catch still is.
    expect(judgeSquare(mk(null)).verdict).toBe('unexplained-null');
  });
});

/* -------------------------------------------------------------------------- */
/* SAME SYMPTOM, OPPOSITE CAUSE — the three must never collapse                 */
/* -------------------------------------------------------------------------- */

describe('the three "no reason attached" verdicts stay DISTINCT', () => {
  const base: CellObservation = {
    cell: 'c',
    condition: 'subject-with-value',
    status: 'value',
    value: null,
    ...HOISTED,
  };

  it('hoist-missing — declared, and no unknownHoist field emitted at all (WI-6444 original)', () => {
    expect(judgeSquare({ ...base, hoist: null }).verdict).toBe('hoist-missing');
    expect(judgeSquare({ ...base, hoist: undefined }).verdict).toBe('hoist-missing');
  });

  it('hoist-drifted — the emit path RAN but the declared key was not in the result', () => {
    expect(judgeSquare({ ...base, hoist: { key: 'k', value: null, drifted: true } }).verdict).toBe(
      'hoist-drifted',
    );
  });

  it('unexplained-null — the channel emitted, claims it looked, and reports nothing', () => {
    expect(judgeSquare({ ...base, hoist: { key: 'k', value: [] } }).verdict).toBe('unexplained-null');
  });

  it('all three are reachable and mutually exclusive — collapsing any pair loses a fix', () => {
    const verdicts = new Set([
      judgeSquare({ ...base, hoist: null }).verdict,
      judgeSquare({ ...base, hoist: { key: 'k', value: null, drifted: true } }).verdict,
      judgeSquare({ ...base, hoist: { key: 'k', value: [] } }).verdict,
    ]);
    expect(verdicts.size).toBe(3);
  });

  it('a cell declaring NO hoist is not judged against one', () => {
    const noHoist: CellObservation = { ...base, declaresHoist: false, hoist: undefined, value: 'v' };
    expect(judgeSquare(noHoist).verdict).toBe('ok');
  });
});

/* -------------------------------------------------------------------------- */
/* The other two conditions                                                    */
/* -------------------------------------------------------------------------- */

describe('(c) out-of-audience — the refusal must not be usable as a probe oracle', () => {
  it('absent is the only passing answer', () => {
    expect(
      judgeSquare({ cell: 'c', condition: 'out-of-audience', status: 'absent', declaresHoist: true })
        .verdict,
    ).toBe('ok');
  });

  it('ANY other status is an oracle leak — including an "explanatory" unknown', () => {
    for (const status of ['value', 'unknown'] as const) {
      const sq = judgeSquare({
        cell: 'c',
        condition: 'out-of-audience',
        status,
        unknownCode: 'not-measured',
        declaresHoist: true,
      });
      expect(sq.verdict, `status ${status} must leak`).toBe('oracle-leak');
    }
  });
});

describe('(d) subject-missing — the caller must be told to supply the subject', () => {
  it('unknown/insufficient-data passes', () => {
    expect(
      judgeSquare({
        cell: 'c',
        condition: 'subject-missing',
        status: 'unknown',
        unknownCode: 'insufficient-data',
        declaresHoist: true,
      }).verdict,
    ).toBe('ok');
  });

  it('⚠ a VALUE is the dangerous failure — the cell answered a question never asked', () => {
    expect(
      judgeSquare({
        cell: 'c',
        condition: 'subject-missing',
        status: 'value',
        value: 'guessed',
        declaresHoist: true,
      }).verdict,
    ).toBe('wrong-status');
  });

  it('a DIFFERENT unknown code is still wrong — the lever must be "supply input"', () => {
    expect(
      judgeSquare({
        cell: 'c',
        condition: 'subject-missing',
        status: 'unknown',
        unknownCode: 'resolver-failed',
        declaresHoist: true,
      }).verdict,
    ).toBe('wrong-status');
  });
});

describe('an enumerated unknown is a COMPLETE answer, not a failure', () => {
  it('any branchable code passes on (a) and (b)', () => {
    for (const condition of ['subject-with-value', 'subject-degrades'] as const) {
      expect(
        judgeSquare({ cell: 'c', condition, status: 'unknown', unknownCode: 'not-measured', declaresHoist: true })
          .verdict,
      ).toBe('ok');
    }
  });

  it('but an unknown with NO code fails — prose cannot be branched on', () => {
    expect(
      judgeSquare({ cell: 'c', condition: 'subject-with-value', status: 'unknown', declaresHoist: true }).verdict,
    ).toBe('wrong-status');
  });

  it('an ABSENT on (a)/(b) is wrong-status — the reader should be in this audience', () => {
    expect(
      judgeSquare({ cell: 'c', condition: 'subject-with-value', status: 'absent', declaresHoist: true }).verdict,
    ).toBe('wrong-status');
  });
});

/* -------------------------------------------------------------------------- */
/* Non-vacuity + the honest headline                                           */
/* -------------------------------------------------------------------------- */

describe('⚠ NON-VACUITY — an empty run is REFUSED, never reported clean', () => {
  it('zero observations is not a clean matrix', () => {
    const out = assessMatrix([], { openGapItems: null });
    expect(out.ok).toBe(false);
    expect(out.refusal).toContain('ZERO squares');
    expect(out.headline).toContain('REFUSED');
  });

  it('a read that FAILED is unreadable — never a pass, and it reddens the run', () => {
    const out = assessMatrix(
      [
        {
          cell: 'c',
          condition: 'subject-with-value',
          status: 'value',
          declaresHoist: false,
          readError: 'ECONNREFUSED',
        },
      ],
      { openGapItems: null },
    );
    expect(out.unreadable).toHaveLength(1);
    expect(out.passed).toBe(0);
    expect(out.ok).toBe(false);
  });
});

describe('⚠ the headline does not overstate what the run established', () => {
  const clean: CellObservation = {
    cell: 'ok.cell',
    condition: 'subject-with-value',
    status: 'value',
    value: 'v',
    declaresHoist: false,
  };
  const gapped: CellObservation = {
    cell: 'git.pipelinePosition',
    condition: 'subject-degrades',
    status: 'value',
    value: false,
    hoist: { key: 'positionsUnknown', value: [] },
    ...HOISTED,
  };

  it('with NO filed gaps it may claim the matrix is clean', () => {
    const out = assessMatrix([clean], { openGapItems: null });
    expect(out.ok).toBe(true);
    expect(out.headline).toContain('no unexplained answer');
  });

  it('with a filed gap present it says so — "all honest" would be FALSE', () => {
    const out = assessMatrix([clean, gapped], { openGapItems: new Set(['WI-6484']) });
    expect(out.ok).toBe(true);
    expect(out.headline).toContain('FILED defect');
    expect(out.headline).toContain('WI-6484');
    expect(out.headline).not.toContain('no unexplained answer');
  });
});

/* -------------------------------------------------------------------------- */
/* The A/B                                                                     */
/* -------------------------------------------------------------------------- */

describe('compareAb — divergence localises the deploy boundary; agreement proves nothing', () => {
  const mk = (port: string, value: unknown): CellObservation => ({
    cell: 'git.pipelinePosition',
    condition: 'subject-with-value',
    port,
    status: 'value',
    value,
    hoist: { key: 'positionsUnknown', value: [] },
    ...HOISTED,
  });

  it('reports nothing when both operators answer the same way', () => {
    expect(compareAb([mk(':3170', true)], [mk(':3070', true)])).toEqual([]);
  });

  /**
   * ⚠ THE POINT OF THE A/B'S LIMIT, asserted rather than only documented: two operators
   * carrying the SAME defect agree perfectly. Agreement must never be read as health —
   * measured 2026-07-27, :3170 and :3070 agreed on every square including both filed ones.
   */
  it('⚠ two operators sharing a DEFECT agree — agreement is not correctness', () => {
    const defective = (port: string): CellObservation => ({
      cell: 'gate.greenCheckpoint.candidate',
      condition: 'subject-with-value',
      port,
      status: 'value',
      value: null,
      hoist: { key: 'verdictUnknown', value: [] },
      ...HOISTED,
    });
    expect(compareAb([defective(':3170')], [defective(':3070')])).toEqual([]);
    // ...while the per-square verdict still condemns both.
    expect(judgeSquare(defective(':3170')).verdict).toBe('unexplained-null');
    expect(judgeSquare(defective(':3070')).verdict).toBe('unexplained-null');
  });

  it('flags a square whose VERDICT differs across the boundary', () => {
    const div = compareAb([mk(':3170', true)], [mk(':3070', null)]);
    expect(div).toHaveLength(1);
    expect(div[0]?.left).toBe('ok');
    expect(div[0]?.right).toBe('unexplained-null');
  });

  it('flags a square observed on ONE operator only, in either direction', () => {
    expect(compareAb([mk(':3170', true)], [])).toHaveLength(1);
    expect(compareAb([], [mk(':3070', true)])).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Table hygiene                                                               */
/* -------------------------------------------------------------------------- */

describe('the KNOWN_GAPS table stays honest', () => {
  it('every key is a real (cell, condition) pair', () => {
    for (const key of Object.keys(KNOWN_GAPS)) {
      const [cell, condition] = key.split('|');
      expect(cell, `${key} has no cell`).toBeTruthy();
      expect(MATRIX_CONDITIONS, `${key} names an unknown condition`).toContain(condition);
    }
  });

  it('every value is a work-item id — a gap without a filed defect is just a hidden failure', () => {
    for (const [key, id] of Object.entries(KNOWN_GAPS)) {
      expect(id, `${key} must name a work-item`).toMatch(/^(WI|EI|F)-\d+$/);
    }
  });

  it('is NON-EMPTY — it encodes the two defects this matrix was built to re-derive', () => {
    expect(Object.keys(KNOWN_GAPS).length).toBeGreaterThan(0);
    expect(new Set(Object.values(KNOWN_GAPS))).toEqual(new Set(['WI-6484', 'WI-6485']));
  });
});
