/**
 * spawn-approval.test.ts — the brain-only spawn-approval gate (P-005 / P-006).
 *
 * Locks the security contract at the DISPATCH-DECLARATION layer (the dispatcher's
 * fail-closed `roleRequirementStep` enforces `requireRoles` — tested in tooldef):
 *   • new_subagent:approve is BRAIN-ONLY — `requireRoles` carries the brain role,
 *     so a spawned worker/scoper (no brain role) is denied; only the operator/brain
 *     principal (or a superuser) may approve. This is the one genuinely-new bit
 *     (D-008): what `coord:resolve` left open to ALL coord roles is now narrowed.
 *   • new_subagent:request is OPEN — any agent may INITIATE a spawn request
 *     (decentralized initiative); the brain decides.
 */
import { describe, it, expect } from 'vitest';
import { BRAIN_PRINCIPAL_ROLE } from '@papercusp/agent-mcp';
import requestTool from './request';
import approveTool from './approve';

describe('new_subagent spawn-approval gate (P-005 / P-006)', () => {
  it('new_subagent:approve is BRAIN-ONLY — requireRoles carries the brain role (dispatch-enforced, not prompt)', () => {
    expect(approveTool.name).toBe('new_subagent:approve');
    expect(approveTool.requireRoles ?? []).toContain(BRAIN_PRINCIPAL_ROLE);
    // defense-in-depth on the orchestration axis (the brain's ctx.role === 'operator')
    expect(approveTool.agentRoles ?? []).toContain('operator');
  });

  it('new_subagent:request is OPEN — any agent may initiate (NOT narrowed to the brain)', () => {
    expect(requestTool.name).toBe('new_subagent:request');
    expect(requestTool.requireRoles ?? []).not.toContain(BRAIN_PRINCIPAL_ROLE);
  });

  it('the brain principal role is a stable, non-empty string', () => {
    expect(typeof BRAIN_PRINCIPAL_ROLE).toBe('string');
    expect(BRAIN_PRINCIPAL_ROLE.length).toBeGreaterThan(0);
  });
});
