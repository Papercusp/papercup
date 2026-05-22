/**
 * Unit coverage for the plan revision spine's author classification
 * (plan-agent-launch-2026-05-21, P-002 / D-009).
 *
 * `classifyAuthor` is pure and DB-free — it maps a resolved
 * `AgentIdentity` onto `agent` | `human`. The DB-backed `seq`
 * allocation in `recordPlanRevision` is covered by the live
 * round-trip in P-027 / P-028 (it needs the embedded `harness_shared`
 * schema, out of reach of a pure unit run).
 */

import { describe, expect, it } from 'vitest';
import { classifyAuthor, planRevisionCapture } from '../revisions';
import type { AgentIdentity, IdentitySource } from '../../coordination/identity';

function identity(source: IdentitySource): AgentIdentity {
  return {
    ownerId: `owner-${source}`,
    ownerLabel: `label · ${source}`,
    source,
    workspaceId: null,
    userId: null,
  };
}

describe('classifyAuthor', () => {
  it('treats an in-process principal caller as a human', () => {
    // The /admin/plans editor route proxy and operator chat both
    // resolve to `principal` — a person is driving the write.
    expect(classifyAuthor(identity('principal'))).toBe('human');
  });

  it('treats every agent MCP session source as an agent', () => {
    const agentSources: IdentitySource[] = [
      'power-user-token',
      'omp-hook-session',
      'static-client',
    ];
    for (const source of agentSources) {
      expect(classifyAuthor(identity(source))).toBe('agent');
    }
  });
});

describe('planRevisionCapture', () => {
  it('is a best-effort no-op when the ctx carries no identity', async () => {
    // `{}` resolves to no power-user / superuser / principal identity —
    // `resolveAgentIdentity` throws, the capture swallows it (D-014) and
    // returns a no-op `afterWrite` rather than failing the write.
    const cap = planRevisionCapture({}, 'some-plan-2026-05-21', 'a reason');
    expect(cap.recorded.current).toBeNull();
    await expect(cap.afterWrite('# plan body')).resolves.toBeUndefined();
    expect(cap.recorded.current).toBeNull();
  });
});
