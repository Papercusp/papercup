/**
 * Plan unified-bug-pipeline-and-honest-queue-2026-10-05 D-011 (extends D-024), P-002:
 * an invocation-friction report carries the failing tool_invocations row, which is a
 * reproduction receipt on the build that served the call. Bug-class failures become
 * born verified; caller/rate-limit failures (filed as `change`) never skip review.
 */
import { describe, expect, it } from 'vitest';
import { frictionReproduction, isStrandedToolFailureReview, type ToolInvocationFriction } from './capture-core';
import { readBornVerifiedReproduction } from '../../attention/bug-reproduction';

const base: ToolInvocationFriction = {
  workspaceId: 'ws-a',
  harnessSlug: 'papercusp',
  ownerId: 'su-a',
  invokedAt: '2026-10-06T01:00:00.000Z',
  failure: { toolName: 'work_items:get', status: 'error', errorCode: 'handler_error', message: 'boom' },
  invocationId: '987654',
  servingBuildSha: 'ABCDEF1234567',
};

describe('frictionReproduction (D-011)', () => {
  it('turns a failing bug-class invocation into a verified receipt that reads as born verified', async () => {
    const stored = await frictionReproduction(base, 'bug');
    expect(stored).toMatchObject({
      schemaVersion: 'bug-reproduction-v1',
      receipt: { kind: 'encounter', ref: 'tool_invocations:987654', buildSha: 'abcdef1234567' },
      filedBy: 'su-a',
      verification: { status: 'verified' },
    });
    expect(readBornVerifiedReproduction({ reproduction: stored })).toMatchObject({ ref: 'tool_invocations:987654' });
  });

  it('never builds a receipt for a change-class (caller / rate-limit) failure', async () => {
    expect(await frictionReproduction(base, 'change')).toBeNull();
  });

  it('skips a row with no usable serving build or no row id', async () => {
    expect(await frictionReproduction({ ...base, servingBuildSha: null }, 'bug')).toBeNull();
    expect(await frictionReproduction({ ...base, servingBuildSha: 'loaded-build' }, 'bug')).toBeNull();
    expect(await frictionReproduction({ ...base, invocationId: undefined }, 'bug')).toBeNull();
  });
});

describe('isStrandedToolFailureReview (EI-25176539351759672)', () => {
  const awaiting = { status: 'unknown', reason: 'corroborated-tool-failure-awaiting-review' };
  it('flags an awaiting-review stamp with no review record', () => {
    expect(isStrandedToolFailureReview({ implementationReadiness: awaiting })).toBe(true);
  });
  it('does not flag an enrolled, ready, or differently-held row', () => {
    expect(isStrandedToolFailureReview({ implementationReadiness: awaiting, agentReview: { status: 'pending' } })).toBe(false);
    expect(isStrandedToolFailureReview({ implementationReadiness: { ...awaiting, status: 'ready' } })).toBe(false);
    // P-003 / D-022: a triage place whose deployment screen could not answer is stranded too.
    expect(
      isStrandedToolFailureReview({ implementationReadiness: { ...awaiting, reason: 'deployment-freshness-unknown' } }),
    ).toBe(true);
    expect(
      isStrandedToolFailureReview({ implementationReadiness: { ...awaiting, reason: 'awaiting-agent-review' } }),
    ).toBe(false);
    expect(isStrandedToolFailureReview({ implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' } })).toBe(false);
    expect(isStrandedToolFailureReview(null)).toBe(false);
  });
});
