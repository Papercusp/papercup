/**
 * Unit coverage for the deploy/gate wait operational brief (plan
 * use-existing-router-for-review-requests-2026-09-08 P-009, spec OP-BRIEF-P009-GATE).
 * Falsifier under test: the brief must never report a stale pin, omit the current gate
 * owner, or name a deploy action the trigger handler would refuse for the current verdict.
 */
import { describe, expect, it } from 'vitest';
import type { CellOwnership } from '../coord/gate-ownership';
import type { DeployStatus } from '../release-deploy-launch';
import { deployTriggerRefusalReason } from '../release/deploy-trigger-refusal';
import { renderOperationalBrief } from './brief';
import {
  DEPLOY_TRIGGER_LEVER,
  GATE_WAIT_FAILING_TESTS_SHOWN,
  projectGateWaitOperationalBrief,
  renderGateWaitFactLines,
} from './gate-wait-brief';

const T = Date.parse('2026-09-22T20:00:00.000Z');
const UP_TO_DATE = 'The live :3070 operator is at the green pin — nothing to deploy.';

function status(
  over: { gate?: Partial<DeployStatus['gate']>; deploy?: Partial<DeployStatus['deploy']>; rest?: Partial<DeployStatus> } = {},
): DeployStatus {
  return {
    gate: {
      green: true,
      consecutiveReds: 0,
      stalled: false,
      fireStale: false,
      fireStaleReason: null,
      lastGreenAtMs: T,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      failingTestsMeasured: true,
      lastVerdict: { tickAtMs: T, candidate: 'cand0000aaaa', from: null, status: 'green', logPath: null },
      ...over.gate,
    },
    deploy: {
      deployedSha: 'deployed0000',
      stagingHeadSha: 'staging00000',
      greenPinSha: 'greenpin0000',
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      deployedAtMs: T,
      ...over.deploy,
    },
    deployInFlight: null,
    deployTerminal: null,
    checkpointRunInFlight: null,
    checkpoint: {
      state: 'idle',
      authority: 'routine-control',
      phase: null,
      blocker: null,
      verdictPending: false,
      probe: { status: 'ok', detail: null },
    },
    manualRunAuthority: null,
    releaseTrigger: {
      active: true,
      cron: null,
      lastFiredAtMs: null,
      nextFireAtMs: null,
      pause: null,
      blocked: false,
      blockReason: null,
      fireStale: false,
      fireStaleReason: null,
    },
    liveCertification: null,
    canTriggerGreen: false,
    nothingToDeploy: true,
    state: 'up-to-date',
    recommendation: UP_TO_DATE,
    summary: '',
    errors: [],
    ...over.rest,
  } as unknown as DeployStatus;
}

function ownership(over: Partial<CellOwnership> = {}): CellOwnership {
  return {
    assessment: null,
    eventKey: 'gate-red-streak:papercusp',
    workItem: 'WI-9000',
    claimState: 'held',
    unknown: null,
    takenBy: 'su-holder',
    takenAt: '2026-09-22T19:00:00.000Z',
    lastProgressAt: '2026-09-22T19:50:00.000Z',
    expiresAt: '2026-09-22T22:00:00.000Z',
    ...over,
  } as unknown as CellOwnership;
}

const unowned = () => ownership({ claimState: 'no-object', workItem: null, takenBy: null, expiresAt: null });

const greenDeployable = () =>
  status({
    deploy: { deployedBehindGreenPin: 2 },
    rest: { canTriggerGreen: true, nothingToDeploy: false, state: 'green-deployable', recommendation: 'Trigger the deploy.' },
  });

const redOwned = () =>
  status({
    gate: {
      green: false,
      consecutiveReds: 3,
      failingTests: ['a.test.ts', 'b.test.ts'],
      lastVerdict: { tickAtMs: T, candidate: 'redcand0000', from: null, status: 'red', logPath: null },
    },
    rest: { state: 'gate-red', recommendation: 'Fix the reds (fix-reds > quarantine > owner-force).' },
  });

const stalled = () =>
  status({
    gate: { green: false, consecutiveReds: 1, fireStale: true, fireStaleReason: 'no fire for 3h' },
    rest: { state: 'gate-wedged', recommendation: 'The green-checkpoint is WEDGED — not firing.' },
  });

