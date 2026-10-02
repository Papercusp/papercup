import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import {
  neutralizePlanIdentifiers,
  stagingFirstActivationProblems,
  stagingFirstBlockerProblem,
} from './staging-first-activation-guard';

const plan = (items: string[], decisions = '', context = '') =>
  parsePlan(`---
title: Guard fixture
slug: guard-fixture
status: draft
created: 2026-08-27
updated: 2026-08-27
owner: test
---

${context}

## Items

${items.join('\n')}

## Decisions

${decisions}
`);

describe('staging-first activation guard', () => {
  it.each(['deployment ownership', 'deployment configuration', 'deployment topology', 'deployment source'])(
    'allows a source prerequisite that inventories %s',
    (metadata) => {
      const parsed = plan([
        `- **P-001** \`todo\` Inventory canonical source, ${metadata}, and current test evidence.`,
        '- **P-002** `todo` Add tenant-bound call routing and run integration tests on current-build. blocked-by: P-001',
      ]);
      expect(stagingFirstActivationProblems(parsed)).toEqual([]);
    },
  );

  it.each(['main promotion', 'the deployed host', 'green-checkpoint'])(
    'retains a genuine %s prerequisite alongside deployment metadata',
    (releasePlane) => {
      const parsed = plan([
        `- **P-001** \`todo\` Inventory deployment ownership, then verify ${releasePlane}.`,
        '- **P-002** `todo` Add tenant-bound call routing and run integration tests on current-build. blocked-by: P-001',
      ]);
      expect(stagingFirstActivationProblems(parsed)).toEqual([
        expect.objectContaining({ itemId: 'P-002', code: 'non_final_deployed_main_wait' }),
      ]);
    },
  );

  it.each(['Prepare', 'Configure', 'Inventory'])(
    'allows %s of a self-hosted media deployment as a source prerequisite',
    (action) => {
      const parsed = plan([
        `- **P-001** \`todo\` ${action} public TLS and TURN for the self-hosted media deployment.`,
        '- **P-002** `todo` Implement current-build recovery tests and alerts. blocked-by: P-001',
      ]);
      expect(stagingFirstActivationProblems(parsed)).toEqual([]);
    },
  );

  it.each(['main promotion', 'final deployment', ':3070'])(
    'still rejects preparation explicitly gated on %s',
    (releasePlane) => {
      const parsed = plan([
        `- **P-001** \`todo\` Prepare the deployment after ${releasePlane}.`,
        '- **P-002** `todo` Implement current-build recovery tests and alerts. blocked-by: P-001',
      ]);
      expect(stagingFirstActivationProblems(parsed)).toEqual([
        expect.objectContaining({ itemId: 'P-002', code: 'non_final_deployed_main_wait' }),
      ]);
    },
  );

  it('rejects a direct release-plane blocker on ordinary implementation work', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'EI-1',
        itemText: 'Implement fact-plane fairness and verify it on staging.',
        blockerText: 'gate.greenCheckpoint.ownership\nwait for main to turn green before continuing implementation',
        kind: 'gate',
      }),
    ).toEqual(
      expect.objectContaining({
        itemId: 'EI-1',
        code: 'non_final_deployed_main_blocker',
      }),
    );
  });

  it('allows the live gate-repair item to use a release-plane blocker', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-212675',
        itemText: '[gate-red-streak] Re-green current green-checkpoint and restore tested/deployed parity.',
        blockerText: 'gate.greenCheckpoint.ownership\nwait for the scheduled checkpoint verdict',
        kind: 'gate',
      }),
    ).toBeNull();
  });

  it('refuses to park a mixed source-and-deployed item behind a narrow deployed-only blocker', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-2',
        itemText: 'Implement restart continuity and verify on staging.',
        blockerText:
          'wait for main deployment before the deployed-only restart continuity check because staging cannot exercise the deployed-host supervisor restart',
        kind: 'gate',
      }),
    ).toEqual(expect.objectContaining({
      code: 'non_final_deployed_main_blocker',
      detail: expect.stringContaining('Split the source work'),
    }));
  });

  it('allows a final-only item to wait for a genuinely deployed-only check', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-2-final',
        itemText: 'Verify supervisor restart continuity on the deployed host.\nImplementation is done on staging.',
        blockerText:
          'wait for main deployment before the deployed-only restart continuity check because staging cannot exercise the deployed-host supervisor restart',
        kind: 'gate',
      }),
    ).toBeNull();
  });

  it('diagnoses exactly which narrow-exception predicate is missing in the refusal detail', () => {
    // EI-22058383186105579: the caller supplied the full SUBSTANCE of a deployed-only
    // wait (staging limitation + concrete reason) but not the literal 'deployed-only'
    // token, and the generic refusal gave no way to see which predicate failed.
    const problem = stagingFirstBlockerProblem({
      itemId: 'WI-4',
      itemText: 'Retire legacy resource-governor receipts.',
      blockerText:
        'wait for main deployment before destructive legacy cleanup because staging cannot exercise independently deployed writer vintages',
      kind: 'runtime',
    });
    expect(problem).toEqual(expect.objectContaining({ code: 'non_final_deployed_main_blocker' }));
    expect(problem!.detail).toContain(`'deployed-only' token: MISSING`);
    expect(problem!.detail).toContain('staging limitation: present');
    expect(problem!.detail).toContain('concrete reason: present');
  });

  it('flags every missing narrow-exception predicate when none are supplied', () => {
    const problem = stagingFirstBlockerProblem({
      itemId: 'WI-5',
      itemText: 'Implement fact-plane fairness.',
      blockerText: 'wait for main to go green before continuing implementation',
      kind: 'gate',
    });
    expect(problem).toEqual(expect.objectContaining({ code: 'non_final_deployed_main_blocker' }));
    expect(problem!.detail).toContain(`'deployed-only' token: MISSING`);
    expect(problem!.detail).toContain('staging limitation: MISSING');
    expect(problem!.detail).toContain('concrete reason: MISSING');
  });

  // WI-2141652: a blocker in a domain unrelated to the release plane was refused
  // BECAUSE its evidence disclaimed being a deployed-main wait. DEPLOYED_ENV_RE and
  // STRONG_GATE_RE both match inside the disclaimer clause, and the appositive
  // "NOT a <X> wait" form was the one negation shape the exemption did not cover.
  it('does not read an unrelated-domain blocker as a deployed-main wait because its disclaimer names deployment', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-3133',
        itemText: 'Continuous Mac desktop E2E testing — repeatable battery + regression runs.',
        blockerText:
          'Peer su-0300ecfc holds physical Mac VM rig custody, so VM sidecar restarts are paused. ' +
          'This is a physical-hardware custody wait between two agents, NOT a wait on main/:3070/green-checkpoint.',
        kind: 'event',
      }),
    ).toBeNull();
  });

  // Containment for the above: the exemption is CLAUSE-scoped, so a disclaimer in its
  // own sentence must never launder a genuine deployed-main park in a different clause.
  it('still refuses a real deployed-main park when the disclaimer sits in its own clause', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-2141652-a',
        itemText: 'Implement fact-plane fairness.',
        blockerText: 'Blocked until the fix is deployed to main. This is not a deployment wait.',
        kind: 'event',
      }),
    ).toEqual(expect.objectContaining({ code: 'non_final_deployed_main_blocker' }));
  });

  // The appositive alternative was generalised from a literal 'not a prerequisite';
  // pin that the original phrasing it replaced is still exempted.
  it('keeps exempting the original appositive "not a prerequisite" phrasing', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-2141652-b',
        itemText: 'Implement fact-plane fairness.',
        blockerText: 'Deployment to main is not a prerequisite for this item.',
        kind: 'event',
      }),
    ).toBeNull();
  });

  // EI-24018845641231261: the exact refused call. A kind:'gate' blocker on a plan
  // DECISION was classified as a deployed-main wait only because the plan slug
  // contains the word `release` (hyphens are word boundaries).
  it('does not read a release word inside a plan slug as a deployed-main wait', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'EI-21150671414510762',
        itemText: '[own-log-fork-guard] own_log_forked: harness=hello-world-3-pot log=f417b935',
        blockerText:
          'p2p-public-release-endgame-2026-09-01#D-047\n' +
          'dev:own_log_fork_recover on the Mac VM operator (dry, then confirm+keyHex), then 15-min verification',
        kind: 'gate',
      }),
    ).toBeNull();
    for (const ref of [
      'gate:plan-lane:p2p-public-release-endgame-2026-09-01#P-203',
      'plan:deploy-pipeline-hardening-2026-09-01',
      'main-bundle-split-2026-09-01#D-003',
    ]) {
      expect(stagingFirstBlockerProblem({ itemId: 'EI-x', itemText: 'Implement X.', blockerText: ref, kind: 'gate' })).toBeNull();
    }
  });

  // Containment: the slug is blanked, not the blocker. A real release wait in the
  // same blocker text is still refused.
  it('still refuses a real release-plane wait that sits beside a plan-anchored ref', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'EI-y',
        itemText: 'Implement fact-plane fairness.',
        blockerText: 'p2p-public-release-endgame-2026-09-01#D-047\nwait for main to turn green before continuing implementation',
        kind: 'gate',
      }),
    ).toEqual(expect.objectContaining({ code: 'non_final_deployed_main_blocker' }));
  });

  it('neutralizes only the plan identifier and keeps the anchor', () => {
    expect(neutralizePlanIdentifiers('gate:plan-lane:p2p-public-release-endgame-2026-09-01#P-203')).toBe(
      'gate:plan-lane:<plan>#P-203',
    );
    expect(neutralizePlanIdentifiers('p2p-public-release-endgame-2026-09-01#D-047 then deploy to main')).toBe(
      '<plan>#D-047 then deploy to main',
    );
    expect(neutralizePlanIdentifiers('gate.greenCheckpoint.ownership')).toBe('gate.greenCheckpoint.ownership');
  });

  // EI-24018845641231261: the refusal tells the caller to NAME the deployed-only
  // property, and callers write that in the blocker summary/evidence. The exception
  // must read those fields; classification must still ignore them.
  it('honours the narrow exception when its three predicates are in the blocker summary/evidence', () => {
    const base = {
      itemId: 'WI-6',
        itemText: 'Verify live forked Corestore recovery.',
      blockerText: 'gate.greenCheckpoint.ownership\nwait for main to turn green before the check',
      kind: 'gate',
    };
    expect(
      stagingFirstBlockerProblem({
        ...base,
        exceptionText:
          'deployed-only property: the live forked Corestore on the Mac VM disk. staging and current-build ' +
          'cannot exercise it because the fork is physical on-disk state of that one deployed host.',
      }),
    ).toBeNull();
    const refused = stagingFirstBlockerProblem({ ...base, exceptionText: 'The peer grading pass is pending.' });
    expect(refused).toEqual(expect.objectContaining({ code: 'non_final_deployed_main_blocker' }));
    expect(refused!.detail).toContain('the submitted blocker fields (ref, nextVerb, summary, evidence)');
    expect(refused!.detail).toContain(`'deployed-only' token: MISSING`);
  });

  it('never classifies a blocker as a deployed-main wait from its summary/evidence alone', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-7',
        itemText: 'Record a peer grading dependency.',
        blockerText: 'work-item:done:WI-10001764\nevents:await',
        exceptionText: 'Wait for main to turn green. Verified on :3170; deployed :3070 misreports this field.',
        kind: 'gate',
      }),
    ).toBeNull();
  });

  it('ignores unrelated runtime blockers even when the item is ordinary implementation', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-3',
        itemText: 'Implement fact-plane fairness.',
        blockerText: 'staging-api:down\nwait for the local runtime to recover',
        kind: 'runtime',
      }),
    ).toBeNull();
  });

  it.each([
    '- **P-001** `todo` Wait for main to be green before continuing implementation.',
    '- **P-001** `todo` Block this item on :3070 before marking it done.',
    '- **P-001** `todo` Green-checkpoint is a prerequisite for closing this implementation item.',
    '- **P-001** `todo` Deployment is required before continuing implementation.',
  ])('rejects a non-final release-plane gate: %s', (item) => {
    expect(stagingFirstActivationProblems(plan([item]))).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it('does not mistake a legal precondition for a deployment-model wait', () => {
    const parsed = plan([
      "- **P-016** `todo` GATE: a legal read of Slack's 2025 API terms for this deployment model must be on record before this ships.",
    ]);
    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it.each(['done', 'dropped'])('does not re-report a terminal %s item', (status) => {
    expect(
      stagingFirstActivationProblems(
        plan([`- **P-001** \`${status}\` Wait for main to be green before continuing implementation.`]),
      ),
    ).toEqual([]);
  });

  it('does not skip a blocked item whose hosted acceptance still waits on deployment', () => {
    expect(
      stagingFirstActivationProblems(
        plan(['- **P-029** `blocked` Hosted transport acceptance requires deployment before continuing validation.']),
      ),
    ).toEqual([expect.objectContaining({ itemId: 'P-029', code: 'non_final_deployed_main_wait' })]);
  });

  it.each([
    '- **P-001** `todo` Run focused verification on staging, then continue implementation.',
    '- **P-001** `todo` Final shipment verification waits for green main and :3070.',
    '- **P-001** `todo` Verify rollback packaging on deployed main before final release.',
    '- **P-001** `todo` Validate migration ordering between staging and the deployed host before final shipment.',
  ])('preserves staging work and final lifecycle checks: %s', (item) => {
    expect(stagingFirstActivationProblems(plan([item]))).toEqual([]);
  });

  it('accepts an item-local deployed-only exception with a concrete staging limitation', () => {
    const parsed = plan([
      '- **P-001** `todo` Wait for :3070 before closing the deployed-only restart continuity check because staging cannot exercise the deployed-host supervisor restart.',
    ]);
    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('accepts the same narrow exception from a linked decision', () => {
    const parsed = plan(
      ['- **P-001** `todo` Wait for :3070 before closing the restart continuity check.'],
      `### D-001 — Deployed-only restart continuity\nDate: 2026-08-27\nP-001 is deployed-only because staging cannot exercise the deployed-host supervisor restart.\nRelated: P-001`,
    );
    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('rejects a release dependency on a mixed source-and-deployed item despite a narrow exception', () => {
    const parsed = plan(
      [
        '- **P-001** `todo` Verify the green pin, main promotion, and deployed host.',
        '- **P-002** `blocked` Add and run lifecycle regression tests; verify deployed runtime parity. blocked-by: P-001',
      ],
      `### D-001 — Deployed-only parity\nDate: 2026-08-27\nP-002 final parity is deployed-only because staging cannot observe the deployed-host revision.\nRelated: P-002`,
    );
    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({
        itemId: 'P-002',
        code: 'non_final_deployed_main_wait',
        detail: expect.stringContaining('Split the obligations'),
      }),
    ]);
  });

  it.each(['done', 'dropped'])('does not treat a %s release-plane blocker as a wait', (status) => {
    const parsed = plan([
      `- **P-001** \`${status}\` Verify the green pin, main promotion, and deployed host.`,
      '- **P-002** `todo` Build the arm switch and run the matched trials. blocked-by: P-001',
    ]);
    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('still rejects the same dependency while the release-plane blocker is open', () => {
    const parsed = plan([
      '- **P-001** `todo` Verify the green pin, main promotion, and deployed host.',
      '- **P-002** `todo` Build the arm switch and run the matched trials. blocked-by: P-001',
    ]);
    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({ itemId: 'P-002', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it.each(['whichever build', 'the current build', 'a green build', 'the release build'])(
    'reads "%s" as the artifact under test, not source work',
    (phrase) => {
      const parsed = plan([
        '- **P-001** `todo` Verify the green pin, main promotion, and deployed host.',
        `- **P-002** \`todo\` Run the matched trials on ${phrase} that carries the arm switch. blocked-by: P-001`,
      ]);
      expect(stagingFirstActivationProblems(parsed)).toEqual([]);
    },
  );

  it('rejects a strong main wait carried only by a decision linked from the item', () => {
    const parsed = plan(
      ['- **P-001** `todo` Continue implementing the interactive client under D-001.'],
      `### D-001 — Main gate before continuation\nDate: 2026-08-27\nWait for green main before P-001 can continue implementation.\nRelated: P-001`,
    );
    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it("does not attribute another item's Now gate to an incidentally mentioned item", () => {
    const parsed = plan(
      ['- **P-001** `todo` Implement the interactive client on staging.'],
      '',
      `## Now\n\n**State:** P-001 is ready; P-002 is blocked until green-checkpoint before continuing implementation.`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('does not treat an explicit without-waiting phrase as a release-plane gate', () => {
    const parsed = plan(
      ['- **P-015** `todo` Migrate provider calls using staging/current-build.'],
      '',
      `## Now\n\n**Next:** Advance P-015/P-016 without waiting on green main.`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('does not treat an explicit instead-of-waiting phrase as a release-plane gate', () => {
    const parsed = plan(
      ['- **P-004** `todo` Validate the item-open rail using staging/current-build.'],
      `### D-003 — P-004 acceptance proceeds on staging/current-build
Date: 2026-09-07
Continue P-004 against staging instead of waiting for green main.
Related: P-004`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it("does not attribute another item's decision clause through a textual reference", () => {
    const parsed = plan(
      ['- **P-001** `todo` Implement the interactive client on staging.'],
      `### D-001 — Mixed status\nDate: 2026-08-27\nP-001 uses current-build acceptance; P-002 must wait for main before continuing implementation.`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('retains an anaphoric follow-up that clearly gates the referenced item', () => {
    const parsed = plan(
      ['- **P-001** `todo` Implement the interactive client on staging.'],
      '',
      `## Now\n\n**State:** P-001 is the active implementation item. It must wait for main before continuing implementation.`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it.each([
    [
      'Now',
      `## Now\n\n**State:** P-001 is blocked until green-checkpoint.\n\n**Next:** Wait for main before continuing P-001 implementation.`,
    ],
    ['Validation', `## Validation\n\n- P-001 cannot close until :3070 serves the implementation.`],
  ])('rejects a strong main wait in a %s clause that names the item', (_label, context) => {
    const parsed = plan(['- **P-001** `todo` Implement the interactive client on staging.'], '', context);
    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it('does not treat a policy decision that rejects main waits as imposing one', () => {
    const parsed = plan(
      ['- **P-001** `todo` Add the staging-first activation guard under D-001.'],
      `### D-001 — Reject non-final main waits\nDate: 2026-08-27\nThe activation audit rejects text that makes main or :3070 a prerequisite for non-final implementation.\nRelated: P-001`,
    );
    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('does not treat explicit no-prerequisite decisions as release-plane gates', () => {
    const parsed = plan(
      ['- **P-001** `todo` Exercise the acceptance matrix on staging/current-build.'],
      `### D-001 — Staging-first acceptance
Date: 2026-08-27
P-001 has NO deployed-main prerequisite for non-final acceptance.
Deployed-main verification is never a prerequisite for closing P-001.
D-004 excluded deployed-main as a closure prerequisite for P-001.
Related: P-001`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('does not read a descriptive serving block as blocked work', () => {
    const parsed = plan(
      ['- **P-001** `todo` Exercise the acceptance matrix on staging/current-build.'],
      `### D-001 — Pipeline measurement
Date: 2026-08-27
P-001 observed that dev:pipeline_position's own serving block says codeAsOfSource 'deploy'.
Related: P-001`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('does not treat a browser build waterfall as a deployed-main wait', () => {
    const browserWaterfall =
      'The body stays unrendered until mounted flips, so the chunk request cannot begin until: ' +
      'main bundle -> parse -> hydrate -> effect flush -> re-render -> fetch.';
    const parsed = plan(
      ['- **P-001** `todo` Measure portal tab performance on staging.'],
      `### D-010 — Embedded-pane browser waterfall
Date: 2026-09-07
${browserWaterfall}
Related: P-001`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
    expect(
      stagingFirstBlockerProblem({
        itemId: 'P-001',
        itemText: 'Measure portal tab performance on staging.',
        blockerText: browserWaterfall,
        kind: 'runtime',
      }),
    ).toBeNull();
  });

  it('still recognizes an until clause whose object is the release plane', () => {
    const parsed = plan(['- **P-001** `todo` Validate the interactive client on staging.'], '', `## Now

**State:** P-001 cannot continue until :3070 serves the implementation.`);

    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it('still rejects blocker semantics around deployment', () => {
    const parsed = plan(['- **P-001** `todo` P-001 is blocked on deployment before continuing implementation.']);

    expect(stagingFirstActivationProblems(parsed)).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' }),
    ]);
  });

  it('rejects a vague deployed-only label without a concrete staging limitation', () => {
    const parsed = plan(['- **P-001** `todo` Wait for :3070 before closing this deployed-only check.']);
    expect(stagingFirstActivationProblems(parsed)).toHaveLength(1);
  });
});
