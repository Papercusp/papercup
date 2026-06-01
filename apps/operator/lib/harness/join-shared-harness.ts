/**
 * join-shared-harness — 9-step orchestration for Entry 4 (P-009).
 *
 * Steps per v5 §3 Entry 4:
 *   1. oauth_attest        — ensure device keypair + channel-1 OAuth re-check
 *   2. clone_repo          — git-clone the shared GitHub repo (P-008 helper)
 *   3. join_hyperswarm     — join Hyperswarm topic  [STUB: phase_0_pending]
 *   4. bootstrap_hyperbee  — wait for substrate catch-up signal (P-034)
 *   5. seed_pg             — seed local PG from projection  [STUB: phase_0_pending]
 *   6. create_user_branch  — create user/<github_user_id> branch + worktree
 *   7. push_contributor_file — push signed .harness/contributors/<login>.json
 *   8. publish_binding     — publish contributor row to Hyperbee (P-033)
 *   9. verify_binding      — two-channel binding verification (P-075)
 *  10. route_insights      — signal completion (UI navigates to /harness/<slug>/insights)
 *
 * Stubs: steps 3 and 5 still depend on Hyperswarm/Autobase replication
 * specifics (Phase 5a P-030/P-031 native bits) and produce
 * `JoinStepStatus.phase_0_pending`. Steps 4 and 8 now exercise the
 * substrate when booted (P-034 bootstrap-wait + P-033 contributor
 * publication); both soft-skip (phase_0_pending) only when the substrate
 * flag is off / the per-harness handle isn't ready.
 *
 * Idempotent resume: the orchestrator persists `JoinState` to
 * `~/.papercusp/join-state/<slug>.json` after each step. On re-run, completed
 * steps are skipped. Delete the file to force a full re-join.
 *
 * Each step is exported individually for isolated unit testing (P-009b).
 */

import { execFile as _execFile } from 'node:child_process';
import { workspacesRoot } from '@/lib/workspace-registry';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sign as nodeSign } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import type { HarnessLink } from './url-scheme';
import {
  type ChannelResult,
  type BindingVerificationResult,
} from '../identity/binding-verifier-types';
import {
  type ContributorFileBody,
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
  contributorFilePath,
  contributorBranchRef,
} from '../identity/contributor-file-types';
import {
  ensureUserBranchAndWorktree,
  type RunGit,
} from './ensure-user-branch';
import { userTreeAbsPath } from './user-tree-types';
import { rmSync } from 'node:fs';
import { publishContributorRow } from '../sync/hyperbee/write-contributor-row';
import {
  CONTRIBUTOR_ROW_SCHEMA_VERSION,
  type ContributorRow,
} from './contributor-row-types';
import { waitForHyperbeeBootstrap } from './bootstrap-wait';
import { keychainLoad } from '../identity/keychain';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import type { DeviceKeypairId } from '../identity/attestation-types';
import {
  verifyChannel1,
  verifyChannel2,
  verifyBoth,
  type VerifyChannel1Options,
  type VerifyChannel2Options,
  type VerifyBothOptions,
} from '../identity/two-channel-verifier';

const execFile = promisify(_execFile);

// ─── step id + status types ───────────────────────────────────────────────────

export type JoinStepId =
  | 'oauth_attest'
  | 'clone_repo'
  | 'join_hyperswarm'
  | 'bootstrap_hyperbee'
  | 'seed_pg'
  | 'create_user_branch'
  | 'push_contributor_file'
  | 'publish_binding'
  | 'verify_binding'
  | 'route_insights';

export type JoinStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  /** Phase-0-dependent stub: step not yet implemented; flow continues. */
  | 'phase_0_pending';

export interface JoinStepState {
  id: JoinStepId;
  status: JoinStepStatus;
  errorCode?: string;
  detail?: string;
}

// ─── persisted join state ─────────────────────────────────────────────────────

/** Mutable state persisted to disk after each step for idempotent resume. */
export interface JoinState {
  /** Harness slug being joined. */
  slug: string;
  /** Hyperswarm topic from the harness link. */
  linkTopic: string;
  steps: Record<JoinStepId, JoinStepState>;
  startedAt: number;
  completedAt?: number;
  /** Absolute path of the cloned repo dir (set after step 2). */
  cloneDir?: string;
  /** Absolute path of the user's worktree dir (set after step 6). v5 §0.4. */
  userWorktreeDir?: string;
  /** Base64 raw-bytes device public key (set after step 1). */
  pubkeyBase64?: string;
  /** Attestation gist id (set after step 1). */
  attestationGistId?: string;
  /** SHA of the contributor-file push commit (set after step 7). */
  channel2CommitSha?: string;
  /** GitHub user id (mirrors opts, for resume). */
  githubUserId?: number;
  /** GitHub login (mirrors opts, for resume). */
  githubLogin?: string;
}

