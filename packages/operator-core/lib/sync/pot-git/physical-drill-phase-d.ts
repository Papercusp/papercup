/**
 * Fixed production-spine adapter for P-505 physical Phase D / P-305.
 *
 * The checked-in scenario drives the canonical `git-sync:run` action. This
 * module contributes only fixed, run-bound mutations and observations around
 * that action: a below-steer worktree head, the real integration-request row
 * and ratification helper, signed staging-advance rows on both physical hosts,
 * and the real worktree-bridge cursor/refs/worktree state. It does not run a
 * second integrator or bridge and exposes no caller-selected command, repo, or
 * worktree path.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { projectDirForSlug } from '../../operator-notes';
import {
  listIntegrationRequests,
  ratifyIntegrationRequest,
  type IntegrationRequest,
} from './integration-requests';
import { STAGING_REF } from './integrator';
import {
  STAGING_ADVANCE_EVENT_KEY,
  compareEpochSeq,
  isSignedStagingAdvance,
  verifyStagingAdvance,
  type SignedStagingAdvance,
} from './staging-advance';
import { defaultRunGit, deviceNamespaceKey, hiveGitRepoPath } from './storage';
import { WORKTREE_STAGING_REF } from './worktree-bridge';
import { PHASE_A_POT_HOME, PHASE_A_REPO_KEY } from './physical-drill-phase-a';

export const PHASE_D_INPUT_SCHEMA = 'hive-git-physical-phase-d-input/v1' as const;
export const PHASE_D_RESULT_SCHEMA = 'hive-git-physical-phase-d-result/v1' as const;
export const PHASE_D_MUTATION_SCHEMA = 'hive-git-physical-phase-d-mutation/v1' as const;
export const PHASE_D_OBSERVATION_SCHEMA = 'hive-git-physical-phase-d-observation/v1' as const;
export const PHASE_D_EVENT_SCHEMA = 'hive-git-physical-phase-d-event/v1' as const;
export const PHASE_D_RATIFICATION_SCHEMA = 'hive-git-physical-phase-d-ratification/v1' as const;
export const PHASE_D_PLAN_ITEM = 'P-305' as const;
export const PHASE_D_WORKSPACE = 'papercusp-workspace' as const;
export const PHASE_D_SENTINEL = 'p505-phase-d-overlap.txt' as const;

const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type PhysicalPhaseDHost = 'tower' | 'vm';
export type PhysicalPhaseDMutationKind = 'below-steer' | 'dirty-overlap';
export type PhysicalPhaseDObservationStage = 'first-source' | 'first-destination' | 'dirty-before' | 'dirty-after';

export type PhysicalPhaseDMutation = {
  schemaVersion: typeof PHASE_D_MUTATION_SCHEMA;
  runId: string;
  kind: PhysicalPhaseDMutationKind;
  sourceHost: PhysicalPhaseDHost;
  sourceDeviceKey: string;
  method: 'fixed-worktree-commit';
  worktreePath: string;
  protectedPath: typeof PHASE_D_SENTINEL;
  baseOid: string;
  headOid: string;
  payloadSha256: string;
  createdAt: string;
};

export type PhysicalPhaseDTrigger = {
  tool: 'git-sync:run';
  installSlug: typeof PHASE_A_POT_HOME;
  host: PhysicalPhaseDHost;
  role:
    | 'below-steer-publish'
    | 'queue-receive'
    | 'ratified-integrate'
    | 'first-bridge'
    | 'dirty-integrate'
    | 'dirty-bridge';
  fired: true;
  startedAt: string;
  finishedAt: string;
};

export type PhysicalPhaseDRatification = {
  schemaVersion: typeof PHASE_D_RATIFICATION_SCHEMA;
  tool: 'ratifyIntegrationRequest';
  accepted: true;
  observedAt: string;
  pending: IntegrationRequest;
  ratified: IntegrationRequest;
};

export type PhysicalPhaseDEvent = {
  schemaVersion: typeof PHASE_D_EVENT_SCHEMA;
  hostId: PhysicalPhaseDHost;
  rowId: number;
  observedAt: string;
  key: typeof STAGING_ADVANCE_EVENT_KEY;
  source: 'git-sync-integrator';
  repoKey: typeof PHASE_A_REPO_KEY;
  payload: SignedStagingAdvance;
};

export type PhysicalPhaseDObservation = {
  schemaVersion: typeof PHASE_D_OBSERVATION_SCHEMA;
  hostId: PhysicalPhaseDHost;
  runId: string;
  stage: PhysicalPhaseDObservationStage;
  observedAt: string;
  repoPath: string;
  worktreePath: string;
  integratorDeviceKey: string;
  integratorNamespaceStagingOid: string | null;
  canonicalStagingOid: string | null;
  worktreeHeadOid: string;
  dirtyPaths: string[];
  protectedPath: typeof PHASE_D_SENTINEL;
  protectedFileSha256: string | null;
  cursor: {
    lastEventId: number;
    epochSeq: { epoch: number; seq: number } | null;
    stagingSha: string | null;
  };
};

export type PhysicalPhaseDAdvance = {
  integratorTrigger: PhysicalPhaseDTrigger;
  sourceEvent: PhysicalPhaseDEvent;
  destinationEvent: PhysicalPhaseDEvent;
  destinationTrigger: PhysicalPhaseDTrigger;
};

export type PhysicalPhaseDInput = {
  schemaVersion: typeof PHASE_D_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  belowSteer: {
    mutation: PhysicalPhaseDMutation;
    publishTrigger: PhysicalPhaseDTrigger;
    queueTrigger: PhysicalPhaseDTrigger;
    pendingReceipt: IntegrationRequest;
    ratification: PhysicalPhaseDRatification;
  };
  firstAdvance: PhysicalPhaseDAdvance & {
    sourceObservation: PhysicalPhaseDObservation;
    destinationObservation: PhysicalPhaseDObservation;
  };
  dirtyAdvance: PhysicalPhaseDAdvance & {
    mutation: PhysicalPhaseDMutation;
    dirtyBefore: PhysicalPhaseDObservation;
    dirtyAfter: PhysicalPhaseDObservation;
  };
};

export type PhysicalPhaseDVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_D_RESULT_SCHEMA;
    phase: 'D';
    planItem: typeof PHASE_D_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      freshBelowSteerHeadQueuedWithVisibleReceipt: true;
      exactRequestRatifiedThroughProductionSurface: true;
      productionGitSyncPublishedSignedCanonicalStaging: true;
      signedAdvanceFederatedToOtherPhysicalHost: true;
      otherPhysicalHostFastForwardedCanonicalAndWorktree: true;
      secondOverlappingAdvanceMovedMirrorAndCursor: true;
      dirtyWorktreeAndProtectedFileRemainedUntouched: true;
    };
    oids: { firstStaging: string; secondStaging: string };
    cursor: { firstEventId: number; secondEventId: number };
  };
};

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

type PhysicalPhaseDDeps = {
  repoPath?: string;
  worktreePath?: string;
  sql?: OrgSql;
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase D runId is invalid: ${runId}`);
}

function assertDeviceKey(deviceKey: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(deviceKey) || Buffer.from(deviceKey, 'base64').length !== 32) {
    throw new Error('physical Phase D requires a raw 32-byte Ed25519 device key in base64');
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await defaultRunGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(`physical Phase D git ${args.join(' ')} failed for ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function fixedPaths(deps: PhysicalPhaseDDeps = {}): Promise<{ repoPath: string; worktreePath: string }> {
  const repoPath = deps.repoPath ?? hiveGitRepoPath(PHASE_A_POT_HOME, PHASE_A_REPO_KEY);
  const worktreePath = deps.worktreePath ?? (await projectDirForSlug(PHASE_A_POT_HOME));
  if (!worktreePath) throw new Error(`physical Phase D cannot resolve fixed worktree ${PHASE_A_POT_HOME}`);
  if (!isAbsolute(repoPath) || !isAbsolute(worktreePath)) {
    throw new Error('physical Phase D fixed repo and worktree paths must be absolute');
  }
  if (!deps.repoPath) {
    const suffix = join(PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
    if (!resolve(repoPath).endsWith(suffix)) throw new Error(`physical Phase D repo path must target ${suffix}`);
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`physical Phase D fixed bare repo is missing: ${repoPath}`);
  }
  if (!existsSync(worktreePath) || !statSync(worktreePath).isDirectory()) {
    throw new Error(`physical Phase D fixed worktree is missing: ${worktreePath}`);
  }
  if ((await git(repoPath, ['rev-parse', '--is-bare-repository'])) !== 'true') {
    throw new Error(`physical Phase D target is not a bare repo: ${repoPath}`);
  }
  if ((await git(worktreePath, ['rev-parse', '--is-inside-work-tree'])) !== 'true') {
    throw new Error(`physical Phase D target is not a worktree: ${worktreePath}`);
  }
  return { repoPath, worktreePath };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Create one fixed canary worktree commit. No caller-selected path or command. */
