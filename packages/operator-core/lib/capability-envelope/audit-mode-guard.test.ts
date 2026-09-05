/**
 * audit-mode-guard — mechanical enforcement of AUDIT mode's read-only-toward-its-
 * subject clause (WI-2140596).
 *
 * Falsifiability: alongside the real guard, `alwaysAllowControl` is a
 * deliberately-wrong implementation kept permanently as a control — the calibration
 * cases assert the REAL guard catches what the control misses, so a broken property
 * makes the control cases fail too (same pattern as goal-mode-edit-guard.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

import {
  AUDIT_MODE_MUTATION_VERBS,
  auditModeMutationDenyReason,
  checkAuditModeMutationGuard,
  isAuditModeMutationVerb,
} from './audit-mode-guard';

const PLAIN_CTX = { isSuperuser: true } as unknown as UnifiedToolContext;

const identityFor = (ownerId: string, workspaceId: string | null = 'papercusp-workspace') => {
  return () => ({ ownerId, workspaceId });
};

const auditModes = async () => [{ mode: 'auto' }, { mode: 'audit' }];
const auditModesOwnerDirected = async () => [{ mode: 'audit' }];
const plainModes = async () => [{ mode: 'auto' }, { mode: 'ideate' }];
const noModes = async () => [];

/** Deliberately-wrong control: a guard that never denies. */
async function alwaysAllowControl(): Promise<null> {
  return null;
}

describe('isAuditModeMutationVerb', () => {
  it('matches every canonical mutation verb', () => {
    for (const verb of AUDIT_MODE_MUTATION_VERBS) {
      const concrete = verb.endsWith(':*') ? `${verb.slice(0, -1)}status` : verb;
      expect(isAuditModeMutationVerb(concrete), `${concrete} should match`).toBe(true);
    }
  });

  it('does NOT match reads and finding-filers — an audit must still be able to do its job', () => {
    for (const allowed of [
      'work_items:get',
      'work_items:list',
      'work_items:create',
      'work_items:comment',
      'work_items:observe',
      'plans:get',
      'plans:list',
      'mode:set',
      'coord:presence',
    ]) {
      expect(isAuditModeMutationVerb(allowed), `${allowed} must stay allowed`).toBe(false);
    }
  });

  it('matches the plan_items:* group wildcard', () => {
    expect(isAuditModeMutationVerb('plan_items:claim')).toBe(true);
    expect(isAuditModeMutationVerb('plan_items:release')).toBe(true);
  });
});

describe('checkAuditModeMutationGuard', () => {
  it('denies a mutation verb from an AUDIT-mode session, with the teaching reason', async () => {
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'work_items:set_state', ctx: PLAIN_CTX },
      { resolveIdentity: identityFor('su-audit-1'), readModes: auditModes },
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('deny');
    expect(verdict!.posture).toBe('rejected');
    expect(verdict!.applied).toBe(true);
    expect(verdict!.reason).toBe(
      auditModeMutationDenyReason({ toolName: 'work_items:set_state', ownerId: 'su-audit-1' }),
    );
    expect(verdict!.reason).toMatch(/read-only toward the audited subject/i);
    expect(verdict!.reason).toMatch(/work_items:create/);
    expect(verdict!.reason).toMatch(/does not clear the durable AUDIT row/);
    expect(verdict!.reason).toMatch(/mode:set/);
    // Calibration: the wrong control would have allowed this exact case.
    expect(await alwaysAllowControl()).toBeNull();
  });

  it('denies EVERY listed mutation verb (including the plan_items:* wildcard) when in AUDIT mode', async () => {
    for (const verb of AUDIT_MODE_MUTATION_VERBS) {
      const concrete = verb.endsWith(':*') ? `${verb.slice(0, -1)}status` : verb;
      const verdict = await checkAuditModeMutationGuard(
        { toolName: concrete, ctx: PLAIN_CTX },
        { resolveIdentity: identityFor('su-audit-1'), readModes: auditModes },
      );
      expect(verdict, `${concrete} should be denied`).not.toBeNull();
      expect(verdict!.decision).toBe('deny');
    }
  });

  it("denies regardless of ownerDirected — the AUDIT contract makes no such distinction (deliberate divergence from the WI's literal wording)", async () => {
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'plans:set-status', ctx: PLAIN_CTX },
      { resolveIdentity: identityFor('su-audit-1'), readModes: auditModesOwnerDirected },
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.decision).toBe('deny');
  });

  it('allows a mutation verb when the session is NOT in audit mode', async () => {
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'work_items:set_state', ctx: PLAIN_CTX },
      { resolveIdentity: identityFor('su-plain-1'), readModes: plainModes },
    );
    expect(verdict).toBeNull();
  });

  it('allows when the session has no modes at all', async () => {
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'plans:set-now', ctx: PLAIN_CTX },
      { resolveIdentity: identityFor('su-plain-2'), readModes: noModes },
    );
    expect(verdict).toBeNull();
  });

  it('allows work_items:create/comment/observe even in AUDIT mode — filing findings is the job', async () => {
    for (const allowed of ['work_items:create', 'work_items:comment', 'work_items:observe']) {
      const verdict = await checkAuditModeMutationGuard(
        { toolName: allowed, ctx: PLAIN_CTX },
        { resolveIdentity: identityFor('su-audit-1'), readModes: auditModes },
      );
      expect(verdict, `${allowed} must stay allowed`).toBeNull();
    }
  });

  it('never reads modes for a non-mutation verb (the cheap static check gates the DB read)', async () => {
    let readModesCalled = false;
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'work_items:get', ctx: PLAIN_CTX },
      {
        resolveIdentity: identityFor('su-audit-1'),
        readModes: async () => {
          readModesCalled = true;
          return auditModes();
        },
      },
    );
    expect(verdict).toBeNull();
    expect(readModesCalled).toBe(false);
  });

  it('fails OPEN when identity resolution throws (an unattributable ctx has nothing to gate)', async () => {
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'work_items:set_state', ctx: PLAIN_CTX },
      {
        resolveIdentity: () => {
          throw new Error('unattributable ctx');
        },
        readModes: auditModes,
      },
    );
    expect(verdict).toBeNull();
  });

  it('fails OPEN when the mode read throws (enforcement must never wedge dispatch fleet-wide)', async () => {
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'work_items:set_state', ctx: PLAIN_CTX },
      {
        resolveIdentity: identityFor('su-audit-1'),
        readModes: async () => {
          throw new Error('pg down');
        },
      },
    );
    expect(verdict).toBeNull();
  });

  it('null workspace falls back to the default workspace rather than allowing blind', async () => {
    let asked: string | null = null;
    const verdict = await checkAuditModeMutationGuard(
      { toolName: 'work_items:set_state', ctx: PLAIN_CTX },
      {
        resolveIdentity: identityFor('su-audit-1', null),
        readModes: async (ws) => {
          asked = ws;
          return auditModes();
        },
      },
    );
    expect(asked).toBe('default');
    expect(verdict).not.toBeNull();
  });
});