const ALL_STEPS: JoinStepId[] = [
  'oauth_attest',
  'clone_repo',
  'join_hyperswarm',
  'bootstrap_hyperbee',
  'seed_pg',
  'create_user_branch',
  'push_contributor_file',
  'publish_binding',
  'verify_binding',
  'route_insights',
];

function initialSteps(): Record<JoinStepId, JoinStepState> {
  const out = {} as Record<JoinStepId, JoinStepState>;
  for (const id of ALL_STEPS) out[id] = { id, status: 'pending' };
  return out;
}

// ─── options ──────────────────────────────────────────────────────────────────

export interface JoinOptions {
  /** Parsed harness link to join. */
  link: HarnessLink;
  /** Slug for the new harness entry in the local registry. */
  slug: string;
  /** GitHub OAuth token (used for channel-1 + git operations). */
  token: string;
  /** Verified numeric GitHub user id for the current user. */
  githubUserId: number;
  /** Current GitHub login (used for branch + file naming). */
  githubLogin: string;
  /** Keychain id for the device Ed25519 keypair. */
  keychainId: string;
  /** If set, re-use a previously-existing attestation gist id. */
  existingGistId?: string;
  /** Called after every step status change. */
  onProgress?: (steps: JoinStepState[]) => void;
  /** Injectable fetch (tests). */
  fetchFn?: typeof fetch;
  /** Injectable execFile (tests). */
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Injectable FS write (tests). */
  writeFileFn?: (path: string, content: string) => Promise<void>;
  /** Injectable FS mkdir (tests). */
  mkdirFn?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  /** Injectable state read (tests). */
  readStateFn?: (slug: string) => Promise<JoinState | null>;
  /** Injectable state write (tests). */
  writeStateFn?: (slug: string, state: JoinState) => Promise<void>;
}

// ─── step 1: oauth_attest ────────────────────────────────────────────────────

export interface Step1Result {
  keypair: DeviceKeypairId;
  channel1: ChannelResult;
}

export async function step1_oauthAttest(opts: {
  token: string;
  claimedGithubUserId: number;
  keychainId: string;
  fetchFn?: typeof fetch;
}): Promise<Step1Result> {
  const keypair = await loadOrGenerateDeviceKeypair(opts.keychainId);
  const channel1 = await verifyChannel1({
    token: opts.token,
    claimedGithubUserId: opts.claimedGithubUserId,
    fetchFn: opts.fetchFn,
  });
  if (channel1.kind === 'fail') {
    const err = new JoinStepError(
      'oauth_attest',
      channel1.reason,
      `Channel 1 OAuth check failed: ${channel1.reason}`,
    );
    throw err;
  }
  return { keypair, channel1 };
}

// ─── step 2: clone_repo ──────────────────────────────────────────────────────

export interface Step2Result {
  cloneDir: string;
}

