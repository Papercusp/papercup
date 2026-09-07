import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import { stagingFirstActivationProblems, stagingFirstBlockerProblem } from './staging-first-activation-guard';

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

  it('allows a narrow deployed-only blocker with a concrete staging limitation', () => {
    expect(
      stagingFirstBlockerProblem({
        itemId: 'WI-2',
        itemText: 'Implement restart continuity and verify on staging.',
        blockerText:
          'deployment is required for the deployed-only restart continuity check because staging cannot exercise the deployed-host supervisor restart',
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
