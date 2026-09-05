import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REMEDIATING_KINDS,
  claimsRemediation,
  collectApplicableDeclarations,
  evaluateTerminalCriteria,
  refuseLoweringDeclaration,
  resolveTerminalCriteria,
  type ProofFloor,
  type TerminalCriteriaDeclaration,
  type TerminalCriteriaInput,
} from './terminal-criteria';

/**
 * Fixtures are the four stored closes of EI-20185455308799001, as measured in D-006 of
 * plan `machine-enforced-terminal-criteria-2026-09-05`. Three were force-reopened; one
 * survived. The evaluator must reject the three and admit the one — rejecting everything
 * would score 3/4 while being useless, which is why the over-reach control below is a
 * separate, explicit assertion rather than an afterthought.
 */

/** Closes #1 and #2: `verifiedHow: 'already-passing'`, no root cause, no files, no tests. */
const closeNoEvidence: TerminalCriteriaInput = {
  itemKind: 'bug',
  status: 'done',
  filesChanged: [],
  filesDeleted: [],
  treeStamp: null,
};

/**
 * Close #3 — the discriminating case. It named a genuine mechanism (a leaf-only resolver
 * recording `scopeUnit:null` under a managed ancestor scope) and cited the commits carrying
 * the fix, but changed nothing itself: `filesChanged` empty, `addedTests:false`. A truthful
 * causal narrative that remediates nothing must still fail.
 */
const closeNarratedCauseChangedNothing: TerminalCriteriaInput = {
  itemKind: 'bug',
  status: 'done',
  filesChanged: [],
  treeStamp: null,
};

/** The close that actually survived: three files changed, resolved against real blobs. */
const closeThatSurvived: TerminalCriteriaInput = {
  itemKind: 'bug',
  status: 'done',
  filesChanged: [
    'packages/operator-core/lib/task-manager/reconcile.ts',
    'packages/operator-core/lib/task-manager/reconcile.test.ts',
    'packages/operator-core/lib/task-manager/scope-unit.ts',
  ],
  treeStamp: {
    contentIdentity: [
      {
        path: 'packages/operator-core/lib/task-manager/reconcile.ts',
        workingTreeBlobSha: 'a'.repeat(40),
        headBlobSha: 'a'.repeat(40),
      },
      {
        path: 'packages/operator-core/lib/task-manager/reconcile.test.ts',
        workingTreeBlobSha: 'b'.repeat(40),
        headBlobSha: null,
      },
      {
        path: 'packages/operator-core/lib/task-manager/scope-unit.ts',
        workingTreeBlobSha: 'c'.repeat(40),
        headBlobSha: 'c'.repeat(40),
      },
    ],
  },
};

describe('evaluateTerminalCriteria — the D-006 replay', () => {
  it('rejects a close that declares no evidence at all', () => {
    const result = evaluateTerminalCriteria(closeNoEvidence);
    expect(result.claimsRemediation).toBe(true);
    expect(result.verdict).toBe('fail');
    expect(result.wouldBlock).toEqual(['durable-change']);
  });

  it('rejects a close that narrates a real cause but changes nothing', () => {
    const result = evaluateTerminalCriteria(closeNarratedCauseChangedNothing);
    expect(result.verdict).toBe('fail');
    expect(result.ratings['durable-change'].rating).toBe('fail');
    expect(result.ratings['durable-change'].evidence).toContain('report, not a fix');
  });

  it('ADMITS the close that survived — the gate is a filter, not a mute', () => {
    const result = evaluateTerminalCriteria(closeThatSurvived);
    expect(result.verdict).toBe('pass');
    expect(result.wouldBlock).toEqual([]);
    expect(result.ratings['durable-change'].rating).toBe('pass');
  });

  it('scores 4/4 on the stored closes rather than refusing everything', () => {
    const verdicts = [
      evaluateTerminalCriteria(closeNoEvidence).verdict,
      evaluateTerminalCriteria(closeNoEvidence).verdict,
      evaluateTerminalCriteria(closeNarratedCauseChangedNothing).verdict,
      evaluateTerminalCriteria(closeThatSurvived).verdict,
    ];
    expect(verdicts).toEqual(['fail', 'fail', 'fail', 'pass']);
  });
});

