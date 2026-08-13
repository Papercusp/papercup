/**
 * Pure projection for release:trace.
 *
 * The release truth already exists, but it is split across git position, gate,
 * deploy, and event-await authorities.  This module joins their typed results
 * without inventing a second release state machine.
 */
import type { PipelinePosition } from './git-pipeline-position';
import type { DeployStatus } from './release-deploy-launch';
import type { GateRedOwnership } from './release/gate-red-ownership';
import { classifyReleaseParity } from './release-parity';

export interface ReleaseTraceGate {
  state: DeployStatus['state'];
  authoritative: boolean;
  consecutiveReds: number;
  failingTests: string[];
  fireStale: boolean;
  fireStaleReason: string | null;
  verdictStale: boolean;
  verdictStaleReason: string | null;
  /**
   * The candidate the checkpoint verdict actually judged. This is independent of
   * GitHub/origin visibility: the green-checkpoint runs against the local
   * integration root, so a candidate can be gate-tested before the bridge publishes
   * it to origin/staging.
   */
  observedCandidate?: string | null;
  /**
   * The live checkpoint run, when measured. This is deliberately separate from
   * `observedCandidate`: that field names the last terminal verdict, while this
   * one names the candidate currently being judged by an in-flight run.
   */
  checkpointRunInFlight?: PipelinePosition['gate']['checkpointRunInFlight'];
  /** EI-18672078222841101: who already owns this red (see `GateRedOwnership`). Optional so
   *  an unwired/legacy caller renders exactly as before. This is the surface that matters
   *  most: `release:trace` is what an agent reads when it decides whether to investigate,
   *  and on 2026-07-26 it told three agents about a red while saying nothing about the
   *  fixer already dispatched for it. */
  redOwner?: GateRedOwnership | null;
}

export interface ReleaseTraceAwait {
  event: string;
  awaitId: number;
  subscriberId: string;
  state: 'registered' | 'fired' | 'expired' | 'cancelled';
  registeredAt: string;
  firedAt: string | null;
  firedReason: string | null;
  observedSha: string | null;
}

export interface ReleaseTraceWake {
  event: string;
  deliveryId: number;
  subscriberId: string;
  status: string;
  channel: string | null;
  createdAt: string;
  deliveredAt: string | null;
  observedSha: string | null;
}

export interface ReleaseTraceConstraint {
  code: string;
  blocking: boolean;
  summary: string;
}

export interface ReleaseTraceNextVerb {
  name: string;
  args?: Record<string, unknown>;
  reason: string;
}

export interface ReleaseTraceInput {
  position: PipelinePosition;
  deploy: DeployStatus;
  gate: ReleaseTraceGate;
  pipeline: string;
  inspectedKeys: string[];
  awaits: ReleaseTraceAwait[];
  wakes: ReleaseTraceWake[];
  snapshotGeneration: number;
  consumerGeneration?: number;
  requesterId?: string;
  workItem?: string;
}

function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function gateJudgedTarget(input: Pick<ReleaseTraceInput, 'position' | 'gate'>): boolean {
  // `position.gate` is the canonical projection for direct callers. The explicit
  // input field is preferred when the agent-tool wrapper supplies the same snapshot,
  // while the fallback keeps older callers safe during the field rollout.
  const observedCandidate = input.gate.observedCandidate ?? input.position.gate.observedCandidate;
  return sameSha(input.position.targetSha, observedCandidate);
}