describe('projectGateWaitOperationalBrief — deploy lever availability', () => {
  it('names the trigger only when the handler predicate would launch it (green, pin ahead)', () => {
    const brief = projectGateWaitOperationalBrief({ status: greenDeployable(), ownership: unowned() });
    expect(brief.facts.deployTrigger.available).toBe(true);
    expect(brief.nextAction).toMatchObject({ status: 'known' });
    expect(brief.nextAction.status === 'known' && brief.nextAction.value.startsWith(DEPLOY_TRIGGER_LEVER)).toBe(true);
    expect(brief.facts.deployTrigger.reason).toContain('2 commit(s) ahead');
  });

  it('does not name the trigger when the live build is already at the green pin', () => {
    const s = status();
    const brief = projectGateWaitOperationalBrief({ status: s, ownership: unowned() });
    expect(brief.facts.deployTrigger).toMatchObject({ available: false, reason: deployTriggerRefusalReason(s) });
    expect(brief.facts.deployTrigger.reason).toMatch(/^nothing_to_deploy/);
    expect(brief.nextAction).toEqual({ status: 'known', value: UP_TO_DATE, source: 'release:deploy status' });
    expect(brief.deadline).toEqual({ status: 'known', value: null, source: 'release:deploy status' });
  });

  it('refuses the trigger on a red gate with the handler reason, and never advertises it', () => {
    const brief = projectGateWaitOperationalBrief({ status: redOwned(), ownership: ownership() });
    expect(brief.facts.deployTrigger.available).toBe(false);
    expect(brief.facts.deployTrigger.reason).toMatch(/^gate_red/);
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).not.toContain("op:'trigger'");
  });

  it('reports a running deploy instead of a lever, with the in-flight refusal reason', () => {
    const s = status({
      deploy: { deployedBehindGreenPin: 1 },
      rest: {
        nothingToDeploy: false,
        state: 'deploy-in-flight',
        deployInFlight: { active: true, unit: 'deploy-7', activeState: 'active', subState: 'running', startedAtMs: T, logPath: '/tmp/d.log' } as DeployStatus['deployInFlight'],
      },
    });
    const brief = projectGateWaitOperationalBrief({ status: s, ownership: unowned() });
    expect(brief.facts.deployTrigger.reason).toMatch(/^deploy_in_flight/);
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).toMatch(/^Wait for the running deploy \(unit deploy-7\)/);
    expect(brief.blockers).toEqual({ status: 'known', value: ['deploy in flight (unit deploy-7)'], source: 'release:deploy status' });
  });

  it('agrees with the trigger handler predicate on every fixture', () => {
    for (const s of [status(), greenDeployable(), redOwned(), stalled()]) {
      const brief = projectGateWaitOperationalBrief({ status: s, ownership: ownership() });
      expect(brief.facts.deployTrigger.available).toBe(deployTriggerRefusalReason(s) === null);
      if (!brief.facts.deployTrigger.available && brief.nextAction.status === 'known') {
        expect(brief.nextAction.value).not.toContain(DEPLOY_TRIGGER_LEVER);
      }
    }
  });
});

describe('projectGateWaitOperationalBrief — gate owner', () => {
  it('reports the live holder of a red gate and tells others not to open a second lane', () => {
    const brief = projectGateWaitOperationalBrief({ status: redOwned(), ownership: ownership() });
    expect(brief.owner).toEqual({ status: 'known', value: 'su-holder', source: 'gate.greenCheckpoint.ownership' });
    expect(brief.facts.ownerWorkItem).toMatchObject({ status: 'known', value: 'WI-9000' });
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).toContain('su-holder owns it (WI-9000)');
    expect(brief.deadline).toEqual({
      status: 'known',
      value: '2026-09-22T22:00:00.000Z',
      source: 'gate.greenCheckpoint.ownership lease expiry',
    });
  });

  it('reports a measured-unowned red gate as owner null and names the claim-and-fix lever', () => {
    const brief = projectGateWaitOperationalBrief({
      status: redOwned(),
      ownership: ownership({ claimState: 'claimable', takenBy: null }),
    });
    expect(brief.owner).toEqual({ status: 'known', value: null, source: 'gate.greenCheckpoint.ownership' });
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).toContain('red and unowned. Claim WI-9000');
    expect(brief.nextAction.status === 'known' && brief.nextAction.value).toContain('release:repair-queue');
  });

  it('never turns an unmeasured owner into "unowned"', () => {
    const brief = projectGateWaitOperationalBrief({
      status: redOwned(),
      ownership: ownership({ unknown: { code: 'resolver-failed', detail: 'pg down' } as CellOwnership['unknown'] }),
    });
    expect(brief.owner).toEqual({ status: 'unknown', reason: 'gate ownership unmeasured: resolver-failed (pg down)' });
    expect(brief.nextAction.status).toBe('unknown');
    expect(brief.unknowns).toEqual(expect.arrayContaining(['owner', 'nextAction', 'facts.ownerClaimState']));
  });

  it('names a failed ownership read and a held item with no readable holder', () => {
    const failed = projectGateWaitOperationalBrief({ status: redOwned(), ownership: null, ownershipReadError: 'gate ownership read failed: boom' });
    expect(failed.owner).toEqual({ status: 'unknown', reason: 'gate ownership read failed: boom' });
    const notRead = projectGateWaitOperationalBrief({ status: status(), ownership: undefined });
    expect(notRead.owner).toEqual({ status: 'unknown', reason: 'gate ownership was not read on this call' });
    const noHolder = projectGateWaitOperationalBrief({ status: redOwned(), ownership: ownership({ takenBy: null }) });
    expect(noHolder.owner).toEqual({ status: 'unknown', reason: 'the gate item is held but its holder is unreadable' });
  });
});

