/**
 * Production `AwsWorkspaceHostSdkClient` + `AwsWorkspaceHostPreflightClient` over the
 * maintained AWS SDK for JavaScript v3 modular clients (aws-byoc-gcp-parity-2026-10-01 P-002,
 * D-002 — never a hand-rolled SigV4 client).
 *
 * Contract:
 * - Credentials come ONLY from `planAwsSdkCredentialProvider` for the connection's persisted,
 *   non-secret credential source (local default chain / shared profile incl. SSO and console
 *   login / local assume-role / hosted customer-role chained through the per-org Papercusp role
 *   with an org-scoped ExternalId per D-001 / hosted OIDC web identity).
 * - Every error that leaves this module is an `AwsWorkspaceHostSdkError` built from an
 *   allow-list of fields and a scrubbed message: no `cause`, no `$response`, and every secret
 *   access key / session token this module ever resolved is redacted (AWSP-P-002-no-secret-leak).
 *   Nothing is logged and no process is spawned, so no credential reaches argv or logs.
 * - Mutations reuse the caller's EC2 `ClientToken` verbatim (AWSP-P-002-client-token); EBS
 *   volumes and snapshots, which EC2 cannot filter by client token, carry it as the
 *   `papercusp:client-token` tag so `find*ByClientToken` can recover them after a crash.
 * - State waits use the SDK v3 waiters and honour `AbortSignal`: an aborted wait throws an
 *   `AbortError`; a waiter timeout or failure acceptor falls through to a fresh provider read,
 *   so the provider (not the waiter) decides applied vs in-progress.
 * - All mutating calls first verify (once, memoized) that the resolved identity belongs to the
 *   connection's account, so a mis-pointed profile can never create resources in another
 *   account; the region is bound by construction of the regional clients.
 */
import {
  AttachVolumeCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  DescribeInstanceStatusCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSnapshotsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
  RebootInstancesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceStopped,
  waitUntilInstanceTerminated,
  waitUntilSnapshotCompleted,
  waitUntilVolumeAvailable,
  waitUntilVolumeDeleted,
  waitUntilVolumeInUse,
  type Image,
  type Instance,
  type InstanceTypeInfo,
  type Snapshot,
  type Volume,
} from '@aws-sdk/client-ec2';
import { GetRoleCommand, IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetProductsCommand, PricingClient } from '@aws-sdk/client-pricing';
import {
  GetAWSDefaultServiceQuotaCommand,
  GetServiceQuotaCommand,
  ServiceQuotasClient,
} from '@aws-sdk/client-service-quotas';
import { DescribeInstanceInformationCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  fromIni,
  fromNodeProviderChain,
  fromTemporaryCredentials,
  fromWebToken,
} from '@aws-sdk/credential-providers';
import type {
  WorkspaceHostCatalogQuery,
  WorkspaceHostConnectionValidation,
  WorkspaceHostDesiredSpec,
  WorkspaceHostImage,
  WorkspaceHostPriceEstimate,
  WorkspaceHostPriceLineItem,
  WorkspaceHostProviderConnection,
  WorkspaceHostRegion,
  WorkspaceHostScope,
  WorkspaceHostSize,
} from '@papercusp/deployment-driver';
import {
  AWS_WORKSPACE_HOST_TARGET,
  planAwsSdkCredentialProvider,
  type AwsCallerIdentityEvidence,
  type AwsImageEvidence,
  type AwsKmsKeyEvidence,
  type AwsPartition,
  type AwsRegionEvidence,
  type AwsSdkCredentialProviderPlan,
  type AwsSubnetEvidence,
  type AwsWorkspaceHostCredentialSource,
  type AwsWorkspaceHostPermissionAction,
  type AwsWorkspaceHostPermissionEvidence,
  type AwsWorkspaceHostPermissionRequest,
  type AwsWorkspaceHostPreflightClient,
  type AwsWorkspaceHostQuotaEvidence,
  type AwsWorkspaceHostQuotaRequirement,
} from './aws-connection';
import type {
  AwsCreateSnapshotInput,
  AwsCreateVolumeInput,
  AwsCreatedInstance,
  AwsCreatedSnapshot,
  AwsCreatedVolume,
  AwsEbsVolumeState,
  AwsEc2InstanceState,
  AwsInstanceObservation,
  AwsProviderMutationResult,
  AwsRunInstancesInput,
  AwsSnapshotObservation,
  AwsTag,
  AwsVolumeObservation,
  AwsWorkspaceHostSdkClient,
} from './aws-provider';

export const AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG = 'papercusp:client-token';
const DEFAULT_ROLE_SESSION_NAME = 'papercusp-workspace-host';
const ORG_ROLE_SESSION_NAME = 'papercusp-org-role';
const HOURS_PER_MONTH = 730;

/** The SDK's credential provider shape, derived so no transitive `@smithy/types` import is needed. */
export type AwsSdkCredentialIdentityProvider = ReturnType<typeof fromNodeProviderChain>;
type AwsSdkCredentialIdentity = Awaited<ReturnType<AwsSdkCredentialIdentityProvider>>;

/** The regional SDK v3 clients one connection uses. Tests inject structural fakes. */
export interface AwsSdkClientSet {
  ec2: EC2Client;
  ssm: SSMClient;
  sts: STSClient;
  iam: IAMClient;
  kms: KMSClient;
  serviceQuotas: ServiceQuotasClient;
  pricing: PricingClient;
}

export interface AwsSdkClientConfig {
  region: string;
  credentials: AwsSdkCredentialIdentityProvider;
}

export interface AwsSdkWaiterConfig {
  /** Upper bound for one state wait; on expiry the provider re-reads and reports in-progress. */
  maxWaitTimeSec: number;
  minDelaySec: number;
  maxDelaySec: number;
}

export interface AwsSdkCredentialResolvers {
  /** Resolve an org-scoped ExternalId reference (D-001). Required for customer-role / local assume-role with externalIdRef. */
  resolveExternalId?: (externalIdRef: string) => Promise<string>;
  /** Mint the control plane's OIDC token for a hosted web-identity source. */
  getWebIdentityToken?: (input: { issuer: string; audience: string; subject: string }) => Promise<string>;
  /** The control-plane principal that starts a hosted role chain (defaults to the node provider chain). */
  controlPlaneCredentials?: AwsSdkCredentialIdentityProvider;
}

export interface AwsSdkWorkspaceHostClientOptions extends AwsSdkCredentialResolvers {
  /** The persisted AWS connection (see `buildAwsWorkspaceHostProviderConnection`). */
  connection: WorkspaceHostProviderConnection;
  /** Inject SDK clients (tests); defaults to real SDK v3 clients. */
  createClients?: (config: AwsSdkClientConfig) => AwsSdkClientSet;
  waiter?: Partial<AwsSdkWaiterConfig>;
  now?: () => string;
}

const DEFAULT_WAITER: AwsSdkWaiterConfig = { maxWaitTimeSec: 300, minDelaySec: 5, maxDelaySec: 20 };

// --- errors -----------------------------------------------------------------------------------