export async function step2_cloneRepo(opts: {
  githubFullName: string;
  slug: string;
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  mkdirFn?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
}): Promise<Step2Result> {
  const { githubFullName, slug } = opts;
  const exF = opts.execFileFn ?? defaultExecFile;
  const mkF = opts.mkdirFn ?? ((p, o) => mkdir(p, o ?? {}));

  const clonesBase = resolve(workspacesRoot(), 'clones');
  const cloneDir = join(clonesBase, slug);

  if (existsSync(cloneDir)) {
    // Already cloned — idempotent.
    return { cloneDir };
  }

  await mkF(clonesBase, { recursive: true });
  const cloneUrl = `https://github.com/${githubFullName}`;
  try {
    await exF('git', ['clone', '--depth', '1', cloneUrl, cloneDir]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new JoinStepError('clone_repo', 'clone_failed', msg.slice(0, 300));
  }
  return { cloneDir };
}

// ─── step 3: join_hyperswarm ─────────────────────────────────────────────────
// STUB: Phase 5a (Hyperswarm/Holepunch) is DEFERRED. This step is skipped.

export async function step3_joinHyperswarm(_opts: {
  topic: string;
}): Promise<void> {
  throw new JoinStepError(
    'join_hyperswarm',
    'phase_0_pending',
    'Hyperswarm join deferred until Phase 5a',
  );
}

// ─── step 4: bootstrap_hyperbee ──────────────────────────────────────────────
//
// Waits for the per-harness Hyperbee replication to catch up (P-066
// caught-up signal) so the wizard's route-to-Insights renders meaningful
// state. Timeout fires the "still syncing — continue anyway" affordance
// per v5 §3 Entry 4 sub-acceptance P-034b; the step still completes
// (NOT an error) so the join flow can continue.
//
// Soft-skip when the substrate isn't booted (flag off / handle not
// resolved): throws phase_0_pending, caller maps to markPhase0 so flow
// continues.

export interface Step4Result {
  caughtUp: boolean;
  timedOut: boolean;
  observed: number;
  substrateInactive: boolean;
}

export async function step4_bootstrapHyperbee(opts: {
  workspaceId: string;
  harnessSlug: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Test override; runtime imports getBootstrapProgress lazily. */
  getProgress?: (
    workspaceId: string,
    harnessSlug: string,
  ) => import('../sync/hyperbee/bootstrap-progress').BootstrapProgressSnapshot | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test override; runtime resolves via getBootedHarness. */
  resolveHandle?: () => Promise<unknown | null>;
}): Promise<Step4Result> {
  const resolveHandle =
    opts.resolveHandle ??
    (async () => {
      const mod = await import('../sync/hyperbee/boot-all');
      return mod.getBootedHarness(opts.workspaceId, opts.harnessSlug);
    });
  const handle = await resolveHandle();
  if (!handle) {
    throw new JoinStepError(
      'bootstrap_hyperbee',
      'phase_0_pending',
      'Hyperbee substrate not booted for this harness; will sync on next online join.',
    );
  }
  const getProgress =
    opts.getProgress ??
    ((ws, slug) => {
      // Lazy import + delegate; require sync to keep step4 callers' import
      // graph small. The bootstrap-progress module is pure (no PG / IO).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../sync/hyperbee/bootstrap-progress') as typeof import('../sync/hyperbee/bootstrap-progress');
      return mod.getBootstrapProgress(ws, slug);
    });
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const r = await waitForHyperbeeBootstrap({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    getProgress,
    sleep,
    now: opts.now,
  });
  return r;
}

// ─── step 5: seed_pg ─────────────────────────────────────────────────────────
// STUB: Phase 5a deferred.

export async function step5_seedPg(_opts: {
  slug: string;
}): Promise<void> {
  throw new JoinStepError(
    'seed_pg',
    'phase_0_pending',
    'PG seeding from Hyperbee projection deferred until Phase 5a',
  );
}

// ─── step 6: create_user_branch ──────────────────────────────────────────────
//
// Provisions the `user/<github_user_id>` branch AND its dedicated worktree
// at `<cloneDir>/.papercusp/user-trees/<github_user_id>/` per v5 §0.4.
// The main cloneDir's HEAD stays on `main`; the user's writes land in the
// separate worktree dir. Idempotent.

export interface Step6Result {
  branchRef: string;
  worktreeAbsPath: string;
}

function execFileToRunGit(
  execFileFn: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>,
): RunGit {
  return async (args) => {
    try {
      const r = await execFileFn('git', args);
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: 0 };
    } catch (e: unknown) {
      // child_process.execFile rejects on non-zero exit with a NodeError that
      // carries .code (numeric exit), .stderr, .stdout. Normalize to RunGit.
      const err = e as { code?: number; stderr?: string; stdout?: string; message?: string };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  };
}

export async function step6_createUserBranch(opts: {
  cloneDir: string;
  githubUserId: number;
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  pathExistsFn?: (path: string) => boolean;
  rmDirSyncFn?: (path: string) => void;
}): Promise<Step6Result> {
  const exF = opts.execFileFn ?? defaultExecFile;
  const runGit = execFileToRunGit(exF);
  try {
    const r = await ensureUserBranchAndWorktree({
      harnessRoot: opts.cloneDir,
      githubUserId: opts.githubUserId,
      runGit,
      pathExists: opts.pathExistsFn ?? existsSync,
      rmDirSync: opts.rmDirSyncFn ?? ((p) => rmSync(p, { recursive: true, force: true })),
    });
    return { branchRef: r.branchRef, worktreeAbsPath: r.worktreeAbsPath };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new JoinStepError('create_user_branch', 'branch_failed', msg.slice(0, 300));
  }
}

// ─── step 7: push_contributor_file ───────────────────────────────────────────

export interface Step7Result {
  commitSha: string;
}

export async function step7_pushContributorFile(opts: {
  /**
   * The user's worktree dir (per v5 §0.4 the `user/<id>` branch lives in
   * a worktree at `<cloneDir>/.papercusp/user-trees/<id>/`). All writes
   * + commits + push happen here, NOT in the main cloneDir.
   */
  worktreeDir: string;
  githubUserId: number;
  githubLogin: string;
  devicePubkeyBase64: string;
  attestationGistId: string;
  keychainId: string;
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  writeFileFn?: (path: string, content: string) => Promise<void>;
  mkdirFn?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
}): Promise<Step7Result> {
  const exF = opts.execFileFn ?? defaultExecFile;
  const wF = opts.writeFileFn ?? ((p, c) => writeFile(p, c, 'utf8'));
  const mkF = opts.mkdirFn ?? ((p, o) => mkdir(p, o ?? {}));
  const cwd = opts.worktreeDir;

  // Build the file body (unsigned).
  const unsignedBody = {
    version: 1 as const,
    github_user_id: opts.githubUserId,
    github_login: opts.githubLogin,
    device_pubkey: `ed25519:${opts.devicePubkeyBase64}`,
    device_attestation_gist_id: opts.attestationGistId,
    joined_at: new Date().toISOString(),
  };

  // JCS-sign: ordered fields per CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER minus signature.
  const signingFields = (CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER as readonly string[]).filter(
    (f) => f !== 'signature_by_device',
  );
  const ordered: Record<string, unknown> = {};
  for (const f of signingFields) {
    ordered[f] = (unsignedBody as Record<string, unknown>)[f];
  }
  const payloadBytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  const sig = await signWithKeychain(opts.keychainId, payloadBytes);

  const fileBody: ContributorFileBody = {
    ...unsignedBody,
    signature_by_device: sig,
  };

  // Write the file.
  const filePath = join(cwd, contributorFilePath(opts.githubLogin));
  const fileDir = join(cwd, '.harness', 'contributors');
  await mkF(fileDir, { recursive: true });
  await wF(filePath, JSON.stringify(fileBody, null, 2) + '\n');

  // Stage + commit + push.
  const relPath = contributorFilePath(opts.githubLogin);
  await exF('git', ['add', relPath], { cwd });
  try {
    await exF(
      'git',
      ['commit', '--allow-empty', '-m', `chore: add contributor file for ${opts.githubLogin}`],
      { cwd },
    );
  } catch (e: unknown) {
    // "nothing to commit" is fine if the file was already committed.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('nothing to commit')) {
      throw new JoinStepError('push_contributor_file', 'commit_failed', msg.slice(0, 300));
    }
  }

  // Push the user branch.
  const branch = contributorBranchRef(opts.githubUserId);
  try {
    await exF('git', ['push', '-u', 'origin', branch], { cwd });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new JoinStepError('push_contributor_file', 'push_failed', msg.slice(0, 300));
  }

  // Read back the commit SHA.
  const { stdout } = await exF('git', ['rev-parse', 'HEAD'], { cwd });
  return { commitSha: stdout.trim() };
}