describe('projectGateWaitOperationalBrief — pin, verdict and blockers', () => {
  it('reports exactly the pin of the read it was given, and an unresolved pin as unknown', () => {
    const a = projectGateWaitOperationalBrief({ status: status(), ownership: unowned() });
    const b = projectGateWaitOperationalBrief({ status: status({ deploy: { greenPinSha: 'newpin111111' } }), ownership: unowned() });
    expect(a.facts.greenPin).toMatchObject({ status: 'known', value: 'greenpin0000' });
    expect(b.facts.greenPin).toMatchObject({ status: 'known', value: 'newpin111111' });
    const missing = projectGateWaitOperationalBrief({ status: status({ deploy: { greenPinSha: null, deployedSha: null, deployedBehindGreenPin: null } }), ownership: unowned() });
    expect(missing.facts.greenPin.status).toBe('unknown');
    expect(missing.facts.deployedSha.status).toBe('unknown');
    expect(missing.unknowns).toEqual(expect.arrayContaining(['facts.greenPin', 'facts.deployedSha', 'facts.deployedBehindGreenPin']));
  });

  it('reports a stalled (not firing) gate verdict as unknown, not red', () => {
    const brief = projectGateWaitOperationalBrief({ status: stalled(), ownership: unowned() });
    expect(brief.state).toMatchObject({ status: 'known', value: 'gate-wedged' });
    expect(brief.facts.verdict).toEqual({ status: 'unknown', reason: 'the green-checkpoint is not firing (no fire for 3h); its counters describe the past' });
    expect(brief.blockers).toEqual({ status: 'known', value: ['green-checkpoint not firing: no fire for 3h'], source: 'release:deploy status' });
    expect(brief.nextAction).toMatchObject({ status: 'known', value: 'The green-checkpoint is WEDGED — not firing.' });
  });

  it('marks a superseded verdict unknown and says so on the last verified evidence', () => {
    const brief = projectGateWaitOperationalBrief({
      status: status({ gate: { green: false, verdictStale: true, verdictStaleReason: 'candidate superseded' }, rest: { state: 'gate-verdict-stale' } }),
      ownership: unowned(),
    });
    expect(brief.facts.verdict).toEqual({ status: 'unknown', reason: 'the last verdict is superseded or unverified: candidate superseded' });
    expect(brief.lastVerified.status === 'known' && brief.lastVerified.value.summary).toBe('gate verdict green (superseded or unverified)');
  });

  it('lists failing tests up to the cap and counts the rest; unmeasured failures stay unknown', () => {
    const many = Array.from({ length: GATE_WAIT_FAILING_TESTS_SHOWN + 3 }, (_, i) => `t${i}.test.ts`);
    const brief = projectGateWaitOperationalBrief({ status: status({ gate: { green: false, failingTests: many }, rest: { state: 'gate-red' } }), ownership: ownership() });
    expect(brief.blockers.status === 'known' && brief.blockers.value.at(-1)).toBe('…and 3 more failing test file(s)');
    const unmeasured = projectGateWaitOperationalBrief({ status: status({ gate: { green: false, failingTestsMeasured: false }, rest: { state: 'gate-red' } }), ownership: ownership() });
    expect(unmeasured.blockers).toEqual({ status: 'unknown', reason: 'the gate is red but its failing tests were not measured on this read' });
  });

  it('renders the pin, owner claim and lever lines beside the shared brief', () => {
    const brief = projectGateWaitOperationalBrief({ status: redOwned(), ownership: ownership() });
    const text = [renderOperationalBrief(brief), ...renderGateWaitFactLines(brief)].join('\n');
    expect(text).toContain('[gate-wait] green-checkpoint → :3070 deploy — gate-red');
    expect(text).toContain('owner: su-holder');
    expect(text).toContain('pin: main greenpin00 · :3070 deployed00 · behind 0');
    expect(text).toContain('gate claim: held (WI-9000)');
    expect(text).toContain('deploy trigger: unavailable — gate_red');
  });
});
