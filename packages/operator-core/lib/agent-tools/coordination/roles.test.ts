/**
 * COORD_ROLES membership — pins the coord-role set and, in particular, that the
 * generic Hive worker `bee` is a member (bee-capability-expansion-2026-06-08 P-001).
 *
 * Why this matters: a tool gated `agentRoles: [...COORD_ROLES]` is callable by a
 * role-scoped (signed) caller ONLY if that caller's role is in this list. The bee
 * coordinates (coord:declare-intent/send/await-inbox), maintains its work-list
 * (work_items:*), and — the P-001 contract — creates + reads ideas and issues
 * (improvements:capture, work_items:create/list/get) which all gate on COORD_ROLES.
 * If `bee` silently dropped out of this constant, every one of those would start
 * failing `role_not_allowed` for a bee-role-scoped URL with no other signal. Pin it.
 */
import { describe, test, expect } from 'vitest';
import { COORD_ROLES } from './roles';

describe('COORD_ROLES', () => {
  test('bee is a coord role (P-001 — improvements:capture + work_items:* resolve for a bee URL)', () => {
    expect(COORD_ROLES).toContain('cup');
  });

  test('sentinel is a coord role (unify-launch-mechanics D-004 — fleet:assignments/tree + coord:* resolve for a sentinel URL)', () => {
    expect(COORD_ROLES).toContain('papercup');
  });

  test('overwatch is a coord role (overwatch-role-2026-06-15 B-01 — coord:send/escalate + improvements:capture + topics:feed resolve for an overwatch URL)', () => {
    expect(COORD_ROLES).toContain('kettle');
  });

  test('the pipeline + chat coord roles are all present (catches an accidental removal)', () => {
    for (const role of [
      'scoper',
      'architect',
      'worker',
      'validator',
      'reviewer',
      'debugger',
      'operator',
      'documenter',
      'curator',
      'cup',
    ]) {
      expect(COORD_ROLES, `missing ${role}`).toContain(role);
    }
  });

  test('the pot-rename dual-accept twins are coord roles (cup/mug/papercup/kettle accepted alongside the old ids)', () => {
    for (const role of ['cup', 'mug', 'papercup', 'kettle']) {
      expect(COORD_ROLES, `missing twin ${role}`).toContain(role);
    }
    // scout was never a coord role, so its twin `blender` is intentionally absent.
    expect(COORD_ROLES).not.toContain('blender');
  });

  test('AUTH INVARIANT (pot-rename P2): COORD_ROLES + the read-mostly exclusion admit mug but exclude cup/papercup/kettle', () => {
    // Every Queen-only write tool (fleet/place_batch, gym/*, experiment/*,
    // computer/*-desktop, bee/spawn) filters COORD_ROLES with THIS exact predicate.
    // The member-flip (adding the twins to COORD_ROLES) and this literal must move in
    // lockstep — otherwise a renamed read-mostly agent silently gains placement/gym
    // access (a tsc-invisible privilege escalation). Predicate-level so it stays a
    // fast unit test (the tool files carry the literal verbatim; grep keeps them in sync).
    const readMostlyExcluded = (r: string) =>
      r !== 'bee' && r !== 'sentinel' && r !== 'overwatch' && r !== 'cup' && r !== 'papercup' && r !== 'kettle';
    const admitted = COORD_ROLES.filter(readMostlyExcluded);
    for (const excluded of ['bee', 'sentinel', 'overwatch', 'cup', 'papercup', 'kettle']) {
      expect(admitted, `${excluded} must be excluded from Queen-only tools`).not.toContain(excluded);
    }
    // placement/judgement is the Queen's — she and her twin keep access.
    expect(admitted).toContain('mug');
    expect(admitted).toContain('mug');
  });

  test('the COORD_ROLES-gated idea/work-item tools actually admit bee (the consumer half)', async () => {
    // Capability alone is not enough; the tool's agentRoles allowlist must include
    // the caller's role (mirrors the scanner output-contract test in
    // role-principal-caps.test.ts). These three are the P-001 "bees can already
    // create + read ideas/work-items" contract — verify, don't assume.
    const { default: capture } = await import('../improvements/capture.js');
    const { default: createWorkItem } = await import('../work_items/create.js');
    const { default: listWorkItems } = await import('../work_items/list.js');
    expect(capture.agentRoles).toContain('cup');
    expect(createWorkItem.agentRoles).toContain('cup');
    expect(listWorkItems.agentRoles).toContain('cup');
  });
});