export async function createPhysicalPhaseDMutation(
  input: {
    runId: string;
    kind: PhysicalPhaseDMutationKind;
    sourceHost: PhysicalPhaseDHost;
    sourceDeviceKey: string;
  },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDMutation> {
  assertRunId(input.runId);
  assertDeviceKey(input.sourceDeviceKey);
  const { worktreePath } = await fixedPaths(deps);
  const status = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error('physical Phase D refuses to create a mutation in a dirty fixed worktree');
  const baseOid = await git(worktreePath, ['rev-parse', 'HEAD^{commit}']);
  const payload = `p505-phase-d/${input.runId}/${input.kind}\n`;
  const protectedPath = join(worktreePath, PHASE_D_SENTINEL);
  writeFileSync(protectedPath, payload, { flag: input.kind === 'below-steer' ? 'wx' : 'w', mode: 0o600 });
  await git(worktreePath, ['add', '--', PHASE_D_SENTINEL]);
  await git(worktreePath, [
    '-c',
    'user.name=p505-phase-d',
    '-c',
    'user.email=p505-phase-d@papercusp.invalid',
    'commit',
    '-q',
    '-m',
    `P-505 Phase D ${input.kind} ${input.runId}`,
    '--',
    PHASE_D_SENTINEL,
  ]);
  const headOid = await git(worktreePath, ['rev-parse', 'HEAD^{commit}']);
  if (!OID.test(baseOid) || !OID.test(headOid) || baseOid === headOid) {
    throw new Error('physical Phase D failed to create a fresh worktree commit');
  }
  return {
    schemaVersion: PHASE_D_MUTATION_SCHEMA,
    runId: input.runId,
    kind: input.kind,
    sourceHost: input.sourceHost,
    sourceDeviceKey: input.sourceDeviceKey,
    method: 'fixed-worktree-commit',
    worktreePath,
    protectedPath: PHASE_D_SENTINEL,
    baseOid,
    headOid,
    payloadSha256: sha256(payload),
    createdAt: new Date().toISOString(),
  };
}

/** Make the fixed overlap file dirty without staging or committing it. */
export async function dirtyPhysicalPhaseDWorktree(
  input: { runId: string },
  deps: PhysicalPhaseDDeps = {},
): Promise<{ runId: string; protectedPath: typeof PHASE_D_SENTINEL; sha256: string; observedAt: string }> {
  assertRunId(input.runId);
  const { worktreePath } = await fixedPaths(deps);
  const before = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (before) throw new Error('physical Phase D refuses to dirty an already-dirty fixed worktree');
  const payload = `p505-phase-d/${input.runId}/local-dirty-must-survive\n`;
  writeFileSync(join(worktreePath, PHASE_D_SENTINEL), payload, { flag: 'w', mode: 0o600 });
  const after = await git(worktreePath, ['status', '--porcelain=v1', '--', PHASE_D_SENTINEL]);
  if (!after) throw new Error('physical Phase D failed to make the fixed overlap file dirty');
  return {
    runId: input.runId,
    protectedPath: PHASE_D_SENTINEL,
    sha256: sha256(payload),
    observedAt: new Date().toISOString(),
  };
}

/** Read the exact production request row for the run-bound head. */
export async function capturePhysicalPhaseDRequest(
  input: { devicePubkey: string; headSha: string; state: 'pending' | 'ratified' },
  deps: PhysicalPhaseDDeps = {},
): Promise<IntegrationRequest> {
  const rows = await listIntegrationRequests(
    {
      workspaceId: PHASE_D_WORKSPACE,
      potSlug: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      devicePubkey: input.devicePubkey,
      state: input.state,
      limit: 100,
    },
    deps.sql,
  );
  const exact = rows.filter((row) => row.headSha === input.headSha);
  if (exact.length !== 1) {
    throw new Error(`physical Phase D expected exactly one ${input.state} request for the run-bound head`);
  }
  return exact[0]!;
}

/** Ratify exactly the visible pending row through the production helper. */
export async function ratifyPhysicalPhaseDRequest(
  input: { devicePubkey: string; headSha: string },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDRatification> {
  const pending = await capturePhysicalPhaseDRequest({ ...input, state: 'pending' }, deps);
  const accepted = await ratifyIntegrationRequest(
    {
      workspaceId: PHASE_D_WORKSPACE,
      potSlug: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      devicePubkey: input.devicePubkey,
      headSha: input.headSha,
    },
    deps.sql,
  );
  if (!accepted) throw new Error('physical Phase D production ratification did not update the exact pending row');
  const ratified = await capturePhysicalPhaseDRequest({ ...input, state: 'ratified' }, deps);
  return {
    schemaVersion: PHASE_D_RATIFICATION_SCHEMA,
    tool: 'ratifyIntegrationRequest',
    accepted: true,
    observedAt: new Date().toISOString(),
    pending,
    ratified,
  };
}

/** Read a cryptographically valid staging event from this host's production fed-event log. */
export async function capturePhysicalPhaseDEvent(
  input: {
    hostId: PhysicalPhaseDHost;
    afterRowId: number;
    integratorDeviceKey: string;
    stagingSha: string;
  },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDEvent> {
  const sql = deps.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ id: number; observed_at: string; body: Record<string, unknown> }>>`
    SELECT id, ts::text AS observed_at, body
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${PHASE_D_WORKSPACE}
       AND harness_slug = ${PHASE_A_POT_HOME}
       AND surface = 'messages'
       AND id > ${input.afterRowId}
       AND body->'fed_event'->>'key' = ${STAGING_ADVANCE_EVENT_KEY}
       AND body->'fed_event'->>'repo_key' = ${PHASE_A_REPO_KEY}
     ORDER BY id ASC
     LIMIT 200
  `;
  const matches = rows.flatMap((row) => {
    const fed = row.body?.fed_event as Record<string, unknown> | undefined;
    const payload = fed?.payload;
    if (
      fed?.source !== 'git-sync-integrator' ||
      !isSignedStagingAdvance(payload) ||
      payload.device_pubkey !== input.integratorDeviceKey ||
      payload.staging_sha !== input.stagingSha ||
      !verifyStagingAdvance(payload, input.integratorDeviceKey)
    ) {
      return [];
    }
    return [{ row, payload }];
  });
  if (matches.length !== 1) {
    throw new Error('physical Phase D expected exactly one signed production staging event for the run-bound head');
  }
  const match = matches[0]!;
  return {
    schemaVersion: PHASE_D_EVENT_SCHEMA,
    hostId: input.hostId,
    rowId: match.row.id,
    observedAt: new Date(match.row.observed_at).toISOString(),
    key: STAGING_ADVANCE_EVENT_KEY,
    source: 'git-sync-integrator',
    repoKey: PHASE_A_REPO_KEY,
    payload: match.payload,
  };
}

async function loadCursor(sql: OrgSql): Promise<PhysicalPhaseDObservation['cursor']> {
  const rows = await sql<
    Array<{
      worktree_bridge: {
        lastEventId?: number;
        epochSeq?: { epoch: number; seq: number } | null;
        stagingSha?: string | null;
      } | null;
    }>
  >`
    SELECT metadata->'worktree_bridge' AS worktree_bridge
      FROM harness_shared.routines
     WHERE workspace_id = ${PHASE_D_WORKSPACE}
       AND install_slug = ${PHASE_A_POT_HOME}
       AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  const cursor = rows[0]?.worktree_bridge;
  return {
    lastEventId: cursor?.lastEventId ?? 0,
    epochSeq: cursor?.epochSeq ?? null,
    stagingSha: cursor?.stagingSha ?? null,
  };
}

/** Capture fixed Git + bridge cursor state without accepting caller paths. */
export async function capturePhysicalPhaseDObservation(
  input: {
    hostId: PhysicalPhaseDHost;
    runId: string;
    stage: PhysicalPhaseDObservationStage;
    integratorDeviceKey: string;
  },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDObservation> {
  assertRunId(input.runId);
  assertDeviceKey(input.integratorDeviceKey);
  const { repoPath, worktreePath } = await fixedPaths(deps);
  const namespace = deviceNamespaceKey(input.integratorDeviceKey);
  const rev = async (cwd: string, ref: string): Promise<string | null> => {
    const result = await defaultRunGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd);
    return result.code === 0 ? result.stdout.trim() || null : null;
  };
  const status = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const dirtyPaths = status
    ? status
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3).split(' -> ').at(-1)!)
        .sort()
    : [];
  const protectedFile = join(worktreePath, PHASE_D_SENTINEL);
  return {
    schemaVersion: PHASE_D_OBSERVATION_SCHEMA,
    hostId: input.hostId,
    runId: input.runId,
    stage: input.stage,
    observedAt: new Date().toISOString(),
    repoPath,
    worktreePath,
    integratorDeviceKey: input.integratorDeviceKey,
    integratorNamespaceStagingOid: await rev(repoPath, `refs/namespaces/${namespace}/${STAGING_REF}`),
    canonicalStagingOid: await rev(repoPath, WORKTREE_STAGING_REF),
    worktreeHeadOid: (await rev(worktreePath, 'HEAD')) ?? '',
    dirtyPaths,
    protectedPath: PHASE_D_SENTINEL,
    protectedFileSha256: existsSync(protectedFile) ? sha256(readFileSync(protectedFile)) : null,
    cursor: await loadCursor(deps.sql ?? getOrgPg().sql),
  };
}

function time(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function sameRequest(a: IntegrationRequest, b: IntegrationRequest): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.potSlug === b.potSlug &&
    a.repoKey === b.repoKey &&
    a.devicePubkey === b.devicePubkey &&
    a.headSha === b.headSha &&
    a.authorGithubUserId === b.authorGithubUserId &&
    a.reason === b.reason &&
    a.createdTs === b.createdTs
  );
}

function validateTrigger(
  trigger: PhysicalPhaseDTrigger,
  expected: { host: PhysicalPhaseDHost; role: PhysicalPhaseDTrigger['role'] },
  window: { startedAt: number; finishedAt: number },
  errors: string[],
): void {
  const label = `Phase D ${expected.role}`;
  if (
    trigger.tool !== 'git-sync:run' ||
    trigger.installSlug !== PHASE_A_POT_HOME ||
    trigger.host !== expected.host ||
    trigger.role !== expected.role ||
    trigger.fired !== true
  ) {
    errors.push(`${label} must be the fixed production git-sync trigger`);
  }
  const startedAt = time(trigger.startedAt, `${label}.startedAt`, errors);
  const finishedAt = time(trigger.finishedAt, `${label}.finishedAt`, errors);
  if (finishedAt < startedAt || startedAt < window.startedAt || finishedAt > window.finishedAt) {
    errors.push(`${label} must fall inside the same-run window`);
  }
}

function validateMutation(
  mutation: PhysicalPhaseDMutation,
  expected: { runId: string; kind: PhysicalPhaseDMutationKind; host: PhysicalPhaseDHost; deviceKey: string },
  errors: string[],
): void {
  const label = `Phase D ${expected.kind} mutation`;
  if (
    mutation.schemaVersion !== PHASE_D_MUTATION_SCHEMA ||
    mutation.runId !== expected.runId ||
    mutation.kind !== expected.kind ||
    mutation.sourceHost !== expected.host ||
    mutation.sourceDeviceKey !== expected.deviceKey ||
    mutation.method !== 'fixed-worktree-commit' ||
    mutation.protectedPath !== PHASE_D_SENTINEL
  ) {
    errors.push(`${label} is not the fixed run-bound worktree commit`);
  }
  if (!isAbsolute(mutation.worktreePath)) errors.push(`${label} worktreePath must be absolute`);
  if (!OID.test(mutation.baseOid) || !OID.test(mutation.headOid) || mutation.baseOid === mutation.headOid) {
    errors.push(`${label} must bind distinct real Git commits`);
  }
  if (!SHA256.test(mutation.payloadSha256)) errors.push(`${label} payload hash is invalid`);
  time(mutation.createdAt, `${label}.createdAt`, errors);
}

function sameAdvance(a: SignedStagingAdvance, b: SignedStagingAdvance): boolean {
  return (
    a.v === b.v &&
    a.device_pubkey === b.device_pubkey &&
    a.epoch === b.epoch &&
    a.seq === b.seq &&
    a.staging_sha === b.staging_sha &&
    a.ts === b.ts &&
    a.sig === b.sig
  );
}

function validateEventPair(
  advance: PhysicalPhaseDAdvance,
  expected: { stagingSha: string; sourceRole: PhysicalPhaseDTrigger['role']; destinationRole: PhysicalPhaseDTrigger['role']; integratorDeviceKey: string },
  window: { startedAt: number; finishedAt: number },
  errors: string[],
): void {
  validateTrigger(advance.integratorTrigger, { host: 'tower', role: expected.sourceRole }, window, errors);
  validateTrigger(advance.destinationTrigger, { host: 'vm', role: expected.destinationRole }, window, errors);
  for (const [hostId, event] of [
    ['tower', advance.sourceEvent],
    ['vm', advance.destinationEvent],
  ] as const) {
    if (
      event.schemaVersion !== PHASE_D_EVENT_SCHEMA ||
      event.hostId !== hostId ||
      !Number.isSafeInteger(event.rowId) ||
      event.rowId <= 0 ||
      event.key !== STAGING_ADVANCE_EVENT_KEY ||
      event.source !== 'git-sync-integrator' ||
      event.repoKey !== PHASE_A_REPO_KEY ||
      event.payload.device_pubkey !== expected.integratorDeviceKey ||
      event.payload.staging_sha !== expected.stagingSha ||
      !verifyStagingAdvance(event.payload, expected.integratorDeviceKey)
    ) {
      errors.push(`Phase D ${hostId} event is not the exact signed production staging advance`);
    }
    const observedAt = time(event.observedAt, `Phase D ${hostId} event.observedAt`, errors);
    if (observedAt < window.startedAt || observedAt > window.finishedAt) {
      errors.push(`Phase D ${hostId} event must fall inside the same-run window`);
    }
  }
  if (!sameAdvance(advance.sourceEvent.payload, advance.destinationEvent.payload)) {
    errors.push('Phase D destination event must exactly match the source signed advance');
  }
}

function validateObservation(
  observation: PhysicalPhaseDObservation,
  expected: {
    host: PhysicalPhaseDHost;
    stage: PhysicalPhaseDObservationStage;
    runId: string;
    integratorDeviceKey: string;
  },
  errors: string[],
): void {
  const label = `Phase D ${expected.stage}`;
  if (
    observation.schemaVersion !== PHASE_D_OBSERVATION_SCHEMA ||
    observation.hostId !== expected.host ||
    observation.stage !== expected.stage ||
    observation.runId !== expected.runId ||
    observation.integratorDeviceKey !== expected.integratorDeviceKey ||
    observation.protectedPath !== PHASE_D_SENTINEL ||
    !isAbsolute(observation.repoPath) ||
    !isAbsolute(observation.worktreePath)
  ) {
    errors.push(`${label} is not a fixed physical-host observation`);
  }
  if (!OID.test(observation.worktreeHeadOid)) errors.push(`${label} worktree head is invalid`);
  if (!Array.isArray(observation.dirtyPaths)) errors.push(`${label} dirtyPaths must be an array`);
  if (!Number.isSafeInteger(observation.cursor.lastEventId) || observation.cursor.lastEventId < 0) {
    errors.push(`${label} cursor is invalid`);
  }
  time(observation.observedAt, `${label}.observedAt`, errors);
}

/** Strict, pure causal validator for the assembled two-host Phase D evidence. */
export function validatePhysicalPhaseD(input: PhysicalPhaseDInput): PhysicalPhaseDVerdict {
  const errors: string[] = [];
  if (input.schemaVersion !== PHASE_D_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_D_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input.runId)) errors.push('Phase D runId is invalid');
  try {
    assertDeviceKey(input.identities.towerDeviceKey);
    assertDeviceKey(input.identities.vmDeviceKey);
    if (input.identities.towerDeviceKey === input.identities.vmDeviceKey) {
      errors.push('Phase D tower and vm device identities must be distinct');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const startedAt = time(input.window.startedAt, 'Phase D window.startedAt', errors);
  const finishedAt = time(input.window.finishedAt, 'Phase D window.finishedAt', errors);
  if (finishedAt <= startedAt) errors.push('Phase D window must be ordered');
  const window = { startedAt, finishedAt };

  const tower = input.identities.towerDeviceKey;
  const vm = input.identities.vmDeviceKey;
  validateMutation(input.belowSteer.mutation, { runId: input.runId, kind: 'below-steer', host: 'vm', deviceKey: vm }, errors);
  validateTrigger(input.belowSteer.publishTrigger, { host: 'vm', role: 'below-steer-publish' }, window, errors);
  validateTrigger(input.belowSteer.queueTrigger, { host: 'tower', role: 'queue-receive' }, window, errors);

  const pending = input.belowSteer.pendingReceipt;
  if (
    pending.workspaceId !== PHASE_D_WORKSPACE ||
    pending.potSlug !== PHASE_A_POT_HOME ||
    pending.repoKey !== PHASE_A_REPO_KEY ||
    pending.devicePubkey !== vm ||
    pending.headSha !== input.belowSteer.mutation.headOid ||
    pending.reason !== 'below-steer-tier' ||
    pending.state !== 'pending' ||
    pending.ratifiedTs !== null
  ) {
    errors.push('Phase D pending receipt must be the exact visible below-steer request');
  }

  const ratification = input.belowSteer.ratification;
  if (
    ratification.schemaVersion !== PHASE_D_RATIFICATION_SCHEMA ||
    ratification.tool !== 'ratifyIntegrationRequest' ||
    ratification.accepted !== true ||
    !sameRequest(pending, ratification.pending) ||
    !sameRequest(pending, ratification.ratified) ||
    ratification.ratified.state !== 'ratified' ||
    ratification.ratified.ratifiedTs === null ||
    ratification.ratified.ratifiedTs < ratification.ratified.createdTs
  ) {
    errors.push('Phase D ratification must promote the exact pending request through the production surface');
  }

  validateEventPair(
    input.firstAdvance,
    {
      stagingSha: input.belowSteer.mutation.headOid,
      sourceRole: 'ratified-integrate',
      destinationRole: 'first-bridge',
      integratorDeviceKey: tower,
    },
    window,
    errors,
  );
  validateObservation(input.firstAdvance.sourceObservation, { host: 'tower', stage: 'first-source', runId: input.runId, integratorDeviceKey: tower }, errors);
  validateObservation(input.firstAdvance.destinationObservation, { host: 'vm', stage: 'first-destination', runId: input.runId, integratorDeviceKey: tower }, errors);

  const firstSha = input.firstAdvance.sourceEvent.payload.staging_sha;
  const firstDestination = input.firstAdvance.destinationObservation;
  for (const [label, observation] of [
    ['source', input.firstAdvance.sourceObservation],
    ['destination', firstDestination],
  ] as const) {
    if (
      observation.integratorNamespaceStagingOid !== firstSha ||
      observation.canonicalStagingOid !== firstSha ||
      observation.worktreeHeadOid !== firstSha ||
      observation.cursor.stagingSha !== firstSha ||
      !observation.cursor.epochSeq ||
      compareEpochSeq(observation.cursor.epochSeq, input.firstAdvance.sourceEvent.payload) !== 0
    ) {
      errors.push(`Phase D first ${label} observation must converge canonical, cursor, and worktree to the signed staging head`);
    }
  }
  if (firstDestination.cursor.lastEventId < input.firstAdvance.destinationEvent.rowId) {
    errors.push('Phase D first destination cursor must consume the replicated signed event');
  }

  validateMutation(input.dirtyAdvance.mutation, { runId: input.runId, kind: 'dirty-overlap', host: 'tower', deviceKey: tower }, errors);
  if (input.dirtyAdvance.mutation.baseOid !== firstSha) {
    errors.push('Phase D dirty-overlap commit must descend directly from the first canonical staging head');
  }
  validateEventPair(
    input.dirtyAdvance,
    {
      stagingSha: input.dirtyAdvance.mutation.headOid,
      sourceRole: 'dirty-integrate',
      destinationRole: 'dirty-bridge',
      integratorDeviceKey: tower,
    },
    window,
    errors,
  );
  validateObservation(input.dirtyAdvance.dirtyBefore, { host: 'vm', stage: 'dirty-before', runId: input.runId, integratorDeviceKey: tower }, errors);
  validateObservation(input.dirtyAdvance.dirtyAfter, { host: 'vm', stage: 'dirty-after', runId: input.runId, integratorDeviceKey: tower }, errors);

  const secondSha = input.dirtyAdvance.sourceEvent.payload.staging_sha;
  const dirtyBefore = input.dirtyAdvance.dirtyBefore;
  const dirtyAfter = input.dirtyAdvance.dirtyAfter;
  if (
    dirtyBefore.canonicalStagingOid !== firstSha ||
    dirtyBefore.worktreeHeadOid !== firstSha ||
    !dirtyBefore.dirtyPaths.includes(PHASE_D_SENTINEL) ||
    !dirtyBefore.protectedFileSha256 ||
    !SHA256.test(dirtyBefore.protectedFileSha256)
  ) {
    errors.push('Phase D dirty-before observation must bind the overlapping dirty file at the first staging head');
  }
  if (
    dirtyAfter.integratorNamespaceStagingOid !== secondSha ||
    dirtyAfter.canonicalStagingOid !== secondSha ||
    dirtyAfter.cursor.stagingSha !== secondSha ||
    !dirtyAfter.cursor.epochSeq ||
    compareEpochSeq(dirtyAfter.cursor.epochSeq, input.dirtyAdvance.sourceEvent.payload) !== 0 ||
    dirtyAfter.cursor.lastEventId < input.dirtyAdvance.destinationEvent.rowId ||
    dirtyAfter.cursor.lastEventId <= dirtyBefore.cursor.lastEventId
  ) {
    errors.push('Phase D dirty-after observation must advance the mirror and production bridge cursor');
  }
  if (
    dirtyAfter.worktreeHeadOid !== dirtyBefore.worktreeHeadOid ||
    dirtyAfter.protectedFileSha256 !== dirtyBefore.protectedFileSha256 ||
    !dirtyAfter.dirtyPaths.includes(PHASE_D_SENTINEL)
  ) {
    errors.push('Phase D dirty bridge must leave the worktree head and protected dirty file untouched');
  }
  if (compareEpochSeq(input.dirtyAdvance.sourceEvent.payload, input.firstAdvance.sourceEvent.payload) <= 0) {
    errors.push('Phase D second signed advance must be newer than the first epoch/seq');
  }
  if (
    input.dirtyAdvance.sourceEvent.rowId <= input.firstAdvance.sourceEvent.rowId ||
    input.dirtyAdvance.destinationEvent.rowId <= input.firstAdvance.destinationEvent.rowId
  ) {
    errors.push('Phase D second advance must use newer production event rows on both physical hosts');
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result:
      uniqueErrors.length > 0
        ? null
        : {
            schemaVersion: PHASE_D_RESULT_SCHEMA,
            phase: 'D',
            planItem: PHASE_D_PLAN_ITEM,
            status: 'complete',
            complete: true,
            missingAssertions: [],
            observedAt: input.window.finishedAt,
            assertions: {
              freshBelowSteerHeadQueuedWithVisibleReceipt: true,
              exactRequestRatifiedThroughProductionSurface: true,
              productionGitSyncPublishedSignedCanonicalStaging: true,
              signedAdvanceFederatedToOtherPhysicalHost: true,
              otherPhysicalHostFastForwardedCanonicalAndWorktree: true,
              secondOverlappingAdvanceMovedMirrorAndCursor: true,
              dirtyWorktreeAndProtectedFileRemainedUntouched: true,
            },
            oids: { firstStaging: firstSha, secondStaging: secondSha },
            cursor: {
              firstEventId: firstDestination.cursor.lastEventId,
              secondEventId: dirtyAfter.cursor.lastEventId,
            },
          },
  };
}