describe('the floor applies only to closes claiming remediation', () => {
  it('rates a zero-code wontfix not-applicable, never fail', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      terminalReason: 'wontfix',
      filesChanged: [],
    });
    expect(result.claimsRemediation).toBe(false);
    expect(result.ratings['durable-change'].rating).toBe('not-applicable');
    expect(result.wouldBlock).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  it.each(['wontfix', 'wont-fix', 'WONT_FIX', "won't fix", 'Wont Fix', 'NOT_REPRODUCIBLE', 'by design'])(
    'collapses the free-text disposition %j onto its canonical key',
    (terminalReason) => {
      expect(claimsRemediation({ itemKind: 'bug', status: 'DONE', terminalReason })).toBe(false);
    },
  );

  it('still treats an unrecognised disposition as remediating rather than silently excusing it', () => {
    expect(claimsRemediation({ itemKind: 'bug', status: 'done', terminalReason: 'fixed in passing' })).toBe(true);
  });

  it('leaves a task close alone — task is not a remediating kind by default', () => {
    const result = evaluateTerminalCriteria({ itemKind: 'task', status: 'done', filesChanged: [] });
    expect(result.claimsRemediation).toBe(false);
    expect(result.wouldBlock).toEqual([]);
    expect(DEFAULT_REMEDIATING_KINDS).not.toContain('task');
  });

  it('does not apply to a non-success status', () => {
    expect(claimsRemediation({ itemKind: 'bug', status: 'dropped' })).toBe(false);
  });

  it('honours a widened remediating-kind set', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'task',
      status: 'done',
      filesChanged: [],
      remediatingKinds: ['bug', 'change', 'task'],
    });
    expect(result.claimsRemediation).toBe(true);
    expect(result.verdict).toBe('fail');
  });
});

describe('a measurement failure is never charged to the closer', () => {
  it('rates an unreadable HEAD side unknown, not fail', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['packages/operator-core/lib/x.ts'],
      treeStamp: {
        contentIdentity: [
          {
            path: 'packages/operator-core/lib/x.ts',
            workingTreeBlobSha: null,
            headBlobSha: null,
            headBlobUnresolvable: 'ambiguous ref',
          },
        ],
      },
    });
    expect(result.ratings['durable-change'].rating).toBe('unknown');
    expect(result.verdict).toBe('unknown');
  });

  it('rates a missing tree stamp unknown — absence means NOT OBSERVED', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['packages/operator-core/lib/x.ts'],
      treeStamp: null,
    });
    expect(result.ratings['durable-change'].rating).toBe('unknown');
    expect(result.ratings['durable-change'].evidence).toContain('NOT OBSERVED');
  });

  it('fails a declared path that resolved to nothing and was not reported unresolvable', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['papercusp/packages/operator-core/lib/x.ts'],
      treeStamp: {
        contentIdentity: [
          { path: 'papercusp/packages/operator-core/lib/x.ts', workingTreeBlobSha: null, headBlobSha: null },
        ],
      },
    });
    expect(result.ratings['durable-change'].rating).toBe('fail');
  });
});

describe('deletions and non-code artifacts', () => {
  it('accepts a proven deletion as a durable change', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'change',
      status: 'done',
      filesDeleted: ['packages/operator-core/lib/dead.ts'],
      treeStamp: {
        contentIdentity: [
          {
            path: 'packages/operator-core/lib/dead.ts',
            workingTreeBlobSha: null,
            headBlobSha: null,
            deletion: true,
          },
        ],
      },
    });
    expect(result.verdict).toBe('pass');
  });

  it('does not count an out-of-repo evidence artifact as a code change', () => {
    const result = evaluateTerminalCriteria({
      itemKind: 'bug',
      status: 'done',
      filesChanged: ['/tmp/run.log'],
      treeStamp: {
        contentIdentity: [
          { path: '/tmp/run.log', workingTreeBlobSha: 'd'.repeat(40), outOfRepoArtifact: true },
        ],
      },
    });
    expect(result.ratings['durable-change'].rating).toBe('fail');
  });
});

/**
 * P-008 falsifiability guard.
 *
 * A guard test that has never failed is a guard nobody has tested. The control below is a
 * permanently-wrong evaluator kept IN this file — never an in-tree mutation of the real
 * module, because git-sync sweeps the whole working tree on a schedule and would commit
 * the mutant even if nothing went wrong.
 *
 * It proves the assertions above discriminate: a broken evaluator that admits everything
 * must FAIL the checks the real one passes. Without this, every assertion above would also
 * pass against an evaluator that did nothing at all.
 */
describe('falsifiability control', () => {
  const alwaysAdmits = (_input: TerminalCriteriaInput) => ({
    claimsRemediation: true,
    ratings: { 'durable-change': { rating: 'pass' as const, evidence: 'control: admits everything' } },
    wouldBlock: [] as const,
    verdict: 'pass' as const,
  });

  it('the real evaluator rejects what the always-admits control lets through', () => {
    expect(alwaysAdmits(closeNoEvidence).verdict).toBe('pass');
    expect(evaluateTerminalCriteria(closeNoEvidence).verdict).toBe('fail');

    expect(alwaysAdmits(closeNarratedCauseChangedNothing).verdict).toBe('pass');
    expect(evaluateTerminalCriteria(closeNarratedCauseChangedNothing).verdict).toBe('fail');
  });

  it('a refuse-everything control would also score 3/4 — which is why the admit case is asserted', () => {
    const alwaysRefuses = () => ({ verdict: 'fail' as const });
    expect(alwaysRefuses().verdict).toBe('fail');
    expect(evaluateTerminalCriteria(closeThatSurvived).verdict).toBe('pass');
  });
});

