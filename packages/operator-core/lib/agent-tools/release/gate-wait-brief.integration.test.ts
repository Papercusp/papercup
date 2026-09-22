/**
 * Integration coverage for the deploy/gate wait operational brief (plan
 * use-existing-router-for-review-requests-2026-09-08 P-009, spec OP-BRIEF-P009-GATE).
 *
 * Drives the release:deploy handler's own composition (`gateWaitBriefFor`) over REAL
 * collaborators: the pipeline snapshot goes through the real `computeDeployStatus` decision
 * tree, the owner through the real `readGateOwnership` resolver (only its condition-object
 * and liveness sources are injected), and the lever through the trigger handler's
 * `deployTriggerRefusalReason`. Green, red and stalled release fixtures, per the falsifier's
 * probe method.
 */
import { describe, expect, it } from 'vitest';
import { computeDeployStatus } from '../../release-deploy-launch';
import type { GitPipelineSnapshot } from '../../git-pipeline-stats';
import { readGateOwnership } from '../../coord/gate-ownership';
import type { ConditionObject } from '../../coord/condition-object';
import { deployTriggerRefusalReason } from '../../release/deploy-trigger-refusal';
import { DEPLOY_TRIGGER_LEVER } from '../../operational-brief/gate-wait-brief';
import { gateWaitBriefFor } from './deploy';

function mkSnap(gate: Partial<GitPipelineSnapshot['gate']>, deploy: Partial<GitPipelineSnapshot['deploy']>): GitPipelineSnapshot {
  return {
    routines: {
      gitSync: null,
      greenCheckpoint: null,
      releaseTrigger: { name: 'release-trigger', active: true, cron: '0 */15 * * * *', lastFiredAtMs: null, nextFireAtMs: null, pause: null },
    },
    gate: {
      consecutiveReds: 0,
      lastGreenAtMs: null,
      recordedVerdict: null,
      firstRedAtMs: null,
      stalled: false,
      lastFiredAtMs: null,
      fireStale: false,
      fireStaleReason: null,
      verdictObservedAtMs: null,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerAtMs: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      failingTestsMeasured: null,
      ...gate,
    },
    deploy: {
      integrationRoot: '/x',
      releaseRoot: '/x-release',
      releaseRef: 'main',
      integrationBranch: 'staging',
      stagingHead: { sha: 'staging00head', shortSha: 'staging0', committedAtMs: 0, subject: 's' },
      ready: { sha: 'greenpin0sha', shortSha: 'greenpin', committedAtMs: 0, subject: 'g' },
      deployed: { sha: 'deployed0sha', shortSha: 'deployed', committedAtMs: 0, subject: 'd' },
      deployedAtMs: 1,
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      errors: [],
      ...deploy,
    },
    activeRun: null,
    recent: [],
  } as unknown as GitPipelineSnapshot;
}

function conditionObject(over: Partial<ConditionObject>): ConditionObject {
  return {
    conditionKey: 'gate-red-streak:papercusp',
    workItem: 'WI-9100',
    title: 'green-checkpoint red streak',
    claimState: 'claimable',
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    duplicates: [],
    ...over,
  };
}

/** The real ownership resolver over an injected condition-object store + liveness oracle. */
function ownershipFrom(obj: ConditionObject | null, sessionState = 'live') {
  return () =>
    readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () => new Map(obj ? [[obj.conditionKey, obj]] : [])) as never,
      resolveSessionStates: (async (subjects: readonly { ownerId: string }[]) =>
        new Map(subjects.map((s) => [s.ownerId, { ownerId: s.ownerId, sessionState }]))) as never,
    });
}

