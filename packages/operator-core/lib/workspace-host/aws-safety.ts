/**
 * AWS workspace-host managed-resource census (aws-byoc-gcp-parity-2026-10-01 P-003).
 *
 * The census reconciliation itself is provider-neutral and lives in `gcp-safety.ts`
 * (`censusManagedWorkspaceHostResources`); this module supplies the AWS profile: which kinds a
 * complete AWS inventory must cover, and the EC2 tag keys that carry Papercusp's managed identity.
 *
 * AWS has no deterministic-name kinds: every resource the AWS provider creates (EC2 instance, EBS
 * volume, EBS snapshot) carries the three managed tags, so each kind is enumerated by tag filter.
 */
import {
  censusManagedWorkspaceHostResources,
  type ManagedWorkspaceHostResourceObservation,
  type WorkspaceHostCensusProfile,
  type WorkspaceHostInventoryEvidence,
  type WorkspaceHostResourceCensus,
  type WorkspaceHostResourceCensusInput,
} from './gcp-safety';

/** EC2 tag keys stamped on every AWS resource the provider creates. AWS tag values are verbatim. */
export const AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS = {
  managed: 'papercusp:managed',
  hostId: 'papercusp:host-id',
  workspaceId: 'papercusp:workspace-id',
} as const;

export const AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS = ['vm', 'disk', 'snapshot'] as const;
export type AwsWorkspaceHostCensusResourceKind = (typeof AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS)[number];

export const AWS_WORKSPACE_HOST_CENSUS_PROFILE: WorkspaceHostCensusProfile<AwsWorkspaceHostCensusResourceKind> = {
  target: 'aws',
  providerLabel: 'AWS',
  kinds: AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS,
  deterministicKinds: new Set<AwsWorkspaceHostCensusResourceKind>(),
  managedLabelKeys: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS,
  labelValue: (value) => value,
};

/**
 * A controller-independent inventory request. It is the same shape the provisioning runner
 * builds for every provider: `projectId` is the scope the census runs in, which for AWS is the
 * account id. GCP-only fields (deterministic network names) are accepted and ignored.
 */
export interface AwsWorkspaceHostInventoryRequest {
  projectId: string;
  region: string;
  workspaceId: string;
}

export interface AwsWorkspaceHostInventorySnapshot {
  complete: true;
  observed: readonly ManagedWorkspaceHostResourceObservation[];
  inventoryEvidence: readonly WorkspaceHostInventoryEvidence<AwsWorkspaceHostCensusResourceKind>[];
}

export type AwsWorkspaceHostResourceCensusInput = WorkspaceHostResourceCensusInput<AwsWorkspaceHostCensusResourceKind>;
export type AwsWorkspaceHostResourceCensus = WorkspaceHostResourceCensus<AwsWorkspaceHostCensusResourceKind>;

export function censusAwsWorkspaceHostResources(input: AwsWorkspaceHostResourceCensusInput): AwsWorkspaceHostResourceCensus {
  return censusManagedWorkspaceHostResources(input, AWS_WORKSPACE_HOST_CENSUS_PROFILE);
}

/** EC2 `Filters` that select one workspace's Papercusp-managed resources. */
export function awsWorkspaceHostManagedFilters(workspaceId: string): { Name: string; Values: string[] }[] {
  return [
    { Name: `tag:${AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed}`, Values: ['true'] },
    { Name: `tag:${AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId}`, Values: [workspaceId] },
  ];
}
