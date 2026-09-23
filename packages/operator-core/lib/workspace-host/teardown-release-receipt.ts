/**
 * The `teardown.resource-census` release receipt (R-6 "eight-kind residue", WI-10002510), recorded by
 * the destroy that OBSERVES it. A destroy reports success only once every owned resource carries a
 * provider-read absence receipt AND an independent all-kind provider census settled clean
 * (provisioning-runner.ts). The receipt is the release-level claim "bundle B's host tore down leaving
 * no residue across these resource kinds", so its identity names the kinds, and a census whose
 * inventory did not cover every one of them cannot commit it — clean over fewer kinds is not clean.
 */
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal';
import { GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS, type GcpWorkspaceHostResourceCensus } from './gcp-safety';
import {
  openWorkspaceHostReleaseRecorder,
  type WorkspaceHostReleaseRecorder,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';

export const WORKSPACE_HOST_RESOURCE_CENSUS_STAGE = 'teardown.resource-census';

export type WorkspaceHostTeardownReleaseRecorder = WorkspaceHostReleaseRecorder<'resource-census'>;

export function workspaceHostResourceCensusStage(): WorkspaceHostReleaseStage {
  return {
    stage: WORKSPACE_HOST_RESOURCE_CENSUS_STAGE,
    identity: { provider: 'gcp', kinds: [...GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS].sort() },
  };
}

/** Judge the census stage from the terminal census itself: clean, complete, and covering every kind. */
export function workspaceHostResourceCensusOutcome(input: {
  subject: { workspaceId: string; hostId: string };
  disposition: string;
  census: GcpWorkspaceHostResourceCensus;
}): { outcome: 'committed' | 'refused'; evidenceRefs: string[] } {
  const { census } = input;
  const covered = new Set(census.inventoryEvidence.map((evidence) => evidence.kind));
  const uncovered = GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.filter((kind) => !covered.has(kind));
  const evidenceRefs = [
    `census-host:${input.subject.workspaceId}/${input.subject.hostId}`,
    `census-disposition:${input.disposition}`,
    `census-evaluated-at:${census.evaluatedAt}`,
    ...census.inventoryEvidence.map(
      (evidence) => `census-kind:${evidence.kind}:${evidence.strategy}:${evidence.providerEvidenceRef.slice(0, 300)}`,
    ),
    `census-managed:${census.managed.length}`,
    `census-untracked:${census.untracked.length}`,
    `census-missing:${census.missing.length}`,
    `census-label-mismatches:${census.labelMismatches.length}`,
    ...uncovered.map((kind) => `census-uncovered:${kind}`),
  ];
  const clean = census.clean && census.controllerIndependent && census.inventoryComplete && uncovered.length === 0;
  return { outcome: clean ? 'committed' : 'refused', evidenceRefs };
}

/** The census stage, opened read-only before the destroy mutates anything. */
export function openWorkspaceHostTeardownRelease(input: {
  releaseTaskId: string;
  workspaceId: string;
  hostId: string;
  operationId: string;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}): Promise<WorkspaceHostTeardownReleaseRecorder> {
  const { operationId, ...rest } = input;
  return openWorkspaceHostReleaseRecorder({
    ...rest,
    stages: { 'resource-census': workspaceHostResourceCensusStage() },
    runRef: `destroy-operation:${operationId}`,
  });
}
