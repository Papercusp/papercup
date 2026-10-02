/**
 * aws-ami-canary-measure — the pure logic of papercusp-aws-ami-clean-account-canary
 * (WI-10005604). Everything that decides what the proof SAYS lives here, with every cloud call
 * injected through `deps`, so the launch → SSM → bootstrap → teardown → residue-census flow
 * (including teardown on every failure path) is unit-tested without an AWS account.
 *
 * TRUST RULE (same as papercusp-gcp-clean-room): every boolean in the proof is an OBSERVED
 * value read back from AWS or from the host's own attestation. `terminated` and
 * `residualResourceIds` come from the teardown's real outcome plus a tag census, so a leaked
 * instance, volume or ENI can never be reported as a clean run.
 */
import { createHash } from 'node:crypto';

import { ToolError, fail } from './gcp-ephemeral.mjs';

export const AWS_AMI_CANARY_TOOL = 'papercusp-aws-ami-clean-account-canary';
/** Must match WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX in @papercusp/deployment-driver. */
export const ATTESTATION_PREFIX = 'PAPERCUSP_WORKSPACE_HOST_ATTESTATION=';
/** The role AWS Organizations creates in every member account made by CreateAccount. */
export const DEFAULT_CANARY_ROLE_NAME = 'OrganizationAccountAccessRole';
export const CANARY_RUN_TAG = 'papercusp:ami-canary-run';
export const CANARY_FIXTURE_TAG = 'papercusp:ami-canary-fixture';
export const CANARY_RUN_DIR = '/run/papercusp-ami-canary';
/** base64 characters per SSM SendCommand upload; keeps each command well under SSM's size cap. */
export const SSM_CHUNK_CHARS = 32_000;
export const CANARY_BUDGETS = Object.freeze({
  runningMs: 10 * 60_000,
  ssmOnlineMs: 15 * 60_000,
  bootstrapMs: 25 * 60_000,
  shortCommandMs: 3 * 60_000,
  terminateMs: 10 * 60_000,
  pollMs: 10_000,
});
const SSM_TERMINAL = new Set(['Success', 'Failed', 'TimedOut', 'Cancelled', 'Undeliverable', 'Terminated']);

const ACCOUNT_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/;
const SUBNET_RE = /^subnet-[0-9a-f]{8,17}$/;
const AMI_RE = /^ami-[0-9a-f]{8,17}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PROFILE_RE = /^arn:aws(?:-[a-z-]+)?:iam::(\d{12}):instance-profile\/[\w+=,.@/-]+$/;
const ROLE_RE = /^arn:aws(?:-[a-z-]+)?:iam::(\d{12}):role\/[\w+=,.@/-]+$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;

function text(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function matching(value, re, path) {
  const out = text(value, path);
  if (!re.test(out)) fail(`${path} is malformed: ${out}`);
  return out;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Validate and bind the stdin payload. The fixture's script is content-addressed: it must
 * hash to its own advertised digest BEFORE anything is launched, and the fixture must belong
 * to the exact release and manifest the proof will claim.
 */
export function parseAwsAmiCanaryInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('canary input must be a JSON object');
  const accountId = matching(raw.accountId, ACCOUNT_RE, 'accountId');
  const instanceProfileArn = matching(raw.instanceProfileArn, PROFILE_RE, 'instanceProfileArn');
  if (PROFILE_RE.exec(instanceProfileArn)[1] !== accountId) {
    fail('instanceProfileArn must live in the clean account (accountId)');
  }
  const input = {
    accountId,
    region: matching(raw.region, REGION_RE, 'region'),
    subnetId: matching(raw.subnetId, SUBNET_RE, 'subnetId'),
    instanceProfileArn,
    imageId: matching(raw.imageId, AMI_RE, 'imageId'),
    releaseVersion: text(raw.releaseVersion, 'releaseVersion'),
    releaseSha256: matching(raw.releaseSha256, SHA256_RE, 'releaseSha256'),
    buildManifestIdentity: text(raw.buildManifestIdentity, 'buildManifestIdentity'),
  };
  const fixture = raw.fixture;
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) fail('fixture is required');
  // Exact, never trimmed: the digest is over the script's exact bytes (EI-21748220731961334).
  if (typeof fixture.bootstrapScript !== 'string' || !fixture.bootstrapScript) {
    fail('fixture.bootstrapScript must be a non-empty string');
  }
  const bootstrapScriptSha256 = matching(fixture.bootstrapScriptSha256, SHA256_RE, 'fixture.bootstrapScriptSha256');
  if (sha256Hex(fixture.bootstrapScript) !== bootstrapScriptSha256) {
    fail('fixture.bootstrapScript does not match fixture.bootstrapScriptSha256');
  }
  if (fixture.manifestIdentity !== input.buildManifestIdentity) {
    fail('fixture.manifestIdentity does not match buildManifestIdentity');
  }
  if (fixture.image?.version !== input.releaseVersion) fail('fixture.image.version does not match releaseVersion');
  const service = fixture.bootstrapInput?.service;
  const serviceName = matching(service?.name, SERVICE_RE, 'fixture.bootstrapInput.service.name');
  return {
    ...input,
    fixture: {
      fixtureId: text(fixture.fixtureId, 'fixture.fixtureId'),
      bootstrapScript: fixture.bootstrapScript,
      bootstrapScriptSha256,
      serviceName,
    },
  };
}