// ─── step 8: publish_binding ─────────────────────────────────────────────────
//
// Publishes the contributor row to the per-harness Hyperbee. The PG
// projection at lib/sync/hyperbee/projections/contributors.ts picks
// the op up + upserts into harness_shared.contributors so every other
// reader (Insights People card, Contributors tab, claim-CTA gate) sees
// the new contributor without a round-trip.
//
// When the per-harness substrate handle isn't ready yet, this step marks
// itself phase_0_pending and the flow continues — the bare-PG path still
// works, just without the substrate-fan-out signal. Mirrors the
// pre-substrate behavior.

export async function step8_publishBinding(opts: {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
  githubLogin: string;
  pubkeyBase64: string;
  attestationGistId: string;
  channel2CommitSha?: string;
  /** Test override; runtime resolves via getBootedHarness. */
  resolveHandle?: () => Promise<import('../sync/hyperbee/boot').BootedHarnessHandle | null>;
  /** Test override for the publish call. */
  publishRow?: typeof publishContributorRow;
  /** Override clock. */
  now?: number;
}): Promise<void> {
  const resolveHandle =
    opts.resolveHandle ??
    (async () => {
      const mod = await import('../sync/hyperbee/boot-all');
      return mod.getBootedHarness(opts.workspaceId, opts.harnessSlug);
    });
  const handle = await resolveHandle();
  if (!handle) {
    // Substrate off / not yet booted for this harness — soft-skip.
    throw new JoinStepError(
      'publish_binding',
      'phase_0_pending',
      'Hyperbee substrate not booted for this harness; contributor row will publish on the next online join.',
    );
  }
  const ts = opts.now ?? Date.now();
  const row: ContributorRow = {
    harness_slug: opts.harnessSlug,
    github_user_id: opts.githubUserId,
    github_username: opts.githubLogin,
    display_name: null,
    avatar_url: null,
    device_attestations: [
      {
        device_pubkey: `ed25519:${opts.pubkeyBase64}`,
        gist_id: opts.attestationGistId,
        gist_url: `https://gist.github.com/${opts.attestationGistId}`,
        device_label: 'unnamed-device',
        created_at: ts,
        signature_by_device: '',
      },
    ],
    revoked_pubkeys: [],
    joined_at: ts,
    last_seen_at: ts,
    binding_status: 'pending',
    channel1_verified_at: null,
    channel2_verified_at: null,
    channel2_branch_ref: contributorBranchRef(opts.githubUserId),
    binding_last_checked_at: null,
    schema_version: CONTRIBUTOR_ROW_SCHEMA_VERSION,
  };
  const publish = opts.publishRow ?? publishContributorRow;
  // Thread the local writer pubkey so a remote override of this
  // contributor row within the clobber window surfaces a toast.
  let writerPubkey: string | undefined;
  try {
    const { resolveMyPubkey } = await import('../orchestrator/distributed-claim');
    writerPubkey = resolveMyPubkey(handle) ?? undefined;
  } catch {
    writerPubkey = undefined;
  }
  try {
    await publish({ handle, row, now: ts, writerPubkey });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new JoinStepError('publish_binding', 'publish_failed', msg.slice(0, 300));
  }
}

