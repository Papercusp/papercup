import { describe, expect, it } from 'vitest';
import { parsePlan } from './parser';
import { stagingFirstActivationProblems } from './staging-first-activation-guard';

const plan = (items: string[], decisions = '', context = '') => parsePlan(`---
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

  it('does not attribute another item\'s Now gate to an incidentally mentioned item', () => {
    const parsed = plan(
      ['- **P-001** `todo` Implement the interactive client on staging.'],
      '',
      `## Now\n\n**State:** P-001 is ready; P-002 is blocked until green-checkpoint before continuing implementation.`,
    );

    expect(stagingFirstActivationProblems(parsed)).toEqual([]);
  });

  it('does not attribute another item\'s decision clause through a textual reference', () => {
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
    ['Now', `## Now\n\n**State:** P-001 is blocked until green-checkpoint.\n\n**Next:** Wait for main before continuing P-001 implementation.`],
    ['Validation', `## Validation\n\n- P-001 cannot close until :3070 serves the implementation.`],
  ])('rejects a strong main wait in a %s clause that names the item', (_label, context) => {
    const parsed = plan(
      ['- **P-001** `todo` Implement the interactive client on staging.'],
      '',
      context,
    );
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

  it('rejects a vague deployed-only label without a concrete staging limitation', () => {
    const parsed = plan([
      '- **P-001** `todo` Wait for :3070 before closing this deployed-only check.',
    ]);
    expect(stagingFirstActivationProblems(parsed)).toHaveLength(1);
  });
});