export function classifyReleaseWake(
  targetSha: string | null,
  wakes: ReleaseTraceWake[],
): {
  verdict: 'none' | 'current' | 'stale' | 'indeterminate';
  event: string | null;
  observedSha: string | null;
  observedAt: string | null;
  reason: string;
} {
  const latest = [...wakes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!latest) {
    return {
      verdict: 'none',
      event: null,
      observedSha: null,
      observedAt: null,
      reason: 'No release wake delivery is recorded for the inspected exact-SHA/gate keys.',
    };
  }
  if (!targetSha) {
    return {
      verdict: 'indeterminate',
      event: latest.event,
      observedSha: latest.observedSha,
      observedAt: latest.deliveredAt ?? latest.createdAt,
      reason: 'The wake cannot be lineage-checked because the requested commit did not resolve.',
    };
  }
  const exactDeployKey = `release:deployed:${targetSha.toLowerCase()}`;
  const current = latest.event.toLowerCase() === exactDeployKey || sameSha(targetSha, latest.observedSha);
  return current
    ? {
        verdict: 'current',
        event: latest.event,
        observedSha: latest.observedSha,
        observedAt: latest.deliveredAt ?? latest.createdAt,
        reason: 'The latest release wake carries the requested SHA (or used its exact deploy key).',
      }
    : latest.observedSha
      ? {
          verdict: 'stale',
          event: latest.event,
          observedSha: latest.observedSha,
          observedAt: latest.deliveredAt ?? latest.createdAt,
          reason: `The latest release wake is for ${latest.observedSha}, not ${targetSha}; re-read this full trace instead of acting on that wake.`,
        }
      : {
          verdict: 'indeterminate',
          event: latest.event,
          observedSha: null,
          observedAt: latest.deliveredAt ?? latest.createdAt,
          reason: 'The latest release wake has no SHA in its payload, so it cannot authorize an exact-SHA transition.',
        };
}

function applicableConstraints(input: ReleaseTraceInput): ReleaseTraceConstraint[] {
  const { position, deploy, gate } = input;
  const constraints: ReleaseTraceConstraint[] = [];
  const add = (code: string, blocking: boolean, summary: string) => constraints.push({ code, blocking, summary });
  const targetWasGateTested = gateJudgedTarget(input);

  if (!position.targetSha) add('target-unresolved', true, 'The requested path/SHA did not resolve to a commit.');
  if (position.dirtyUncommitted) {
    add('dirty-path', true, 'The path has uncommitted edits; its reported target SHA predates those edits.');
  }
  if (position.submodule) {
    add(
      'submodule-lineage',
      true,
      `The path is inside submodule ${position.submodule}; the superproject green/deploy chain is not authoritative for it.`,
    );
  }
  if (position.runtime && !position.runtime.releasePipelineApplies) {
    add('runtime-not-release-carried', true, position.runtime.activation);
  }
  if (position.targetSha && !position.positions.onStaging) {
    add(
      'not-on-origin-staging',
      true,
      targetWasGateTested
        ? `The target commit is not present on origin/staging, but the local green-checkpoint already judged this exact candidate; origin visibility is a separate public-release requirement.`
        : 'The target commit is not present on origin/staging, so the green gate cannot test it.',
    );
  }
  if (gate.verdictStale) {
    add(
      'gate-verdict-stale',
      true,
      `${gate.verdictStaleReason ?? 'The recorded gate verdict is stale.'} Do not chase its failing-test names until a fresh verdict replaces it.`,
    );
  } else if (gate.consecutiveReds > 0) {
    add(
      'gate-red',
      true,
      `The authoritative gate is red (${gate.consecutiveReds}); fix the named failures before treating the target as tested.` +
        // EI-18672078222841101: the blocker used to stop at "fix the named failures", which
        // every reader correctly reads as an instruction to go fix them — and which three
        // agents acted on simultaneously because nothing here said one of them already had.
        (gate.redOwner ? ` ${gate.redOwner.label}` : ''),
    );
    add(
      'no-force-past-red',
      true,
      'A force deploy would ship known-broken, untested code; the safe release path remains fixing and re-running the gate.',
    );
  }
  if (gate.fireStale)
    add('gate-not-firing', true, gate.fireStaleReason ?? 'The green-checkpoint is not producing fresh verdicts.');
  if (position.targetSha && !position.positions.inMain) {
    add(
      'target-not-green-pinned',
      true,
      'The target is not in origin/main and has no exact green-gate provenance yet.',
    );
  }
  if (position.verdictProvenance.deployOrigin === 'ahead-of-gate') {
    add(
      'deployed-ahead-of-gate',
      true,
      'The live deployment is ahead of the green pin; deployed does not imply tested for this lineage.',
    );
  }
  if (position.targetSha && !position.positions.deployed) {
    add('target-not-live', true, 'The target SHA has not reached the live :3070 operator.');
  }
  if (deploy.errors.length > 0) add('trace-read-degraded', true, deploy.errors.join('; '));
  return constraints;
}