describe('resolveTerminalCriteria — criteria may only tighten (D-002)', () => {
  const cls: TerminalCriteriaDeclaration = {
    source: 'class',
    sourceRef: 'plan-class-bugfix',
    minProofFloor: 'l3',
    requireDurableChange: true,
    forbiddenEvidenceOnlyModes: ['already-passing'],
  };

  it('takes the max floor and the union of forbidden modes', () => {
    const resolved = resolveTerminalCriteria([
      cls,
      { source: 'item', sourceRef: 'EI-1', minProofFloor: 'l4', forbiddenEvidenceOnlyModes: ['manual'] },
    ]);
    expect(resolved.minProofFloor).toBe('l4');
    expect(resolved.requireDurableChange).toBe(true);
    expect(resolved.forbiddenEvidenceOnlyModes).toEqual(['alreadypassing', 'manual']);
    expect(resolved.sources).toEqual(['plan-class-bugfix', 'EI-1']);
  });

  it('a weakening declaration cannot pull the resolved floor down', () => {
    const resolved = resolveTerminalCriteria([
      cls,
      { source: 'item', sourceRef: 'EI-1', minProofFloor: 'none', requireDurableChange: false },
    ]);
    expect(resolved.minProofFloor).toBe('l3');
    expect(resolved.requireDurableChange).toBe(true);
  });

  it('is MONOTONIC: adding any declaration never lowers the effective floor', () => {
    const floors: ProofFloor[] = ['none', 'l3', 'l4'];
    const rank = { none: 0, l3: 1, l4: 2 } as const;
    for (const base of floors) {
      for (const added of floors) {
        const before = resolveTerminalCriteria([{ source: 'class', sourceRef: 'c', minProofFloor: base }]);
        const after = resolveTerminalCriteria([
          { source: 'class', sourceRef: 'c', minProofFloor: base },
          { source: 'item', sourceRef: 'i', minProofFloor: added },
        ]);
        expect(rank[after.minProofFloor]).toBeGreaterThanOrEqual(rank[before.minProofFloor]);
      }
    }
  });

  it('resolves an empty declaration set to the weakest floor rather than throwing', () => {
    expect(resolveTerminalCriteria([])).toMatchObject({
      minProofFloor: 'none',
      requireDurableChange: false,
      forbiddenEvidenceOnlyModes: [],
    });
  });
});

describe('refuseLoweringDeclaration — a silent drop and a typo look identical, so refuse', () => {
  const baseline = { requireDurableChange: true, minProofFloor: 'l3' as ProofFloor };

  it('refuses a floor below the baseline', () => {
    const reason = refuseLoweringDeclaration(
      { source: 'item', sourceRef: 'EI-1', minProofFloor: 'none' },
      baseline,
    );
    expect(reason).toContain('may only tighten');
  });

  it('refuses switching requireDurableChange off', () => {
    expect(
      refuseLoweringDeclaration({ source: 'item', sourceRef: 'EI-1', requireDurableChange: false }, baseline),
    ).toContain('requireDurableChange');
  });

  it('admits a tightening declaration, and an inheriting one', () => {
    expect(refuseLoweringDeclaration({ source: 'item', sourceRef: 'EI-1', minProofFloor: 'l4' }, baseline)).toBeNull();
    expect(refuseLoweringDeclaration({ source: 'item', sourceRef: 'EI-1' }, baseline)).toBeNull();
  });
});

describe('collectApplicableDeclarations — decision scope needs a plan (D-010)', () => {
  const decision: TerminalCriteriaDeclaration = { source: 'decision', sourceRef: 'some-plan#D-003', minProofFloor: 'l4' };
  const item: TerminalCriteriaDeclaration = { source: 'item', sourceRef: 'EI-1', minProofFloor: 'l3' };

  it('drops decision scope entirely when the item has no source plan', () => {
    const applicable = collectApplicableDeclarations({
      itemDeclaration: item,
      decisionDeclaration: decision,
      sourcePlanSlug: null,
    });
    expect(applicable.map((d) => d.sourceRef)).toEqual(['EI-1']);
    expect(resolveTerminalCriteria(applicable).minProofFloor).toBe('l3');
  });

  it('treats a blank slug as no plan rather than as a plan named ""', () => {
    expect(
      collectApplicableDeclarations({ decisionDeclaration: decision, sourcePlanSlug: '   ' }),
    ).toHaveLength(0);
  });

  it('applies decision scope when a source plan really exists', () => {
    const applicable = collectApplicableDeclarations({
      itemDeclaration: item,
      decisionDeclaration: decision,
      sourcePlanSlug: 'some-plan',
    });
    expect(resolveTerminalCriteria(applicable).minProofFloor).toBe('l4');
  });
});