function partitionFor(region) {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}

/** The role the publisher assumes INTO the clean account; an override must stay in that account. */
export function canaryRoleArn(accountId, region, env = {}) {
  const override = env.PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN?.trim();
  if (override) {
    const match = ROLE_RE.exec(override);
    if (!match) fail(`PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN is malformed: ${override}`);
    if (match[1] !== accountId) fail('PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN must be a role in the clean account');
    return override;
  }
  const name = env.PAPERCUSP_AWS_AMI_CANARY_ROLE_NAME?.trim() || DEFAULT_CANARY_ROLE_NAME;
  if (!/^[\w+=,.@-]+$/.test(name)) fail(`PAPERCUSP_AWS_AMI_CANARY_ROLE_NAME is malformed: ${name}`);
  return `arn:${partitionFor(region)}:iam::${accountId}:role/${name}`;
}

export function instanceTypeFor(architecture, env = {}) {
  const override = env.PAPERCUSP_AWS_AMI_CANARY_INSTANCE_TYPE?.trim();
  if (override) return override;
  if (architecture === 'x86_64') return 't3.medium';
  if (architecture === 'arm64') return 't4g.medium';
  fail(`no default canary instance type for AMI architecture ${String(architecture)}`);
}

export function canaryTags(input, runId) {
  return [
    { Key: 'Name', Value: `pc-ami-canary-${runId}` },
    { Key: CANARY_RUN_TAG, Value: runId },
    { Key: CANARY_FIXTURE_TAG, Value: input.fixture.fixtureId.slice(0, 255) },
  ];
}

/**
 * The SSM command plan. The script travels as base64 in bounded chunks (each upload is one
 * SendCommand), is re-verified against its digest ON the host, and runs with its full output
 * captured to a file. That matters because GetCommandInvocation truncates stdout, while the
 * attestation marker is the LAST line, so it is read back by a separate grep, never from the
 * run's own stdout.
 */
export function ssmScriptPlan(fixture, chunkChars = SSM_CHUNK_CHARS) {
  const b64 = Buffer.from(fixture.bootstrapScript, 'utf8').toString('base64');
  const uploads = [];
  for (let offset = 0; offset < b64.length; offset += chunkChars) {
    const chunk = b64.slice(offset, offset + chunkChars);
    uploads.push(
      offset === 0
        ? ['set -eu', `install -d -m 0700 ${CANARY_RUN_DIR}`, `: > ${CANARY_RUN_DIR}/script.b64`, `printf '%s' '${chunk}' >> ${CANARY_RUN_DIR}/script.b64`]
        : ['set -eu', `printf '%s' '${chunk}' >> ${CANARY_RUN_DIR}/script.b64`],
    );
  }
  return {
    uploads,
    run: [
      'set -eu',
      `base64 -d ${CANARY_RUN_DIR}/script.b64 > ${CANARY_RUN_DIR}/bootstrap.sh`,
      `echo '${fixture.bootstrapScriptSha256}  ${CANARY_RUN_DIR}/bootstrap.sh' | sha256sum -c -`,
      'set +e',
      `bash ${CANARY_RUN_DIR}/bootstrap.sh > ${CANARY_RUN_DIR}/out.log 2>&1`,
      'rc=$?',
      `tail -c 3000 ${CANARY_RUN_DIR}/out.log`,
      'echo "PAPERCUSP_CANARY_BOOTSTRAP_EXIT=$rc"',
      'exit $rc',
    ],
    readAttestation: [`grep '^${ATTESTATION_PREFIX}' ${CANARY_RUN_DIR}/out.log | tail -n 1`],
    serviceCheck: [`systemctl is-active ${fixture.serviceName}`],
  };
}