const RETRYABLE_ERROR_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ThrottlingException',
  'Throttling',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalError',
  'InternalFailure',
  'NetworkingError',
]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND']);
const ACCESS_DENIED_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnauthorizedAccess',
  'AuthFailure',
]);

/**
 * The ONLY error type this module throws for an AWS failure. Built from an allow-list of fields
 * with a scrubbed message and deliberately no `cause`: the SDK's own error objects can carry the
 * raw HTTP response, and credential-provider errors can quote profile material.
 */
export class AwsWorkspaceHostSdkError extends Error {
  readonly operation: string;
  readonly code?: string;
  readonly httpStatusCode?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly accessDenied: boolean;

  constructor(input: {
    operation: string;
    message: string;
    code?: string;
    httpStatusCode?: number;
    requestId?: string;
    retryable: boolean;
    accessDenied: boolean;
  }) {
    super(input.message);
    this.name = 'AwsWorkspaceHostSdkError';
    this.operation = input.operation;
    this.code = input.code;
    this.httpStatusCode = input.httpStatusCode;
    this.requestId = input.requestId;
    this.retryable = input.retryable;
    this.accessDenied = input.accessDenied;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Tracks every secret this module resolved so any error text quoting one can be redacted. */
class SecretRedactor {
  private readonly secrets = new Set<string>();

  remember(identity: AwsSdkCredentialIdentity): void {
    if (identity.secretAccessKey) this.secrets.add(identity.secretAccessKey);
    if (identity.sessionToken) this.secrets.add(identity.sessionToken);
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (secret.length >= 8) out = out.split(secret).join('[redacted]');
    }
    return out
      .replace(/(aws_secret_access_key|aws_session_token|secretAccessKey|sessionToken|SecretAccessKey|SessionToken)(["'\s:=]+)[^\s"',}]+/g, '$1$2[redacted]')
      .replace(/(x-amz-security-token(?:["'\s:=]+))[^\s"',}]+/gi, '$1[redacted]')
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-access-key-id]');
  }
}

function errorName(error: unknown): string | undefined {
  const r = record(error);
  return typeof r?.name === 'string' ? r.name : undefined;
}

function sanitizeError(error: unknown, operation: string, redactor: SecretRedactor): AwsWorkspaceHostSdkError {
  if (error instanceof AwsWorkspaceHostSdkError) return error;
  const r = record(error) ?? {};
  const metadata = record(r.$metadata);
  const name = typeof r.name === 'string' ? r.name : undefined;
  const sysCode = typeof r.code === 'string' ? r.code : undefined;
  const code = (typeof r.Code === 'string' ? r.Code : undefined) ?? name ?? sysCode;
  const httpStatusCode = typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
  const requestId = typeof metadata?.requestId === 'string' ? metadata.requestId : undefined;
  const rawMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
  const retryable =
    Boolean(r.$retryable) ||
    (httpStatusCode !== undefined && (httpStatusCode >= 500 || httpStatusCode === 429)) ||
    (name !== undefined && RETRYABLE_ERROR_NAMES.has(name)) ||
    (sysCode !== undefined && RETRYABLE_ERROR_CODES.has(sysCode));
  const accessDenied = (code !== undefined && ACCESS_DENIED_NAMES.has(code)) || httpStatusCode === 403;
  const message = redactor.scrub(
    `aws_workspace_host_${operation}_failed: ${code ?? 'Error'}: ${rawMessage}${requestId ? ` (request ${requestId})` : ''}`,
  );
  return new AwsWorkspaceHostSdkError({ operation, message, code, httpStatusCode, requestId, retryable, accessDenied });
}

function isNotFound(error: unknown, codes: readonly string[]): boolean {
  const r = record(error);
  const name = typeof r?.name === 'string' ? r.name : '';
  const code = typeof r?.Code === 'string' ? r.Code : '';
  return codes.includes(name) || codes.includes(code);
}

function abortError(operation: string): Error {
  const error = new Error(`aws_workspace_host_${operation}_aborted`);
  error.name = 'AbortError';
  return error;
}

// --- credentials --------------------------------------------------------------------------------

function memoizeCredentials(inner: AwsSdkCredentialIdentityProvider): AwsSdkCredentialIdentityProvider {
  let cached: AwsSdkCredentialIdentity | undefined;
  let pending: Promise<AwsSdkCredentialIdentity> | undefined;
  const fresh = (identity: AwsSdkCredentialIdentity): boolean =>
    !identity.expiration || identity.expiration.getTime() - Date.now() > 5 * 60_000;
  return (async (props?: Parameters<AwsSdkCredentialIdentityProvider>[0]) => {
    if (cached && fresh(cached)) return cached;
    pending ??= inner(props)
      .then((identity) => {
        cached = identity;
        return identity;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }) as AwsSdkCredentialIdentityProvider;
}

/** Defer construction of a provider whose parameters are themselves async (ExternalId, OIDC token). */
function lazyProvider(build: () => Promise<AwsSdkCredentialIdentityProvider>): AwsSdkCredentialIdentityProvider {
  let built: Promise<AwsSdkCredentialIdentityProvider> | undefined;
  return (async (props?: Parameters<AwsSdkCredentialIdentityProvider>[0]) => {
    built ??= build().catch((error) => {
      built = undefined;
      throw error;
    });
    return (await built)(props);
  }) as AwsSdkCredentialIdentityProvider;
}

async function resolveExternalId(
  resolvers: AwsSdkCredentialResolvers,
  externalIdRef: string,
): Promise<string> {
  if (!resolvers.resolveExternalId) throw new Error('aws_workspace_host_external_id_resolver_required');
  const externalId = (await resolvers.resolveExternalId(externalIdRef)).trim();
  if (!externalId) throw new Error('aws_workspace_host_external_id_empty');
  return externalId;
}

/**
 * Build the SDK v3 credential provider for a credential plan. Every hosted plan is a role chain
 * that starts from the control-plane principal (D-001); a local plan starts from the operator
 * host's own chain or named profile (`fromIni` resolves SSO, `credential_process`, and
 * console-login profiles).
 */
export function createAwsSdkCredentialProvider(
  plan: AwsSdkCredentialProviderPlan,
  region: string,
  resolvers: AwsSdkCredentialResolvers = {},
): AwsSdkCredentialIdentityProvider {
  const clientConfig = { region };
  const roleSessionName = plan.roleSessionName ?? DEFAULT_ROLE_SESSION_NAME;
  switch (plan.factory) {
    case 'defaultProvider':
      return fromNodeProviderChain({ clientConfig });
    case 'fromIni':
      return fromIni({ profile: plan.profile, clientConfig });
    case 'fromTemporaryCredentials': {
      const roleArn = plan.roleArn;
      if (!roleArn) throw new Error('aws_workspace_host_role_arn_required');
      if (plan.source === 'control-plane-role') {
        const principalArn = plan.hostedTrust?.principalArn;
        if (!principalArn) throw new Error('aws_workspace_host_trusted_principal_required');
        const externalIdRef = plan.externalIdRef;
        if (!externalIdRef) throw new Error('aws_workspace_host_external_id_ref_required');
        const controlPlane = resolvers.controlPlaneCredentials ?? fromNodeProviderChain({ clientConfig });
        return lazyProvider(async () => {
          const externalId = await resolveExternalId(resolvers, externalIdRef);
          const orgRole = fromTemporaryCredentials({
            params: { RoleArn: principalArn, RoleSessionName: ORG_ROLE_SESSION_NAME },
            masterCredentials: controlPlane,
            clientConfig,
          });
          return fromTemporaryCredentials({
            params: { RoleArn: roleArn, RoleSessionName: roleSessionName, ExternalId: externalId },
            masterCredentials: orgRole,
            clientConfig,
          });
        });
      }
      const source = plan.profile
        ? fromIni({ profile: plan.profile, clientConfig })
        : fromNodeProviderChain({ clientConfig });
      const externalIdRef = plan.externalIdRef;
      if (!externalIdRef) {
        return fromTemporaryCredentials({
          params: { RoleArn: roleArn, RoleSessionName: roleSessionName },
          masterCredentials: source,
          clientConfig,
        });
      }
      return lazyProvider(async () =>
        fromTemporaryCredentials({
          params: {
            RoleArn: roleArn,
            RoleSessionName: roleSessionName,
            ExternalId: await resolveExternalId(resolvers, externalIdRef),
          },
          masterCredentials: source,
          clientConfig,
        }),
      );
    }
    case 'fromWebToken': {
      const roleArn = plan.roleArn;
      const trust = plan.hostedTrust;
      if (!roleArn || !trust?.issuer || !trust.audience || !trust.subject) {
        throw new Error('aws_workspace_host_oidc_trust_incomplete');
      }
      const mint = resolvers.getWebIdentityToken;
      if (!mint) throw new Error('aws_workspace_host_web_identity_token_source_required');
      const trustInput = { issuer: trust.issuer, audience: trust.audience, subject: trust.subject };
      // A web-identity token is short-lived, so mint a fresh one per credential resolution.
      return (async (props?: Parameters<AwsSdkCredentialIdentityProvider>[0]) =>
        fromWebToken({
          roleArn,
          roleSessionName,
          webIdentityToken: await mint(trustInput),
          clientConfig,
        })(props)) as AwsSdkCredentialIdentityProvider;
    }
  }
}

function defaultCreateClients(config: AwsSdkClientConfig): AwsSdkClientSet {
  const base = { region: config.region, credentials: config.credentials };
  return {
    ec2: new EC2Client(base),
    ssm: new SSMClient(base),
    sts: new STSClient(base),
    iam: new IAMClient(base),
    kms: new KMSClient(base),
    serviceQuotas: new ServiceQuotasClient(base),
    pricing: new PricingClient(base),
  };
}

// --- connection binding --------------------------------------------------------------------------

interface AwsBoundConnection {
  accountId?: string;
  region: string;
  partition: AwsPartition;
  plan: AwsSdkCredentialProviderPlan;
  provider: Readonly<Record<string, unknown>>;
}

export function awsPartitionForRegion(region: string): AwsPartition {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('us-isob-')) return 'aws-iso-b';
  if (region.startsWith('us-iso-')) return 'aws-iso';
  if (region.startsWith('eu-isoe-')) return 'aws-iso-e';
  if (region.startsWith('us-isof-')) return 'aws-iso-f';
  return 'aws';
}

function pricingRegionFor(partition: AwsPartition): string | undefined {
  if (partition === 'aws') return 'us-east-1';
  if (partition === 'aws-cn') return 'cn-northwest-1';
  return undefined;
}

function bindConnection(connection: WorkspaceHostProviderConnection): AwsBoundConnection {
  if (connection.target !== AWS_WORKSPACE_HOST_TARGET) {
    throw new Error(`AWS SDK client cannot bind target '${connection.target}'`);
  }
  const provider = connection.provider ?? {};
  const region = typeof provider.region === 'string' ? provider.region.trim() : '';
  if (!region) throw new Error('aws_workspace_host_connection_region_required');
  const source = record(provider.credentialSource);
  if (!source) throw new Error('aws_workspace_host_connection_credential_source_required');
  const plan = planAwsSdkCredentialProvider(source as unknown as AwsWorkspaceHostCredentialSource);
  const partition =
    typeof provider.partition === 'string' ? (provider.partition as AwsPartition) : awsPartitionForRegion(region);
  if (connection.scope && connection.scope.kind !== 'account') {
    throw new Error(`AWS connection scope must be an account, not '${connection.scope.kind}'`);
  }
  return { accountId: connection.scope?.id, region, partition, plan, provider };
}

// --- mapping helpers ------------------------------------------------------------------------------

function mutableTags(tags: readonly AwsTag[]): { Key: string; Value: string }[] {
  return tags.map((tag) => ({ Key: tag.Key, Value: tag.Value }));
}

function withClientTokenTag(tags: readonly AwsTag[], clientToken: string): { Key: string; Value: string }[] {
  return [
    ...mutableTags(tags.filter((tag) => tag.Key !== AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG)),
    { Key: AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG, Value: clientToken },
  ];
}

const INSTANCE_STATES = new Set<AwsEc2InstanceState>([
  'pending',
  'running',
  'stopping',
  'stopped',
  'shutting-down',
  'terminated',
]);
const VOLUME_STATES = new Set<AwsEbsVolumeState>(['creating', 'available', 'in-use', 'deleting', 'deleted', 'error']);

type StatusValue = NonNullable<AwsInstanceObservation['instanceStatus']>;
function statusValue(value: string | undefined): StatusValue | undefined {
  return value === 'ok' || value === 'impaired' || value === 'initializing' || value === 'insufficient-data'
    ? value
    : undefined;
}

function architectureOf(value: string | undefined): string | undefined {
  return value === 'x86_64' || value === 'arm64' ? value : undefined;
}

interface PriceDimension {
  unit: string;
  usd: number;
}

/** On-demand USD price dimensions of one AWS Price List product (a JSON document per item). */
function priceDimensionsUsd(priceItem: unknown): PriceDimension[] {
  const parsed = record(typeof priceItem === 'string' ? JSON.parse(priceItem) : JSON.parse(String(priceItem)));
  const onDemand = record(record(parsed?.terms)?.OnDemand) ?? {};
  const out: PriceDimension[] = [];
  for (const term of Object.values(onDemand)) {
    for (const dimension of Object.values(record(record(term)?.priceDimensions) ?? {})) {
      const d = record(dimension);
      const usd = Number(record(d?.pricePerUnit)?.USD);
      if (Number.isFinite(usd) && usd > 0 && typeof d?.unit === 'string') out.push({ unit: d.unit, usd });
    }
  }
  return out;
}

// --- the seam client ------------------------------------------------------------------------------

class AwsSdkWorkspaceHostClient implements AwsWorkspaceHostSdkClient {
  private readonly bound: AwsBoundConnection;
  private readonly redactor = new SecretRedactor();
  private readonly credentials: AwsSdkCredentialIdentityProvider;
  private readonly createClients: (config: AwsSdkClientConfig) => AwsSdkClientSet;
  private readonly regional = new Map<string, AwsSdkClientSet>();
  private readonly waiter: AwsSdkWaiterConfig;
  private readonly now: () => string;
  private accountCheck?: Promise<AwsCallerIdentityEvidence>;

  constructor(options: AwsSdkWorkspaceHostClientOptions) {
    this.bound = bindConnection(options.connection);
    const inner = memoizeCredentials(
      createAwsSdkCredentialProvider(this.bound.plan, this.bound.region, {
        resolveExternalId: options.resolveExternalId,
        getWebIdentityToken: options.getWebIdentityToken,
        controlPlaneCredentials: options.controlPlaneCredentials,
      }),
    );
    this.credentials = (async (props?: Parameters<AwsSdkCredentialIdentityProvider>[0]) => {
      const identity = await inner(props);
      this.redactor.remember(identity);
      return identity;
    }) as AwsSdkCredentialIdentityProvider;
    this.createClients = options.createClients ?? defaultCreateClients;
    this.waiter = { ...DEFAULT_WAITER, ...options.waiter };
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private clients(region = this.bound.region): AwsSdkClientSet {
    let set = this.regional.get(region);
    if (!set) {
      set = this.createClients({ region, credentials: this.credentials });
      this.regional.set(region, set);
    }
    return set;
  }

  private get ec2(): EC2Client {
    return this.clients().ec2;
  }

  /** Run one SDK call; any failure leaves this module only as a scrubbed AwsWorkspaceHostSdkError. */
  private async call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw sanitizeError(error, operation, this.redactor);
    }
  }

  private assertSameAccount(connection: WorkspaceHostProviderConnection | WorkspaceHostCatalogQuery['scope']): void {
    const scope = 'target' in connection ? connection.scope : connection;
    if ('target' in connection && connection.target !== AWS_WORKSPACE_HOST_TARGET) {
      throw new Error(`AWS SDK client cannot serve target '${connection.target}'`);
    }
    if (scope && this.bound.accountId && scope.id !== this.bound.accountId) {
      throw new Error(`AWS SDK client is bound to account '${this.bound.accountId}', not '${scope.id}'`);
    }
  }

  private async callerIdentity(): Promise<AwsCallerIdentityEvidence> {
    const result = await this.call('get-caller-identity', () =>
      this.clients().sts.send(new GetCallerIdentityCommand({})),
    );
    if (!result.Account || !result.Arn) throw new Error('aws_workspace_host_caller_identity_incomplete');
    return {
      accountId: result.Account,
      arn: result.Arn,
      userId: result.UserId ?? '',
      evidenceRef: `aws:sts:GetCallerIdentity:${result.$metadata.requestId ?? 'unknown'}`,
    };
  }

  /** Mutations refuse to run until the resolved identity is proven to be the connection's account. */
  private async assertMutationAccount(): Promise<void> {
    if (!this.bound.accountId) return;
    this.accountCheck ??= this.callerIdentity().catch((error) => {
      this.accountCheck = undefined;
      throw error;
    });
    const identity = await this.accountCheck;
    if (identity.accountId !== this.bound.accountId) {
      throw new Error(
        `aws_workspace_host_account_mismatch: credentials resolve to account '${identity.accountId}', connection names '${this.bound.accountId}'`,
      );
    }
  }

  async validateConnection(connection: WorkspaceHostProviderConnection): Promise<WorkspaceHostConnectionValidation> {
    this.assertSameAccount(connection);
    const checkedAt = this.now();
    try {
      const identity = await this.callerIdentity();
      const errors =
        this.bound.accountId && identity.accountId !== this.bound.accountId
          ? [`Credentials resolve to AWS account ${identity.accountId}, not ${this.bound.accountId}.`]
          : [];
      return { ok: errors.length === 0, checkedAt, identity: identity.arn, warnings: [], errors };
    } catch (error) {
      const sanitized = sanitizeError(error, 'validate-connection', this.redactor);
      return {
        ok: false,
        checkedAt,
        warnings: [],
        errors: [sanitized.message],
        retryable: sanitized.retryable,
      };
    }
  }

  async listScopes(connection: WorkspaceHostProviderConnection): Promise<readonly WorkspaceHostScope[]> {
    this.assertSameAccount(connection);
    const identity = await this.callerIdentity();
    return [{ kind: 'account', id: identity.accountId, label: `AWS account ${identity.accountId}` }];
  }

  async listRegions(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostRegion[]> {
    this.assertSameAccount(connection);
    this.assertSameAccount(query.scope);
    const result = await this.call('describe-regions', () =>
      this.ec2.send(new DescribeRegionsCommand({ AllRegions: true })),
    );
    const zones = query.region ? await this.listZones(query.region) : undefined;
    return (result.Regions ?? [])
      .filter((region) => region.RegionName)
      .map((region) => {
        const id = region.RegionName!;
        const available = region.OptInStatus !== 'not-opted-in';
        return {
          id,
          label: id,
          available,
          ...(zones && id === query.region ? { zones } : {}),
          ...(available ? {} : { constraints: ['Region requires account opt-in'] }),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private async listZones(region: string): Promise<readonly string[]> {
    const result = await this.call('describe-availability-zones', () =>
      this.clients(region).ec2.send(
        new DescribeAvailabilityZonesCommand({
          Filters: [
            { Name: 'state', Values: ['available'] },
            { Name: 'zone-type', Values: ['availability-zone'] },
          ],
        }),
      ),
    );
    return (result.AvailabilityZones ?? [])
      .map((zone) => zone.ZoneName)
      .filter((name): name is string => Boolean(name))
      .sort();
  }

  async listSizes(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostSize[]> {
    this.assertSameAccount(connection);
    this.assertSameAccount(query.scope);
    const ec2 = this.clients(query.region ?? this.bound.region).ec2;
    const filters = [
      { Name: 'current-generation', Values: ['true'] },
      { Name: 'bare-metal', Values: ['false'] },
      ...(query.architecture ? [{ Name: 'processor-info.supported-architecture', Values: [query.architecture] }] : []),
    ];
    const infos: InstanceTypeInfo[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.call('describe-instance-types', () =>
        ec2.send(new DescribeInstanceTypesCommand({ Filters: filters, MaxResults: 100, NextToken: nextToken })),
      );
      infos.push(...(page.InstanceTypes ?? []));
      nextToken = page.NextToken;
    } while (nextToken);
    const sizes: WorkspaceHostSize[] = [];
    for (const info of infos) {
      const id = info.InstanceType;
      const cpuCount = info.VCpuInfo?.DefaultVCpus;
      const memoryMiB = info.MemoryInfo?.SizeInMiB;
      if (!id || !cpuCount || !memoryMiB) continue;
      const architectures = (info.ProcessorInfo?.SupportedArchitectures ?? [])
        .map((arch) => architectureOf(arch))
        .filter((arch): arch is string => Boolean(arch));
      sizes.push({
        id,
        label: `${id} (${cpuCount} vCPU, ${Math.round(memoryMiB / 1024)} GiB)`,
        cpuCount,
        memoryMiB,
        architectures,
        available: true,
      });
    }
    return sizes.sort((left, right) => left.cpuCount - right.cpuCount || left.memoryMiB - right.memoryMiB || left.id.localeCompare(right.id));
  }

  async listImages(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostImage[]> {
    this.assertSameAccount(connection);
    this.assertSameAccount(query.scope);
    const ec2 = this.clients(query.region ?? this.bound.region).ec2;
    const filters = [
      { Name: 'state', Values: ['available'] },
      { Name: 'tag:papercusp:managed', Values: ['true'] },
      ...(query.architecture ? [{ Name: 'architecture', Values: [query.architecture] }] : []),
    ];
    const [owned, shared] = await Promise.all([
      this.call('describe-images', () => ec2.send(new DescribeImagesCommand({ Owners: ['self'], Filters: filters }))),
      this.call('describe-images', () =>
        ec2.send(new DescribeImagesCommand({ ExecutableUsers: ['self'], Filters: filters })),
      ),
    ]);
    const byId = new Map<string, Image>();
    for (const image of [...(owned.Images ?? []), ...(shared.Images ?? [])]) {
      if (image.ImageId) byId.set(image.ImageId, image);
    }
    return [...byId.values()]
      .map((image) => {
        const tags = new Map((image.Tags ?? []).map((tag) => [tag.Key ?? '', tag.Value ?? '']));
        const version = tags.get('papercusp:image-version');
        const architecture = architectureOf(image.Architecture);
        return {
          id: image.ImageId!,
          ...(version ? { version } : {}),
          label: image.Name ?? image.ImageId!,
          ...(architecture ? { architecture } : {}),
          // Only an AMI produced by the release pipeline carries its signed release digest.
          signed: Boolean(tags.get('papercusp:release-sha256')),
          ...(image.CreationDate ? { publishedAt: image.CreationDate } : {}),
          ...(image.DeprecationTime ? { deprecated: Date.parse(image.DeprecationTime) <= Date.now() } : {}),
        };
      })
      .sort((left, right) => (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '') || left.id.localeCompare(right.id));
  }

  async estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    connection: WorkspaceHostProviderConnection,
  ): Promise<WorkspaceHostPriceEstimate> {
    this.assertSameAccount(connection);
    const observedAt = this.now();
    const pricingRegion = pricingRegionFor(awsPartitionForRegion(desired.region));
    if (!pricingRegion) {
      return {
        currency: 'USD',
        hourlyAmount: 0,
        observedAt,
        confidence: 'unknown',
        lineItems: [{ kind: 'provider-pricing', description: `AWS Price List is unavailable for ${desired.region}`, hourlyAmount: 0 }],
      };
    }
    const provider = desired.provider ?? {};
    const volumeType = typeof provider.volumeType === 'string' ? provider.volumeType : 'gp3';
    const rootGiB = typeof provider.rootVolumeGiB === 'number' ? provider.rootVolumeGiB : 20;
    const pricing = this.clients(pricingRegion).pricing;
    const [compute, storage] = await Promise.all([
      this.call('get-products', () =>
        pricing.send(
          new GetProductsCommand({
            ServiceCode: 'AmazonEC2',
            MaxResults: 10,
            Filters: [
              { Type: 'TERM_MATCH', Field: 'instanceType', Value: desired.size },
              { Type: 'TERM_MATCH', Field: 'regionCode', Value: desired.region },
              { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
              { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
              { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
              { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
              { Type: 'TERM_MATCH', Field: 'licenseModel', Value: 'No License required' },
            ],
          }),
        ),
      ),
      this.call('get-products', () =>
        pricing.send(
          new GetProductsCommand({
            ServiceCode: 'AmazonEC2',
            MaxResults: 10,
            Filters: [
              { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' },
              { Type: 'TERM_MATCH', Field: 'volumeApiName', Value: volumeType },
              { Type: 'TERM_MATCH', Field: 'regionCode', Value: desired.region },
            ],
          }),
        ),
      ),
    ]);
    const dimensions = (items: readonly unknown[] | undefined): PriceDimension[] =>
      (items ?? []).flatMap((item) => priceDimensionsUsd(item));
    const hourly = dimensions(compute.PriceList).find((d) => d.unit === 'Hrs')?.usd;
    const gbMonth = dimensions(storage.PriceList).find((d) => d.unit === 'GB-Mo')?.usd;
    const lineItems: WorkspaceHostPriceLineItem[] = [];
    if (hourly !== undefined) {
      lineItems.push({ kind: 'compute', description: `${desired.size} on-demand Linux in ${desired.region}`, hourlyAmount: hourly });
    }
    const storageGiB = rootGiB + desired.data.volumeGiB;
    if (gbMonth !== undefined) {
      lineItems.push({
        kind: 'storage',
        description: `${storageGiB} GiB ${volumeType} EBS (root ${rootGiB} + data ${desired.data.volumeGiB})`,
        hourlyAmount: (gbMonth * storageGiB) / HOURS_PER_MONTH,
      });
    }
    const hourlyAmount = lineItems.reduce((sum, item) => sum + item.hourlyAmount, 0);
    const complete = hourly !== undefined && gbMonth !== undefined;
    return {
      currency: 'USD',
      hourlyAmount,
      monthlyAmount: hourlyAmount * HOURS_PER_MONTH,
      observedAt,
      confidence: complete ? 'estimated' : 'unknown',
      lineItems,
    };
  }

  // --- volumes ---

  private volumeObservation(volume: Volume): AwsVolumeObservation | undefined {
    if (!volume.VolumeId) return undefined;
    const state = VOLUME_STATES.has(volume.State as AwsEbsVolumeState) ? (volume.State as AwsEbsVolumeState) : undefined;
    if (!state) throw new Error(`aws_workspace_host_volume_state_unknown: ${String(volume.State)}`);
    const attached = (volume.Attachments ?? []).find((a) => a.State === 'attached' || a.State === 'attaching');
    return {
      volumeId: volume.VolumeId,
      state,
      ...(attached?.InstanceId ? { attachedInstanceId: attached.InstanceId } : {}),
      observedAt: this.now(),
    };
  }

  async createVolume(input: AwsCreateVolumeInput): Promise<AwsCreatedVolume> {
    await this.assertMutationAccount();
    const result = await this.call('create-volume', () =>
      this.ec2.send(
        new CreateVolumeCommand({
          AvailabilityZone: input.AvailabilityZone,
          ClientToken: input.ClientToken,
          Encrypted: input.Encrypted,
          KmsKeyId: input.KmsKeyId,
          Size: input.Size,
          VolumeType: input.VolumeType as Volume['VolumeType'],
          TagSpecifications: [
            {
              ResourceType: 'volume',
              Tags: withClientTokenTag(input.TagSpecifications[0].Tags, input.ClientToken),
            },
          ],
        }),
      ),
    );
    if (!result.VolumeId) throw new Error('aws_workspace_host_create_volume_returned_no_id');
    return { volumeId: result.VolumeId, requestId: result.$metadata.requestId };
  }

  async findVolumeByClientToken(clientToken: string): Promise<AwsVolumeObservation | undefined> {
    const result = await this.call('describe-volumes', () =>
      this.ec2.send(
        new DescribeVolumesCommand({
          Filters: [{ Name: `tag:${AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG}`, Values: [clientToken] }],
        }),
      ),
    );
    const observations = (result.Volumes ?? []).map((volume) => this.volumeObservation(volume)).filter(Boolean);
    return (observations.find((o) => o!.state !== 'deleted' && o!.state !== 'deleting') ?? observations[0]) || undefined;
  }

  async describeVolume(volumeId: string): Promise<AwsVolumeObservation | undefined> {
    try {
      const result = await this.ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
      const volume = result.Volumes?.[0];
      return volume ? this.volumeObservation(volume) : undefined;
    } catch (error) {
      if (isNotFound(error, ['InvalidVolume.NotFound'])) return undefined;
      throw sanitizeError(error, 'describe-volume', this.redactor);
    }
  }

  async waitForVolumeState(
    volumeId: string,
    state: 'available' | 'in-use' | 'deleted',
    signal?: AbortSignal,
  ): Promise<AwsVolumeObservation | undefined> {
    const waiter =
      state === 'available' ? waitUntilVolumeAvailable : state === 'in-use' ? waitUntilVolumeInUse : waitUntilVolumeDeleted;
    await this.runWaiter('wait-volume', signal, (config) => waiter({ ...config, client: this.ec2 }, { VolumeIds: [volumeId] }));
    const observed = await this.describeVolume(volumeId);
    if (observed?.state === 'error') throw new Error(`aws_workspace_host_volume_failed: ${volumeId} entered state 'error'`);
    return observed;
  }

  async deleteVolume(volumeId: string): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    try {
      const result = await this.ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
      return { requestId: result.$metadata.requestId };
    } catch (error) {
      // Already gone is the desired end state of a confirmed destroy; the provider re-reads to confirm.
      if (isNotFound(error, ['InvalidVolume.NotFound'])) return {};
      throw sanitizeError(error, 'delete-volume', this.redactor);
    }
  }

  // --- instances ---

  async runInstances(input: AwsRunInstancesInput): Promise<AwsCreatedInstance> {
    await this.assertMutationAccount();
    const nic = input.NetworkInterfaces[0];
    const disk = input.BlockDeviceMappings[0];
    const result = await this.call('run-instances', () =>
      this.ec2.send(
        new RunInstancesCommand({
          ClientToken: input.ClientToken,
          MinCount: input.MinCount,
          MaxCount: input.MaxCount,
          LaunchTemplate: { ...input.LaunchTemplate },
          NetworkInterfaces: [
            {
              DeviceIndex: nic.DeviceIndex,
              SubnetId: nic.SubnetId,
              Groups: [...nic.Groups],
              DeleteOnTermination: nic.DeleteOnTermination,
            },
          ],
          IamInstanceProfile: { Arn: input.IamInstanceProfile.Arn },
          BlockDeviceMappings: [
            {
              DeviceName: disk.DeviceName,
              Ebs: {
                DeleteOnTermination: disk.Ebs.DeleteOnTermination,
                Encrypted: disk.Ebs.Encrypted,
                KmsKeyId: disk.Ebs.KmsKeyId,
                VolumeSize: disk.Ebs.VolumeSize,
                VolumeType: disk.Ebs.VolumeType as Volume['VolumeType'],
              },
            },
          ],
          TagSpecifications: input.TagSpecifications.map((spec) => ({
            ResourceType: spec.ResourceType,
            Tags: mutableTags(spec.Tags),
          })),
          ...(input.UserData ? { UserData: input.UserData } : {}),
        }),
      ),
    );
    const instances = result.Instances ?? [];
    if (instances.length !== 1 || !instances[0]?.InstanceId) {
      throw new Error(`aws_workspace_host_run_instances_expected_one: EC2 returned ${instances.length} instances`);
    }
    return { instanceId: instances[0].InstanceId, requestId: result.$metadata.requestId };
  }

  async findInstanceByClientToken(clientToken: string): Promise<AwsInstanceObservation | undefined> {
    const result = await this.call('describe-instances', () =>
      this.ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: 'client-token', Values: [clientToken] }] })),
    );
    const instances = (result.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []);
    const live = instances.find((instance) => instance.State?.Name !== 'terminated') ?? instances[0];
    return live?.InstanceId ? this.instanceObservation(live) : undefined;
  }

  async describeInstance(instanceId: string): Promise<AwsInstanceObservation | undefined> {
    let instance: Instance | undefined;
    try {
      const result = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      instance = result.Reservations?.flatMap((reservation) => reservation.Instances ?? [])[0];
    } catch (error) {
      if (isNotFound(error, ['InvalidInstanceID.NotFound'])) return undefined;
      throw sanitizeError(error, 'describe-instance', this.redactor);
    }
    return instance?.InstanceId ? this.instanceObservation(instance) : undefined;
  }

  /** Enrich the authoritative EC2 state with status checks and SSM reachability (unmeasured, never false, when not permitted). */
  private async instanceObservation(instance: Instance): Promise<AwsInstanceObservation> {
    const instanceId = instance.InstanceId!;
    const stateName = instance.State?.Name as AwsEc2InstanceState | undefined;
    if (!stateName || !INSTANCE_STATES.has(stateName)) {
      throw new Error(`aws_workspace_host_instance_state_unknown: ${String(stateName)}`);
    }
    const attachedVolumeIds = (instance.BlockDeviceMappings ?? [])
      .map((mapping) => mapping.Ebs?.VolumeId)
      .filter((id): id is string => Boolean(id))
      .sort();
    const observation: AwsInstanceObservation = {
      instanceId,
      state: stateName,
      ...(instance.ImageId ? { imageId: instance.ImageId } : {}),
      attachedVolumeIds,
      observedAt: this.now(),
    };
    if (stateName !== 'running') return observation;
    const [status, ssm] = await Promise.all([
      this.optionalRead('describe-instance-status', () =>
        this.ec2.send(new DescribeInstanceStatusCommand({ InstanceIds: [instanceId], IncludeAllInstances: true })),
      ),
      this.optionalRead('describe-instance-information', () =>
        this.clients().ssm.send(
          new DescribeInstanceInformationCommand({ Filters: [{ Key: 'InstanceIds', Values: [instanceId] }] }),
        ),
      ),
    ]);
    const statusEntry = status?.InstanceStatuses?.find((entry) => entry.InstanceId === instanceId);
    const instanceStatus = statusValue(statusEntry?.InstanceStatus?.Status);
    const systemStatus = statusValue(statusEntry?.SystemStatus?.Status);
    return {
      ...observation,
      ...(instanceStatus ? { instanceStatus } : {}),
      ...(systemStatus ? { systemStatus } : {}),
      ...(ssm
        ? {
            ssmOnline: (ssm.InstanceInformationList ?? []).some(
              (entry) => entry.InstanceId === instanceId && entry.PingStatus === 'Online',
            ),
          }
        : {}),
    };
  }

  /** An enrichment read the role may not be granted: access denied means NOT MEASURED; anything else surfaces. */
  private async optionalRead<T>(operation: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      const sanitized = sanitizeError(error, operation, this.redactor);
      if (sanitized.accessDenied) return undefined;
      throw sanitized;
    }
  }

  private async runWaiter(
    operation: string,
    signal: AbortSignal | undefined,
    wait: (config: { maxWaitTime: number; minDelay: number; maxDelay: number; abortSignal?: AbortSignal }) => Promise<unknown>,
  ): Promise<void> {
    if (signal?.aborted) throw abortError(operation);
    try {
      await wait({
        maxWaitTime: this.waiter.maxWaitTimeSec,
        minDelay: this.waiter.minDelaySec,
        maxDelay: this.waiter.maxDelaySec,
        ...(signal ? { abortSignal: signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted || errorName(error) === 'AbortError') throw abortError(operation);
      // A waiter TIMEOUT or FAILURE acceptor is a verdict about the state, not an API error: the
      // caller's fresh describe decides applied vs in-progress and surfaces any real API failure.
      if (errorName(error) === 'TimeoutError') return;
      if (error instanceof Error && /^\{"state":"(FAILURE|RETRY)"/.test(error.message)) return;
      throw sanitizeError(error, operation, this.redactor);
    }
  }

  async waitForInstanceState(
    instanceId: string,
    state: 'running' | 'stopped' | 'terminated',
    signal?: AbortSignal,
  ): Promise<AwsInstanceObservation | undefined> {
    const waiter =
      state === 'running' ? waitUntilInstanceRunning : state === 'stopped' ? waitUntilInstanceStopped : waitUntilInstanceTerminated;
    await this.runWaiter('wait-instance', signal, (config) =>
      waiter({ ...config, client: this.ec2 }, { InstanceIds: [instanceId] }),
    );
    return this.describeInstance(instanceId);
  }

  async attachVolume(input: { InstanceId: string; VolumeId: string; Device: string }): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    const result = await this.call('attach-volume', () =>
      this.ec2.send(new AttachVolumeCommand({ InstanceId: input.InstanceId, VolumeId: input.VolumeId, Device: input.Device })),
    );
    return { requestId: result.$metadata.requestId };
  }

  async startInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    const result = await this.call('start-instances', () =>
      this.ec2.send(new StartInstancesCommand({ InstanceIds: [...instanceIds] })),
    );
    return { requestId: result.$metadata.requestId };
  }

  async stopInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    const result = await this.call('stop-instances', () =>
      this.ec2.send(new StopInstancesCommand({ InstanceIds: [...instanceIds] })),
    );
    return { requestId: result.$metadata.requestId };
  }

  async rebootInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    const result = await this.call('reboot-instances', () =>
      this.ec2.send(new RebootInstancesCommand({ InstanceIds: [...instanceIds] })),
    );
    return { requestId: result.$metadata.requestId };
  }

  /**
   * EC2 has no in-place repair verb. A stop/start cycle moves an EBS-backed instance onto new
   * underlying hardware, which is AWS's documented remedy for a failed system status check.
   */
  async repairInstance(instanceId: string): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    const current = await this.describeInstance(instanceId);
    if (!current || current.state === 'terminated' || current.state === 'shutting-down') {
      throw new Error(`aws_workspace_host_repair_instance_absent: ${instanceId}`);
    }
    if (current.state !== 'stopped') {
      await this.call('stop-instances', () => this.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] })));
      const stopped = await this.waitForInstanceState(instanceId, 'stopped');
      if (stopped?.state !== 'stopped') {
        throw new Error(`aws_workspace_host_repair_stop_incomplete: ${instanceId} is '${stopped?.state ?? 'absent'}'`);
      }
    }
    const started = await this.call('start-instances', () =>
      this.ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] })),
    );
    return { requestId: started.$metadata.requestId };
  }

  async terminateInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult> {
    await this.assertMutationAccount();
    try {
      const result = await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [...instanceIds] }));
      return { requestId: result.$metadata.requestId };
    } catch (error) {
      if (isNotFound(error, ['InvalidInstanceID.NotFound'])) return {};
      throw sanitizeError(error, 'terminate-instances', this.redactor);
    }
  }

  // --- snapshots ---

  private snapshotObservation(snapshot: Snapshot): AwsSnapshotObservation | undefined {
    if (!snapshot.SnapshotId) return undefined;
    const state = snapshot.State === 'completed' ? 'completed' : snapshot.State === 'error' ? 'error' : 'pending';
    return { snapshotId: snapshot.SnapshotId, state, observedAt: this.now() };
  }

  async createSnapshot(input: AwsCreateSnapshotInput): Promise<AwsCreatedSnapshot> {
    await this.assertMutationAccount();
    // CreateSnapshot has no ClientToken parameter: retry idempotency is find-by-tag first.
    const existing = await this.findSnapshotByClientToken(input.ClientToken);
    if (existing && existing.state !== 'error' && existing.state !== 'deleted') {
      return { snapshotId: existing.snapshotId };
    }
    const result = await this.call('create-snapshot', () =>
      this.ec2.send(
        new CreateSnapshotCommand({
          VolumeId: input.VolumeId,
          Description: input.Description,
          TagSpecifications: [
            {
              ResourceType: 'snapshot',
              Tags: withClientTokenTag(input.TagSpecifications[0].Tags, input.ClientToken),
            },
          ],
        }),
      ),
    );
    if (!result.SnapshotId) throw new Error('aws_workspace_host_create_snapshot_returned_no_id');
    return { snapshotId: result.SnapshotId, requestId: result.$metadata.requestId };
  }

  async findSnapshotByClientToken(clientToken: string): Promise<AwsSnapshotObservation | undefined> {
    const result = await this.call('describe-snapshots', () =>
      this.ec2.send(
        new DescribeSnapshotsCommand({
          OwnerIds: ['self'],
          Filters: [{ Name: `tag:${AWS_WORKSPACE_HOST_CLIENT_TOKEN_TAG}`, Values: [clientToken] }],
        }),
      ),
    );
    const observations = (result.Snapshots ?? [])
      .map((snapshot) => this.snapshotObservation(snapshot))
      .filter((o): o is AwsSnapshotObservation => Boolean(o));
    return observations.find((o) => o.state !== 'error') ?? observations[0];
  }

  async waitForSnapshotCompleted(snapshotId: string, signal?: AbortSignal): Promise<AwsSnapshotObservation> {
    await this.runWaiter('wait-snapshot', signal, (config) =>
      waitUntilSnapshotCompleted({ ...config, client: this.ec2 }, { SnapshotIds: [snapshotId], OwnerIds: ['self'] }),
    );
    const result = await this.call('describe-snapshots', () =>
      this.ec2.send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId], OwnerIds: ['self'] })),
    );
    const observed = result.Snapshots?.[0] ? this.snapshotObservation(result.Snapshots[0]) : undefined;
    if (!observed) throw new Error(`aws_workspace_host_snapshot_absent: ${snapshotId}`);
    return observed;
  }

  // --- preflight (shares credentials, clients and error discipline) ---

  preflight(): AwsWorkspaceHostPreflightClient {
    return {
      getCallerIdentity: () => this.callerIdentity(),
      describeRegion: (region) => this.preflightRegion(region),
      describeSubnet: (subnetId) => this.preflightSubnet(subnetId),
      describeImage: (imageId) => this.preflightImage(imageId),
      describeKmsKey: (kmsKeyArn) => this.preflightKmsKey(kmsKeyArn),
      evaluatePermissions: (request) => this.preflightPermissions(request),
      getServiceQuota: (requirement) => this.preflightQuota(requirement),
    };
  }

  private async preflightRegion(region: string): Promise<AwsRegionEvidence> {
    const result = await this.call('describe-regions', () =>
      this.ec2.send(new DescribeRegionsCommand({ AllRegions: true, RegionNames: [region] })),
    );
    const found = result.Regions?.find((entry) => entry.RegionName === region);
    return {
      id: found?.RegionName ?? region,
      partition: awsPartitionForRegion(region),
      available: Boolean(found) && found?.OptInStatus !== 'not-opted-in',
      ...(found?.OptInStatus ? { optInStatus: found.OptInStatus } : {}),
      evidenceRef: `aws:ec2:DescribeRegions:${result.$metadata.requestId ?? 'unknown'}`,
    };
  }

  private async preflightSubnet(subnetId: string): Promise<AwsSubnetEvidence> {
    const result = await this.call('describe-subnets', () =>
      this.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] })),
    );
    const subnet = result.Subnets?.[0];
    if (!subnet?.SubnetId) throw new Error(`aws_workspace_host_subnet_absent: ${subnetId}`);
    const zone = subnet.AvailabilityZone ?? '';
    return {
      id: subnet.SubnetId,
      region: zone ? zone.replace(/[a-z]$/, '') : this.bound.region,
      availabilityZone: zone,
      vpcId: subnet.VpcId ?? '',
      available: subnet.State === 'available',
      evidenceRef: `aws:ec2:DescribeSubnets:${result.$metadata.requestId ?? 'unknown'}`,
    };
  }

  private async preflightImage(imageId: string): Promise<AwsImageEvidence> {
    const result = await this.call('describe-images', () =>
      this.ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] })),
    );
    const image = result.Images?.[0];
    if (!image?.ImageId) throw new Error(`aws_workspace_host_image_absent: ${imageId}`);
    const architecture = architectureOf(image.Architecture);
    return {
      id: image.ImageId,
      ownerId: image.OwnerId ?? '',
      state: image.State ?? 'unknown',
      ...(architecture ? { architecture } : {}),
      // DescribeImages only returns an AMI this account can see: owned, public, or shared to it.
      launchAllowed: true,
      evidenceRef: `aws:ec2:DescribeImages:${result.$metadata.requestId ?? 'unknown'}`,
    };
  }

  private async preflightKmsKey(kmsKeyArn: string): Promise<AwsKmsKeyEvidence> {
    const result = await this.call('describe-key', () =>
      this.clients().kms.send(new DescribeKeyCommand({ KeyId: kmsKeyArn })),
    );
    const key = result.KeyMetadata;
    if (!key?.Arn) throw new Error('aws_workspace_host_kms_key_absent');
    const arnRegion = /^arn:[^:]+:kms:([^:]+):/.exec(key.Arn)?.[1] ?? this.bound.region;
    return {
      arn: key.Arn,
      partition: awsPartitionForRegion(arnRegion),
      region: arnRegion,
      enabled: key.Enabled === true && key.KeyState === 'Enabled',
      symmetric: key.KeySpec === 'SYMMETRIC_DEFAULT',
      evidenceRef: `aws:kms:DescribeKey:${result.$metadata.requestId ?? 'unknown'}`,
    };
  }

  /** IAM `SimulatePrincipalPolicy` against the resolved principal (an assumed role is simulated as its role). */
  private async preflightPermissions(
    request: AwsWorkspaceHostPermissionRequest,
  ): Promise<readonly AwsWorkspaceHostPermissionEvidence[]> {
    const identity = await this.callerIdentity();
    const principalArn = await this.simulationPrincipal(identity.arn);
    const evidence: AwsWorkspaceHostPermissionEvidence[] = [];
    let marker: string | undefined;
    do {
      const page = await this.call('simulate-principal-policy', () =>
        this.clients().iam.send(
          new SimulatePrincipalPolicyCommand({
            PolicySourceArn: principalArn,
            ActionNames: [...request.actions],
            Marker: marker,
          }),
        ),
      );
      for (const result of page.EvaluationResults ?? []) {
        if (!result.EvalActionName) continue;
        const allowed = result.EvalDecision === 'allowed';
        evidence.push({
          action: result.EvalActionName as AwsWorkspaceHostPermissionAction,
          allowed,
          evidenceRef: `aws:iam:SimulatePrincipalPolicy:${page.$metadata.requestId ?? 'unknown'}`,
          ...(allowed ? {} : { reason: result.EvalDecision ?? 'implicitDeny' }),
        });
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    return evidence;
  }

  private async simulationPrincipal(callerArn: string): Promise<string> {
    const assumed = /^arn:([^:]+):sts::(\d{12}):assumed-role\/([^/]+)\//.exec(callerArn);
    if (!assumed) return callerArn;
    // The STS session ARN drops the role's IAM path (SSO roles live under /aws-reserved/...),
    // so read the role to recover the exact ARN IAM simulates against.
    const role = await this.call('get-role', () =>
      this.clients().iam.send(new GetRoleCommand({ RoleName: assumed[3] })),
    );
    return role.Role?.Arn ?? `arn:${assumed[1]}:iam::${assumed[2]}:role/${assumed[3]}`;
  }

  private async preflightQuota(requirement: AwsWorkspaceHostQuotaRequirement): Promise<AwsWorkspaceHostQuotaEvidence> {
    const input = { ServiceCode: requirement.serviceCode, QuotaCode: requirement.quotaCode };
    let value: number | undefined;
    let requestId: string | undefined;
    try {
      const result = await this.clients().serviceQuotas.send(new GetServiceQuotaCommand(input));
      value = result.Quota?.Value;
      requestId = result.$metadata.requestId;
    } catch (error) {
      if (!isNotFound(error, ['NoSuchResourceException'])) throw sanitizeError(error, 'get-service-quota', this.redactor);
      const fallback = await this.call('get-aws-default-service-quota', () =>
        this.clients().serviceQuotas.send(new GetAWSDefaultServiceQuotaCommand(input)),
      );
      value = fallback.Quota?.Value;
      requestId = fallback.$metadata.requestId;
    }
    if (value === undefined) throw new Error(`aws_workspace_host_quota_unreadable: ${requirement.label}`);
    return { ...requirement, value, evidenceRef: `aws:service-quotas:GetServiceQuota:${requestId ?? 'unknown'}` };
  }
}

/** The production AWS SDK v3 seam client for one persisted AWS connection. */
export function createAwsSdkWorkspaceHostClient(options: AwsSdkWorkspaceHostClientOptions): AwsWorkspaceHostSdkClient & {
  preflight(): AwsWorkspaceHostPreflightClient;
} {
  return new AwsSdkWorkspaceHostClient(options);
}