// ─── step 9: verify_binding ──────────────────────────────────────────────────

export async function step9_verifyBinding(opts: {
  token: string;
  githubUserId: number;
  githubLogin: string;
  repoOwner: string;
  repoName: string;
  devicePubkeyBase64: string;
  channel2CommitSha?: string;
  channel2PendingSince?: number;
  fetchFn?: typeof fetch;
}): Promise<BindingVerificationResult> {
  return verifyBoth({
    channel1: {
      token: opts.token,
      claimedGithubUserId: opts.githubUserId,
      fetchFn: opts.fetchFn,
    },
    channel2: {
      repoOwner: opts.repoOwner,
      repoName: opts.repoName,
      githubLogin: opts.githubLogin,
      githubUserId: opts.githubUserId,
      devicePubkeyBase64: opts.devicePubkeyBase64,
      token: opts.token,
      fetchFn: opts.fetchFn,
    },
    channel2PendingSince: opts.channel2PendingSince,
  });
}

// ─── step 10: route_insights ─────────────────────────────────────────────────

export interface Step10Result {
  insightsPath: string;
}

export function step10_routeInsights(slug: string): Step10Result {
  return { insightsPath: `/harness/${encodeURIComponent(slug)}/insights` };
}

// ─── orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full 9-step (10 with route_insights signal) join flow.
 * Steps backed by Phase-0 stubs produce `phase_0_pending` status and are
 * skipped without blocking the rest of the flow.
 *
 * Returns the final `JoinState` including the insights URL to navigate to.
 */