function safeNextVerb(input: ReleaseTraceInput): ReleaseTraceNextVerb | null {
  const { position, deploy, gate, pipeline, workItem } = input;
  const targetSha = position.targetSha;
  const targetWasGateTested = gateJudgedTarget(input);
  if (!targetSha) {
    return {
      name: 'dev:pipeline_position',
      args: position.input.path ? { path: position.input.path } : { sha: position.input.sha },
      reason: 'Resolve a real commit before taking a release action.',
    };
  }
  if (position.dirtyUncommitted) {
    return {
      name: 'git-sync:await',
      args: {},
      reason: 'The current path edits do not have a SHA yet; wait for the commit event before tracing lineage.',
    };
  }
  if (position.submodule) {
    return {
      name: 'dev:pipeline_position',
      args: { path: position.input.path },
      reason: 'Use the submodule-aware path probe; do not infer superproject gate/deploy provenance.',
    };
  }
  if (position.runtime && !position.runtime.releasePipelineApplies) {
    return position.runtime.restartTarget
      ? {
          name: 'dev:restart',
          args: { target: position.runtime.restartTarget, confirm: true },
          reason: 'This path is loaded from staging by its runtime; a release deploy cannot activate it.',
        }
      : null;
  }
  if (!position.positions.onStaging && !targetWasGateTested) {
    return {
      name: 'git-sync:await',
      args: { sha: targetSha },
      reason: 'Wait on the exact commit reaching origin/staging before asking the gate to test it.',
    };
  }
  if (!position.positions.inMain) {
    const checkpointRun = gate.checkpointRunInFlight;
    if (checkpointRun?.active) {
      return {
        name: 'checkpoint:await',
        args: { pipeline },
        reason:
          `A green-checkpoint run is already active${checkpointRun.candidate ? ` on candidate ${checkpointRun.candidate}` : ''}; ` +
          'await its terminal verdict, then re-read release:trace instead of launching a duplicate.',
      };
    }
    if (gate.verdictStale || gate.fireStale) {
      return {
        name: 'release:checkpoint-run',
        args: {},
        reason: 'Replace the stale/non-firing gate state with one fresh full-suite verdict.',
      };
    }
    if (gate.consecutiveReds > 0) {
      // EI-18672078222841101: this recommendation is the single highest-leverage line in the
      // whole trace — it is what an agent does next. Sending every reader of a red gate to
      // `testing:flakiness` is right when nobody is on it and wasteful when someone is: on
      // 2026-07-26 three agents ran the identical diagnosis within 15 minutes. When the
      // system already knows a live fixer holds THIS signature, wait for its verdict instead
      // of opening a parallel investigation of it.
      const redOwner = gate.redOwner;
      if (redOwner?.covered) {
        return {
          name: 'checkpoint:await',
          args: { pipeline, candidateSha: targetSha },
          reason: `${redOwner.label} Await this red's outcome rather than opening a second diagnosis of it.`,
        };
      }
      return {
        name: 'testing:flakiness',
        args: {},
        reason:
          'Classify the exact gate failures before fixing them; do not deploy past an authoritative red.' +
          (gate.redOwner ? ` ${gate.redOwner.label}` : ''),
      };
    }
    return {
      // EI-12457: bind the wait to the EXACT candidate being traced — a verdict for
      // any other (superseded) SHA on this pipeline will not wake the caller.
      name: 'checkpoint:await',
      args: { pipeline, candidateSha: targetSha },
      reason: 'The commit is on staging with no red verdict; await this pipeline’s exact gate outcome for this candidate.',
    };
  }
  if (!position.positions.deployed) {
    return deploy.canTriggerGreen
      ? {
          name: 'release:deploy',
          args: { op: 'trigger', confirm: true },
          reason: 'The target is green-pinned and green code is ahead of the live deployment; expedite only that pin.',
        }
      : {
          name: 'deploy:await',
          args: { sha: targetSha },
          reason: 'The target is green but not live; await its exact deploy key instead of polling.',
        };
  }
  if (position.verdictProvenance.deployOrigin === 'ahead-of-gate') {
    return {
      name: 'release:checkpoint-run',
      args: {},
      reason:
        'The deployed lineage is ahead of the green pin; obtain a fresh full-suite verdict before live-proof completion.',
    };
  }
  if (workItem) {
    return {
      name: 'work_items:set_live_verified',
      args: {
        id: workItem,
        testedSha: position.verdictProvenance.lastGreenSha,
        deployedSha: position.deployedSha,
      },
      reason:
        'The exact SHA is green and deployed; record live evidence on the work item after exercising the behavior.',
    };
  }
  return null;
}

