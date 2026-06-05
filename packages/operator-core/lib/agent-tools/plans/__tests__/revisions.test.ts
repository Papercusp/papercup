/**
 * Unit coverage for the plan revision spine's pure helpers
 * (plan-agent-launch-2026-05-21, P-002 / P-006 / D-009).
 *
 * `classifyAuthor` and `resolvePlanSessionRef` are pure and DB-free —
 * they map a resolved `AgentIdentity` / a call ctx onto the revision's
 * author and session columns. The DB-backed `seq` allocation in
 * `recordPlanRevision` is covered by the live round-trip in
 * P-027 / P-028 (it needs the embedded `harness_shared` schema, out of
 * reach of a pure unit run).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyAuthor,
  planRevisionCapture,
  resolvePlanSessionRef,
  revisionDiffStat,
} from '../revisions';
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

describe('resolvePlanSessionRef', () => {
  it('resolves a threaded plan-run id to the plan_run session kind', () => {
    // The MCP transport folds `?plan_run=<uuid>` onto `planRunSessionId`
    // (P-006); a launched agent's writes are attributed to its run.
    expect(resolvePlanSessionRef({ planRunSessionId: 'run-abc' })).toEqual({
      sessionId: 'run-abc',
      sessionKind: 'plan_run',
    });
  });

  it('returns a null session for a caller with no threaded plan-run', () => {
    // An SU engineer session, a browser /admin/plans save — no
    // conversation is threaded, the revision is a "direct edit".
    expect(resolvePlanSessionRef({})).toEqual({ sessionId: null, sessionKind: null });
    expect(resolvePlanSessionRef({ planRunSessionId: null })).toEqual({
      sessionId: null,
      sessionKind: null,
    });
  });

  it('treats an empty-string plan-run id as no session', () => {
    // `?plan_run=` with an empty value must not record a blank session.
    expect(resolvePlanSessionRef({ planRunSessionId: '' })).toEqual({
      sessionId: null,
      sessionKind: null,
    });
  });
});

describe('revisionDiffStat', () => {
  it('counts the whole plan as added for the first revision (empty before)', () => {
    expect(revisionDiffStat('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
  });

  it('reports no change for identical snapshots', () => {
    expect(revisionDiffStat('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    expect(revisionDiffStat('', '')).toEqual({ added: 0, removed: 0 });
  });

  it('reports a changed line as one added and one removed', () => {
    expect(revisionDiffStat('a\nb\nc', 'a\nX\nc')).toEqual({ added: 1, removed: 1 });
  });

  it('reports a pure append and a pure deletion asymmetrically', () => {
    expect(revisionDiffStat('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
    expect(revisionDiffStat('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
  });
});