describe('release:deploy status operationalBrief — gateWaitBriefFor over real collaborators', () => {
  it('green fixture with the pin ahead: names the trigger the handler would launch, and the current pin', async () => {
    const status = computeDeployStatus(mkSnap({ consecutiveReds: 0 }, { deployedBehindGreenPin: 2 }));
    expect(deployTriggerRefusalReason(status)).toBeNull();
    const brief = await gateWaitBriefFor(status, ownershipFrom(null));
    expect(brief.facts.deployTrigger.available).toBe(true);
    expect(brief.nextAction.status === 'known' && brief.nextAction.value.startsWith(DEPLOY_TRIGGER_LEVER)).toBe(true);
    expect(brief.facts.greenPin).toMatchObject({ status: 'known', value: status.deploy.greenPinSha });
    expect(brief.facts.deployedSha).toMatchObject({ status: 'known', value: status.deploy.deployedSha });
    expect(brief.owner).toEqual({ status: 'known', value: null, source: 'gate.greenCheckpoint.ownership' });
    expect(brief.text).toContain('deploy trigger: AVAILABLE');
  });

  it('red fixture owned by a live holder: reports that owner and no trigger', async () => {
    const status = computeDeployStatus(
      mkSnap({ consecutiveReds: 2, failingTests: ['x.test.ts'], failingTestsMeasured: true }, { deployedBehindGreenPin: 0 }),
    );
    expect(status.state).toBe('gate-red');
    const held = conditionObject({ claimState: 'held', takenBy: 'su-fixer', takenAt: '2026-09-22T19:00:00.000Z', expiresAt: '2026-09-22T23:00:00.000Z' });
    const brief = await gateWaitBriefFor(status, ownershipFrom(held));
    expect(brief.state).toMatchObject({ status: 'known', value: 'gate-red' });
    expect(brief.owner).toEqual({ status: 'known', value: 'su-fixer', source: 'gate.greenCheckpoint.ownership' });
    expect(brief.facts.ownerWorkItem).toMatchObject({ status: 'known', value: 'WI-9100' });
    expect(brief.facts.deployTrigger).toEqual({
      lever: DEPLOY_TRIGGER_LEVER,
      available: false,
      reason: deployTriggerRefusalReason(status),
    });
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).toContain('su-fixer owns it (WI-9100)');
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).not.toContain("op:'trigger'");
    expect(brief.blockers.status === 'known' && brief.blockers.value).toContain('failing: x.test.ts');
  });

  it('red fixture nobody holds: reports measured-unowned and the claim-and-fix lever', async () => {
    const status = computeDeployStatus(mkSnap({ consecutiveReds: 1, failingTests: ['y.test.ts'] }, { deployedBehindGreenPin: 0 }));
    const brief = await gateWaitBriefFor(status, ownershipFrom(conditionObject({ claimState: 'claimable' })));
    expect(brief.owner).toEqual({ status: 'known', value: null, source: 'gate.greenCheckpoint.ownership' });
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).toContain('red and unowned. Claim WI-9100');
  });

  it('stalled fixture: the verdict is unknown (not red) and the blocker names the stall', async () => {
    const status = computeDeployStatus(
      mkSnap({ consecutiveReds: 1, fireStale: true, fireStaleReason: 'no fire in 3h' }, { deployedBehindGreenPin: 0 }),
    );
    const brief = await gateWaitBriefFor(status, ownershipFrom(null));
    expect(brief.state).toMatchObject({ status: 'known', value: status.state });
    expect(brief.facts.verdict.status).toBe('unknown');
    expect(brief.blockers.status === 'known' && brief.blockers.value).toContain('green-checkpoint not firing: no fire in 3h');
    expect(brief.facts.deployTrigger.available).toBe(false);
    expect(brief.nextAction).toMatchObject({ status: 'known', value: status.recommendation });
  });

  it('a failing ownership read yields an explicit unknown owner, never "unowned"', async () => {
    const status = computeDeployStatus(mkSnap({ consecutiveReds: 2 }, { deployedBehindGreenPin: 0 }));
    const brief = await gateWaitBriefFor(status, async () => {
      throw new Error('pg unavailable');
    });
    expect(brief.owner).toEqual({ status: 'unknown', reason: 'gate ownership read failed: pg unavailable' });
    expect(brief.unknowns).toEqual(expect.arrayContaining(['owner', 'nextAction']));
  });
});