export function buildReleaseTrace(input: ReleaseTraceInput) {
  const targetSha = input.position.targetSha;
  const requesterWakes = input.requesterId
    ? input.wakes.filter((wake) => wake.subscriberId === input.requesterId)
    : input.wakes;
  const wake = classifyReleaseWake(targetSha, requesterWakes);
  const constraints = applicableConstraints(input);
  const activeAwaits = input.awaits.filter((a) => a.state === 'registered');
  const generationBehind = input.consumerGeneration != null && input.consumerGeneration !== input.snapshotGeneration;
  const testedSha = input.position.verdictProvenance.lastGreenSha;
  const deployedSha = input.position.deployedSha;
  const pinParity = classifyReleaseParity({
    testedSha,
    claimedDeployedSha: deployedSha,
    actualDeployedSha: deployedSha,
    greenPinSha: testedSha,
  });
  const parity =
    targetSha != null && input.position.positions.inMain && input.position.positions.deployed && pinParity.ok;
  const nextVerb = safeNextVerb(input);
  const ok = input.position.positions.deployed && parity && constraints.every((c) => !c.blocking);

  return {
    ok,
    generatedAtMs: input.snapshotGeneration,
    target: {
      requestedPath: input.position.input.path,
      requestedSha: input.position.input.sha,
      sha: targetSha,
      subject: input.position.targetSubject,
      dirtyUncommitted: input.position.dirtyUncommitted,
      presence: input.position.positions,
      runtime: input.position.runtime,
    },
    gate: input.gate,
    greenPin: {
      sha: testedSha,
      targetIncluded: input.position.positions.inMain,
      mainFastForwarded: input.position.verdictProvenance.mainFastForwarded,
    },
    deploy: {
      sha: deployedSha,
      targetIncluded: input.position.positions.deployed,
      origin: input.position.verdictProvenance.deployOrigin,
      behindGreenPin: input.position.verdictProvenance.deployedBehindGreenPin,
    },
    testedDeployedParity: {
      ok: parity,
      targetSha,
      testedSha,
      deployedSha,
      state:
        !input.position.positions.inMain || !input.position.positions.deployed
          ? 'target-not-included'
          : pinParity.state,
    },
    awaits: {
      inspectedKeys: input.inspectedKeys,
      registered: activeAwaits,
      totalRegistrations: input.awaits.length,
      activeRegistrations: activeAwaits.length,
    },
    staleWake: wake,
    constraints,
    nextVerb,
    resync: {
      required: generationBehind,
      consumerGeneration: input.consumerGeneration ?? null,
      authoritativeGeneration: input.snapshotGeneration,
      rule: 'release:trace is a full exact-SHA snapshot. Replace the cached trace whenever required=true or a release wake arrives; never merge fields from different generations.',
      nextVerb: targetSha
        ? { name: 'release:trace', args: { sha: targetSha, after_generation: input.snapshotGeneration } }
        : null,
    },
    summary: ok
      ? `${targetSha} is present on staging/main, green-pinned, and deployed with matching lineage.`
      : `${targetSha ?? 'unresolved target'} is not release-complete: ${
          constraints
            .filter((c) => c.blocking)
            .map((c) => c.code)
            .join(', ') || 'follow nextVerb'
        }.`,
  };
}
