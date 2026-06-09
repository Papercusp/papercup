/**
 * COORD_ROLES membership — pins the coord-role set and, in particular, that the
 * generic Hive worker `bee` is a member (bee-capability-expansion-2026-06-08 P-001).
 *
 * Why this matters: a tool gated `agentRoles: [...COORD_ROLES]` is callable by a
 * role-scoped (signed) caller ONLY if that caller's role is in this list. The bee
 * coordinates (coord:declare-intent/send/await-inbox), maintains its work-list
 * (work_items:*), and — the P-001 contract — creates + reads ideas and issues
 * (improvements:capture, issues:create/list/get) which all gate on COORD_ROLES.
 * If `bee` silently dropped out of this constant, every one of those would start
 * failing `role_not_allowed` for a bee-role-scoped URL with no other signal. Pin it.
 */
import { describe, test, expect } from 'vitest';
import { COORD_ROLES } from './roles';

describe('COORD_ROLES', () => {
  test('bee is a coord role (P-001 — improvements:capture + issues:* resolve for a bee URL)', () => {
    expect(COORD_ROLES).toContain('bee');
  });

  test('sentinel is a coord role (unify-launch-mechanics D-004 — fleet:assignments/tree + coord:* resolve for a sentinel URL)', () => {
    expect(COORD_ROLES).toContain('sentinel');
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
      'bee',
    ]) {
      expect(COORD_ROLES, `missing ${role}`).toContain(role);
    }
  });

  test('the COORD_ROLES-gated idea/issue tools actually admit bee (the consumer half)', async () => {
    // Capability alone is not enough; the tool's agentRoles allowlist must include
    // the caller's role (mirrors the scanner output-contract test in
    // role-principal-caps.test.ts). These three are the P-001 "bees can already
    // create + read ideas/issues" contract — verify, don't assume.
    const { default: capture } = await import('../improvements/capture.js');
    const { default: createIssue } = await import('../issues/create.js');
    const { default: listIssues } = await import('../issues/list.js');
    expect(capture.agentRoles).toContain('bee');
    expect(createIssue.agentRoles).toContain('bee');
    expect(listIssues.agentRoles).toContain('bee');
  });
});