/** Decode the attestation marker; a missing or undecodable marker is a hard failure. */
export function extractAttestation(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  let encoded;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(ATTESTATION_PREFIX)) {
      encoded = lines[index].slice(ATTESTATION_PREFIX.length).trim();
      break;
    }
  }
  if (!encoded) fail('bootstrap produced no attestation marker; the AMI did not self-attest');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    fail(`bootstrap attestation was not base64 JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('bootstrap attestation is not an object');
  return parsed;
}

async function waitFor(deps, budgetMs, pollMs, label, probe, done) {
  const deadline = deps.now() + budgetMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (deps.now() >= deadline) fail(`${label} did not happen within ${Math.round(budgetMs / 1000)}s`, { last: value ?? null });
    await deps.sleep(pollMs);
  }
}

async function runSsm(deps, instanceId, commands, budgetMs, pollMs, label) {
  const commandId = await deps.sendCommand({ instanceId, commands, executionTimeoutSec: Math.ceil(budgetMs / 1000) });
  const result = await waitFor(
    deps,
    budgetMs + 2 * pollMs,
    pollMs,
    `SSM ${label}`,
    () => deps.getInvocation({ commandId, instanceId }),
    (invocation) => Boolean(invocation && SSM_TERMINAL.has(invocation.status)),
  );
  return { commandId, ...result };
}

function requireSsmSuccess(result, label) {
  if (result.status !== 'Success') {
    fail(`SSM ${label} ended ${result.status}`, {
      commandId: result.commandId,
      responseCode: result.responseCode ?? null,
      stdoutTail: String(result.stdout ?? '').slice(-2000),
      stderrTail: String(result.stderr ?? '').slice(-2000),
    });
  }
  return result;
}

/**
 * Launch the shared AMI privately in the clean account, prove SSM + bootstrap + service, then
 * tear down and census. `deps` (all async unless noted):
 *   callerAccount() → account id of the assumed clean-account identity
 *   describeImage(imageId) → { state, architecture } | null
 *   describeSubnet(subnetId) → { subnetId, vpcId } | null
 *   runInstance({ imageId, subnetId, instanceProfileArn, instanceType, tags }) → instanceId
 *   describeInstance(instanceId) → { state, publicIpv4, stateReason } (state 'pending' while unknown)
 *   ssmPingStatus(instanceId) → 'Online' | 'ConnectionLost' | 'Inactive' | null
 *   sendCommand({ instanceId, commands, executionTimeoutSec }) → commandId
 *   getInvocation({ commandId, instanceId }) → { status, stdout, stderr, responseCode } | null
 *   terminate(instanceId)
 *   censusByRunTag(runId) → string[] of non-terminal resources still carrying the run tag
 *   now() → epoch ms (sync); sleep(ms); runId() → short hex (sync)
 */
export async function runAwsAmiCleanAccountCanary(input, deps, env = {}, budgets = CANARY_BUDGETS) {
  const runId = deps.runId();
  const account = await deps.callerAccount();
  if (account !== input.accountId) {
    fail(`assumed identity is in account ${account}, not the clean account ${input.accountId}`);
  }
  const image = await deps.describeImage(input.imageId);
  if (!image) fail(`AMI ${input.imageId} is not visible to the clean account (share missing?)`);
  if (image.state !== 'available') fail(`AMI ${input.imageId} is ${image.state}, not available`);
  if (!(await deps.describeSubnet(input.subnetId))) fail(`subnet ${input.subnetId} is not in the clean account/region`);
  const instanceType = instanceTypeFor(image.architecture, env);

  const observed = {
    instanceId: null,
    publicIpv4Assigned: false,
    ssmOnline: false,
    attestation: null,
    serviceHealthy: false,
    terminated: false,
    residualResourceIds: [],
    teardownErrors: [],
  };
  let failure = null;
  try {
    observed.instanceId = await deps.runInstance({
      imageId: input.imageId,
      subnetId: input.subnetId,
      instanceProfileArn: input.instanceProfileArn,
      instanceType,
      tags: canaryTags(input, runId),
    });
    const instanceId = observed.instanceId;
    const running = await waitFor(deps, budgets.runningMs, budgets.pollMs, 'instance running', () => deps.describeInstance(instanceId), (i) => {
      if (i && (i.state === 'shutting-down' || i.state === 'terminated' || i.state === 'stopped')) {
        fail(`canary instance ${instanceId} went ${i.state} before running`, { stateReason: i.stateReason ?? null });
      }
      return i?.state === 'running';
    });
    observed.publicIpv4Assigned = Boolean(running.publicIpv4);
    if (observed.publicIpv4Assigned) fail(`canary instance ${instanceId} was assigned public IPv4 ${running.publicIpv4}`);
    await waitFor(deps, budgets.ssmOnlineMs, budgets.pollMs, 'SSM agent Online', () => deps.ssmPingStatus(instanceId), (s) => s === 'Online');
    observed.ssmOnline = true;

    const plan = ssmScriptPlan(input.fixture);
    for (const [index, commands] of plan.uploads.entries()) {
      requireSsmSuccess(await runSsm(deps, instanceId, commands, budgets.shortCommandMs, budgets.pollMs, `upload ${index + 1}/${plan.uploads.length}`), 'script upload');
    }
    requireSsmSuccess(await runSsm(deps, instanceId, plan.run, budgets.bootstrapMs, budgets.pollMs, 'bootstrap'), 'bootstrap');
    const marker = requireSsmSuccess(await runSsm(deps, instanceId, plan.readAttestation, budgets.shortCommandMs, budgets.pollMs, 'attestation read'), 'attestation read');
    observed.attestation = extractAttestation(marker.stdout);
    const service = await runSsm(deps, instanceId, plan.serviceCheck, budgets.shortCommandMs, budgets.pollMs, 'service check');
    observed.serviceHealthy = service.status === 'Success' && String(service.stdout ?? '').trim() === 'active';
  } catch (error) {
    failure = error;
  } finally {
    if (observed.instanceId) {
      const instanceId = observed.instanceId;
      try {
        await deps.terminate(instanceId);
        const final = await waitFor(deps, budgets.terminateMs, budgets.pollMs, 'instance terminated', () => deps.describeInstance(instanceId), (i) => i?.state === 'terminated');
        observed.terminated = final.state === 'terminated';
      } catch (error) {
        observed.teardownErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const leftover = await deps.censusByRunTag(runId);
      observed.residualResourceIds = [...new Set([...(observed.instanceId && !observed.terminated ? [observed.instanceId] : []), ...leftover])].sort();
    } catch (error) {
      observed.teardownErrors.push(`residue census failed: ${error instanceof Error ? error.message : String(error)}`);
      // An unmeasured census can never read as zero residue.
      observed.residualResourceIds = [`census-unmeasured:${runId}`];
    }
  }
  if (failure) {
    const details = {
      ...(failure instanceof ToolError && failure.details ? failure.details : {}),
      runId,
      instanceId: observed.instanceId,
      terminated: observed.terminated,
      residualResourceIds: observed.residualResourceIds,
      teardownErrors: observed.teardownErrors,
    };
    throw new ToolError(failure instanceof Error ? failure.message : String(failure), details);
  }
  return { runId, ...observed };
}

/** The AwsAmiCleanAccountLaunchProof (aws-ami-release.ts), bound to the exact request. */
export function buildAwsAmiCanaryProof(input, observed, observedAt) {
  const evidenceRef = `aws-ami-canary:${observed.instanceId}:${sha256Hex(
    `${input.accountId}|${input.region}|${input.imageId}|${input.buildManifestIdentity}|${input.fixture.fixtureId}|${observedAt}`,
  ).slice(0, 32)}`;
  return {
    evidenceRef,
    accountId: input.accountId,
    region: input.region,
    imageId: input.imageId,
    buildManifestIdentity: input.buildManifestIdentity,
    releaseVersion: input.releaseVersion,
    releaseSha256: input.releaseSha256,
    ssmOnline: observed.ssmOnline,
    bootstrapAttestationHealthy: observed.attestation?.status === 'healthy',
    serviceHealthy: observed.serviceHealthy,
    publicIpv4Assigned: observed.publicIpv4Assigned,
    terminated: observed.terminated,
    residualResourceIds: observed.residualResourceIds,
    observedAt,
    fixtureId: input.fixture.fixtureId,
    attestation: observed.attestation,
  };
}