export async function joinSharedHarness(opts: JoinOptions): Promise<JoinState> {
  const readState = opts.readStateFn ?? defaultReadState;
  const writeState = opts.writeStateFn ?? defaultWriteState;

  // Load or initialize persisted state.
  let state = await readState(opts.slug);
  if (!state) {
    state = {
      slug: opts.slug,
      linkTopic: opts.link.topic,
      steps: initialSteps(),
      startedAt: Date.now(),
      githubUserId: opts.githubUserId,
      githubLogin: opts.githubLogin,
    };
  }

  function emit() {
    opts.onProgress?.(Object.values(state!.steps));
  }

  function markRunning(id: JoinStepId) {
    state!.steps[id] = { id, status: 'running' };
    emit();
  }

  function markDone(id: JoinStepId) {
    state!.steps[id] = { id, status: 'done' };
  }

  function markPhase0(id: JoinStepId, detail?: string) {
    state!.steps[id] = { id, status: 'phase_0_pending', detail };
  }

  function markError(id: JoinStepId, code: string, detail?: string) {
    state!.steps[id] = { id, status: 'error', errorCode: code, detail };
  }

  async function saveAndEmit() {
    await writeState(opts.slug, state!);
    emit();
  }

  // ── Step 1: oauth_attest ──
  if (state.steps.oauth_attest.status !== 'done') {
    markRunning('oauth_attest');
    try {
      const r = await step1_oauthAttest({
        token: opts.token,
        claimedGithubUserId: opts.githubUserId,
        keychainId: opts.keychainId,
        fetchFn: opts.fetchFn,
      });
      state.pubkeyBase64 = r.keypair.pubkeyBase64;
      state.attestationGistId = opts.existingGistId ?? '';
      markDone('oauth_attest');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      markError('oauth_attest', err?.code ?? 'unknown', err?.message);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 2: clone_repo ──
  if (state.steps.clone_repo.status !== 'done') {
    markRunning('clone_repo');
    try {
      const r = await step2_cloneRepo({
        githubFullName: opts.link.github,
        slug: opts.slug,
        execFileFn: opts.execFileFn,
        mkdirFn: opts.mkdirFn,
      });
      state.cloneDir = r.cloneDir;
      markDone('clone_repo');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      markError('clone_repo', err?.code ?? 'unknown', err?.message);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Steps 3 + 5: Phase-0 stubs (skip without failing) ──
  for (const stubId of ['join_hyperswarm', 'seed_pg'] as JoinStepId[]) {
    if (state.steps[stubId].status !== 'done' && state.steps[stubId].status !== 'phase_0_pending') {
      markPhase0(stubId, 'deferred until Phase 5a (Hyperswarm/Autobase)');
    }
  }
  await saveAndEmit();

  // ── Step 4: bootstrap_hyperbee — wait for substrate catch-up ──
  if (state.steps.bootstrap_hyperbee.status !== 'done') {
    markRunning('bootstrap_hyperbee');
    try {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const s4 = await step4_bootstrapHyperbee({
        workspaceId: activeWorkspaceId(),
        harnessSlug: opts.slug,
      });
      if (s4.timedOut) {
        // Soft completion: the UI surfaces "still syncing — continue anyway"
        // per v5 §3 Entry 4 sub-acceptance P-034b.
        state.steps.bootstrap_hyperbee = {
          id: 'bootstrap_hyperbee',
          status: 'done',
          detail: `still syncing (observed ${s4.observed} ops, continued after timeout)`,
        };
      } else {
        markDone('bootstrap_hyperbee');
      }
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      if (err?.code === 'phase_0_pending') {
        markPhase0('bootstrap_hyperbee', err.message ?? 'substrate not booted');
      } else {
        markError('bootstrap_hyperbee', err?.code ?? 'unknown', err?.message);
      }
    }
    await saveAndEmit();
  }

  const cloneDir = state.cloneDir!;

  // ── Step 6: create_user_branch ──
  if (state.steps.create_user_branch.status !== 'done') {
    markRunning('create_user_branch');
    try {
      const s6 = await step6_createUserBranch({
        cloneDir,
        githubUserId: opts.githubUserId,
        execFileFn: opts.execFileFn,
      });
      state.userWorktreeDir = s6.worktreeAbsPath;
      markDone('create_user_branch');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      markError('create_user_branch', err?.code ?? 'unknown', err?.message);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }
  // After step 6 (whether just run or already done) ensure we have the
  // resolved worktree path on state for downstream steps.
  if (!state.userWorktreeDir) {
    state.userWorktreeDir = userTreeAbsPath({
      harnessRoot: cloneDir,
      githubUserId: opts.githubUserId,
    });
  }
  const worktreeDir = state.userWorktreeDir;

  // ── Step 7: push_contributor_file ──
  if (state.steps.push_contributor_file.status !== 'done') {
    markRunning('push_contributor_file');
    const gistId = state.attestationGistId ?? opts.existingGistId ?? '';
    try {
      const r = await step7_pushContributorFile({
        worktreeDir,
        githubUserId: opts.githubUserId,
        githubLogin: opts.githubLogin,
        devicePubkeyBase64: state.pubkeyBase64!,
        attestationGistId: gistId,
        keychainId: opts.keychainId,
        execFileFn: opts.execFileFn,
        writeFileFn: opts.writeFileFn,
        mkdirFn: opts.mkdirFn,
      });
      state.channel2CommitSha = r.commitSha;
      markDone('push_contributor_file');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      markError('push_contributor_file', err?.code ?? 'unknown', err?.message);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 8: publish_binding ──
  if (state.steps.publish_binding.status !== 'done') {
    markRunning('publish_binding');
    try {
      const { activeWorkspaceId } = await import('../workspace-registry');
      await step8_publishBinding({
        workspaceId: activeWorkspaceId(),
        harnessSlug: opts.slug,
        githubUserId: opts.githubUserId,
        githubLogin: opts.githubLogin,
        pubkeyBase64: state.pubkeyBase64!,
        attestationGistId: state.attestationGistId ?? opts.existingGistId ?? '',
        channel2CommitSha: state.channel2CommitSha,
      });
      markDone('publish_binding');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      if (err?.code === 'phase_0_pending') {
        // Substrate not booted — soft-skip, flow continues.
        markPhase0('publish_binding', err.message ?? 'substrate not booted');
      } else {
        markError('publish_binding', err?.code ?? 'unknown', err?.message);
      }
    }
    await saveAndEmit();
  }

  // ── Step 9: verify_binding ──
  if (state.steps.verify_binding.status !== 'done') {
    markRunning('verify_binding');
    try {
      const vr = await step9_verifyBinding({
        token: opts.token,
        githubUserId: opts.githubUserId,
        githubLogin: opts.githubLogin,
        repoOwner: opts.link.repoOwner,
        repoName: opts.link.repoName,
        devicePubkeyBase64: state.pubkeyBase64!,
        channel2CommitSha: state.channel2CommitSha,
        fetchFn: opts.fetchFn,
      });
      if (vr.status === 'unverified') {
        // Unverified is a soft error — we log it but don't block completion.
        markError(
          'verify_binding',
          'unverified',
          `Channel 1: ${vr.channel1.kind}, Channel 2: ${vr.channel2.kind}`,
        );
      } else {
        markDone('verify_binding');
      }
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      markError('verify_binding', err?.code ?? 'unknown', err?.message);
      // Don't throw — binding verification failure is non-fatal for join.
    }
    await saveAndEmit();
  }

  // ── Step 10: route_insights ──
  markDone('route_insights');
  state.completedAt = Date.now();
  await saveAndEmit();

  return state;
}

// ─── error class ─────────────────────────────────────────────────────────────

export class JoinStepError extends Error {
  constructor(
    public readonly stepId: JoinStepId,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JoinStepError';
  }
}

// ─── state persistence helpers ────────────────────────────────────────────────

function joinStateDir(): string {
  return resolve(homedir(), '.papercusp', 'join-state');
}

function joinStatePath(slug: string): string {
  return join(joinStateDir(), `${slug}.json`);
}

async function defaultReadState(slug: string): Promise<JoinState | null> {
  const p = joinStatePath(slug);
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as JoinState;
  } catch {
    return null;
  }
}

async function defaultWriteState(slug: string, state: JoinState): Promise<void> {
  const dir = joinStateDir();
  await mkdir(dir, { recursive: true });
  await writeFile(joinStatePath(slug), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ─── crypto helpers ───────────────────────────────────────────────────────────

async function signWithKeychain(keychainId: string, payload: Buffer): Promise<string> {
  const loaded = await keychainLoad(keychainId);
  if (loaded.kind !== 'ok') {
    throw new JoinStepError(
      'push_contributor_file',
      'keychain_missing',
      'device private key not found in keychain: ' + keychainId,
    );
  }
  const privateKey = require('node:crypto').createPrivateKey({
    key: loaded.value,
    format: 'der',
    type: 'pkcs8',
  });
  const sig = nodeSign(null, payload, privateKey);
  return sig.toString('base64');
}

// ─── execFile default ─────────────────────────────────────────────────────────

async function defaultExecFile(
  file: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFile(file, args, { ...(opts ?? {}), encoding: 'utf8' });
}
