/**
 * join-shared-harness — 9-step orchestration for Entry 4 (P-009).
 *
 * Steps per v5 §3 Entry 4:
 *   1. oauth_attest        — ensure device keypair + channel-1 OAuth re-check
 *   2. clone_repo          — git-clone the shared GitHub repo (P-008 helper)
 *   3. join_hyperswarm     — join Hyperswarm topic  [STUB: phase_0_pending]
 *   4. bootstrap_hyperbee  — replicate Autobase     [STUB: phase_0_pending]
 *   5. seed_pg             — seed local PG from projection  [STUB: phase_0_pending]
 *   6. create_user_branch  — create user/<github_user_id> branch + worktree
 *   7. push_contributor_file — push signed .harness/contributors/<login>.json
 *   8. publish_binding     — publish contributor row to Hyperbee  [STUB: phase_0_pending]
 *   9. verify_binding      — two-channel binding verification (P-075)
 *  10. route_insights      — signal completion (UI navigates to /harness/<slug>/insights)
 *
 * Stubs: steps 3, 4, 5, 8 depend on Hyperswarm/Autobase/Hyperbee (Phase 5a,
 * currently DEFERRED). They produce `JoinStepStatus.phase_0_pending` and are
 * skipped during orchestration without failing the flow. All other steps run.
 *
 * Idempotent resume: the orchestrator persists `JoinState` to
 * `~/.papercusp/join-state/<slug>.json` after each step. On re-run, completed
 * steps are skipped. Delete the file to force a full re-join.
 *
 * Each step is exported individually for isolated unit testing (P-009b).
 */

import { execFile as _execFile } from 'node:child_process';
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

  const clonesBase = resolve(homedir(), '.papercusp-workspaces', 'clones');
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
// STUB: Phase 5a deferred.

export async function step4_bootstrapHyperbee(_opts: {
  topic: string;
}): Promise<void> {
  throw new JoinStepError(
    'bootstrap_hyperbee',
    'phase_0_pending',
    'Hyperbee bootstrap deferred until Phase 5a',
  );
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

export async function step6_createUserBranch(opts: {
  cloneDir: string;
  githubUserId: number;
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<void> {
  const exF = opts.execFileFn ?? defaultExecFile;
  const branch = contributorBranchRef(opts.githubUserId);
  const cwd = opts.cloneDir;

  // Check if branch already exists locally.
  try {
    await exF('git', ['rev-parse', '--verify', branch], { cwd });
    // Branch exists — nothing to do.
    return;
  } catch {
    // Doesn't exist locally — create it.
  }

  // Try to track from remote first (in case a prior attempt pushed).
  try {
    await exF('git', ['checkout', '--track', `origin/${branch}`], { cwd });
    return;
  } catch {
    // Remote branch doesn't exist either — create fresh.
  }

  try {
    await exF('git', ['checkout', '-b', branch], { cwd });
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
  cloneDir: string;
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
  const cwd = opts.cloneDir;

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
// STUB: Phase 5a deferred.

export async function step8_publishBinding(_opts: {
  githubUserId: number;
  githubLogin: string;
  pubkeyBase64: string;
  attestationGistId: string;
}): Promise<void> {
  throw new JoinStepError(
    'publish_binding',
    'phase_0_pending',
    'Hyperbee binding publication deferred until Phase 5a',
  );
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

  // ── Steps 3-5: Phase-0 stubs (skip without failing) ──
  for (const stubId of ['join_hyperswarm', 'bootstrap_hyperbee', 'seed_pg'] as JoinStepId[]) {
    if (state.steps[stubId].status !== 'done' && state.steps[stubId].status !== 'phase_0_pending') {
      markPhase0(stubId, 'deferred until Phase 5a (Hyperswarm/Autobase)');
    }
  }
  await saveAndEmit();

  const cloneDir = state.cloneDir!;

  // ── Step 6: create_user_branch ──
  if (state.steps.create_user_branch.status !== 'done') {
    markRunning('create_user_branch');
    try {
      await step6_createUserBranch({
        cloneDir,
        githubUserId: opts.githubUserId,
        execFileFn: opts.execFileFn,
      });
      markDone('create_user_branch');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      markError('create_user_branch', err?.code ?? 'unknown', err?.message);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 7: push_contributor_file ──
  if (state.steps.push_contributor_file.status !== 'done') {
    markRunning('push_contributor_file');
    const gistId = state.attestationGistId ?? opts.existingGistId ?? '';
    try {
      const r = await step7_pushContributorFile({
        cloneDir,
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

  // ── Step 8: publish_binding (Phase-0 stub) ──
  if (state.steps.publish_binding.status !== 'done' && state.steps.publish_binding.status !== 'phase_0_pending') {
    markPhase0('publish_binding', 'deferred until Phase 5a (Hyperbee)');
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
