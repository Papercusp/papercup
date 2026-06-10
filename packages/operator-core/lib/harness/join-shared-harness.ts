/**
 * join-shared-harness — 6-step Model B orchestration (D-005).
 *
 * Steps per D-005 (papercusp-phase1b-bidirectional-federation-2026-06-01):
 *   1. oauth_attest          — device keypair + channel-1 OAuth + attestation gist
 *   2. clone_repo            — git-clone the shared GitHub repo
 *   3. publish_binding       — write-free: confirm the device attestation gist id (no repo write)
 *   4. boot_federate         — boot this harness's Model B substrate (joins swarm)
 *   5. await_admission_merge — bounded wait for a remote op (peer admitted + data flowing)
 *   6. route_insights        — signal completion (UI navigates to /harness/<slug>/insights)
 *
 * Deleted Autobase-era steps:
 *   join_hyperswarm       — dead stub (always phase_0_pending)
 *   seed_pg               — dead stub (always phase_0_pending)
 *   bootstrap_hyperbee    — replaced by boot_federate
 *   create_user_branch    — gone: write-free join (non-collaborator-join-fork-pr)
 *                           creates no user/<id> branch
 *   push_contributor_file — gone: write-free join publishes no shared-repo contributor
 *                           file; admission is the attestation gist + signed announce
 *   publish_binding (old) — was a Hyperbee-row step; Model B has no Hyperbee rows;
 *                           the binding IS the attestation gist + signed announce
 *   verify_binding        — rolled into the publish step + boot_federate admission
 *
 * Idempotent resume: the orchestrator persists `JoinState` to
 * `~/.papercusp/join-state/<slug>.json` after each step. On re-run, completed
 * steps are skipped. Delete the file to force a full re-join.
 *
 * Each step is exported individually for isolated unit testing.
 */

import { execFile as _execFile } from 'node:child_process';
import { workspacesRoot } from '../workspace-registry';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { HarnessLink } from './url-scheme';
import type { ChannelResult } from '../identity/binding-verifier-types';
import {
  loadOrGenerateDeviceKeypair,
  createAttestationGist,
} from '../identity/attest';
import type { DeviceKeypairId } from '../identity/attestation-types';
import {
  verifyChannel1,
} from '../identity/two-channel-verifier';
// Pure step vocabulary lives in the dependency-free leaf ./join-steps (so the
// client join UI imports it without this module's server fan-in). Imported for
// local use + re-exported below for existing server consumers.
import {
  ALL_STEP_IDS,
  JOIN_STEP_IDS,
  type JoinStepId,
  type JoinStepStatus,
  type JoinStepState,
} from './join-steps';
import { buildCloneUrl, cleanCloneUrl, redactToken } from './clone-url';

// Lazy promisify — import-safe in the operator-vite SPA bundle (node:util is
// browser-stubbed; a top-level promisify() call crashes at import → blank page).
// Deferred to first call; never invoked in the browser.
const execFile: (...a: unknown[]) => Promise<{ stdout: string; stderr: string }> = (...a) =>
  (promisify(_execFile) as (...x: unknown[]) => Promise<{ stdout: string; stderr: string }>)(...a);

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

// ─── step id + status types (re-exported from the ./join-steps leaf) ──────────

export type { JoinStepId, JoinStepStatus, JoinStepState } from './join-steps';

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
  /** Attestation gist id (set after step 1; carried on the announce). */
  attestationGistId?: string;
  /** GitHub user id (mirrors opts, for resume). */
  githubUserId?: number;
  /** GitHub login (mirrors opts, for resume). */
  githubLogin?: string;
}

// ALL_STEP_IDS / JOIN_STEP_IDS sourced from the ./join-steps leaf (imported
// above for local use) and re-exported here for existing callers.
export { ALL_STEP_IDS, JOIN_STEP_IDS };

function initialSteps(): Record<JoinStepId, JoinStepState> {
  const out = {} as Record<JoinStepId, JoinStepState>;
  for (const id of ALL_STEP_IDS) out[id] = { id, status: 'pending' };
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
  /** If set, re-use a previously-existing attestation gist id (skips gist creation). */
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
  /**
   * Injectable substrate booter for boot_federate (tests).
   * Receives (workspaceId, harnessSlug). Defaults to `bootSingleHarness`.
   */
  bootFederateFn?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
  /**
   * Injectable admitted-peer count reader for await_admission_merge (tests).
   * Returns the number of admitted REMOTE logs (0 = no peers yet).
   * Defaults to reading the booted handle's admitted map size - 1 (own log).
   */
  readAdmittedCountFn?: (workspaceId: string, harnessSlug: string) => number;
  /**
   * Timeout for await_admission_merge (ms). Default 30_000.
   */
  awaitAdmissionTimeoutMs?: number;
  /**
   * Poll interval for await_admission_merge (ms). Default 1_000.
   */
  awaitAdmissionPollMs?: number;
  /**
   * Injectable sleep for await_admission_merge (tests).
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Injectable Octokit for publish_binding (tests).
   */
  octokit?: unknown;
}

// ─── step 1: oauth_attest ────────────────────────────────────────────────────

export interface OauthAttestResult {
  keypair: DeviceKeypairId;
  channel1: ChannelResult;
  attestationGistId: string;
}

export async function step1_oauthAttest(opts: {
  token: string;
  claimedGithubUserId: number;
  githubLogin: string;
  keychainId: string;
  existingGistId?: string;
  fetchFn?: typeof fetch;
}): Promise<OauthAttestResult> {
  const keypair = await loadOrGenerateDeviceKeypair(opts.keychainId);
  const channel1 = await verifyChannel1({
    token: opts.token,
    claimedGithubUserId: opts.claimedGithubUserId,
    fetchFn: opts.fetchFn,
  });
  if (channel1.kind === 'fail') {
    throw new JoinStepError(
      'oauth_attest',
      channel1.reason,
      `Channel 1 OAuth check failed: ${channel1.reason}`,
    );
  }

  // Resolve or create the attestation gist (required for channel-2 contributor file).
  let attestationGistId = opts.existingGistId ?? '';
  if (!attestationGistId) {
    try {
      const gistResult = await createAttestationGist({
        keychainId: opts.keychainId,
        pubkeyBase64: keypair.pubkeyBase64,
        deviceLabel: 'unnamed-device',
        githubUserId: opts.claimedGithubUserId,
        githubLogin: opts.githubLogin,
        token: opts.token,
      });
      attestationGistId = gistResult.gistId;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JoinStepError(
        'oauth_attest',
        'gist_creation_failed',
        `Attestation gist creation failed: ${msg.slice(0, 300)}`,
      );
    }
  }

  return { keypair, channel1, attestationGistId };
}

// ─── step 2: clone_repo ──────────────────────────────────────────────────────

export interface CloneRepoResult {
  cloneDir: string;
}

export async function step2_cloneRepo(opts: {
  githubFullName: string;
  slug: string;
  /**
   * Optional gh token for an authenticated clone (B4). Required to clone a
   * PRIVATE upstream the joiner has read on; harmless for a public one. When
   * present the clone uses a token-embedded URL, then resets `origin` to the
   * token-free URL so the secret never persists in `.git/config`.
   */
  token?: string;
  execFileFn?: (
    file: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  mkdirFn?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
}): Promise<CloneRepoResult> {
  const { githubFullName, slug, token } = opts;
  const exF = opts.execFileFn ?? defaultExecFile;
  const mkF = opts.mkdirFn ?? ((p, o) => mkdir(p, o ?? {}));

  const clonesBase = resolve(workspacesRoot(), 'clones');
  const cloneDir = join(clonesBase, slug);

  if (existsSync(cloneDir)) {
    // Already cloned — idempotent.
    return { cloneDir };
  }

  await mkF(clonesBase, { recursive: true });
  const cloneUrl = buildCloneUrl(githubFullName, token);
  try {
    await exF('git', ['clone', '--depth', '1', cloneUrl, cloneDir]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // redactToken: never let an embedded x-access-token reach an error surface.
    throw new JoinStepError('clone_repo', 'clone_failed', redactToken(msg).slice(0, 300));
  }

  // De-tokenize origin so the gh token never persists in the cloned repo's
  // .git/config. Non-fatal — the clone already succeeded; a stale tokenized
  // origin is a hygiene issue, not a correctness one (gh tokens are short-lived).
  if (token) {
    try {
      await exF('git', [
        '-C', cloneDir, 'remote', 'set-url', 'origin', cleanCloneUrl(githubFullName),
      ]);
    } catch {
      // ignore — clone succeeded; origin de-tokenization is best-effort.
    }
  }

  return { cloneDir };
}

// ─── step 3: publish_binding ─────────────────────────────────────────────────
//
// Write-free join (non-collaborator-join-fork-pr-2026-06-02): the binding is the
// attestation GIST (created in step 1 oauth_attest) + the SIGNED announce (sent
// in step 4 boot_federate). There is NO shared-repo contributor file anymore, so
// this step performs NO repo write (a non-collaborator needs no write access to
// join). It confirms the attestation gist id resolved in step 1 is present — so
// peers can admit via `verifyAttestation` — and carries it forward. An empty
// gist id is a hard failure (a peer cannot verify an empty id).

export interface PublishBindingResult {
  attestationGistId: string;
}

export async function stepPublishBinding(opts: {
  attestationGistId: string;
}): Promise<PublishBindingResult> {
  if (!opts.attestationGistId) {
    throw new JoinStepError(
      'publish_binding',
      'attestation_gist_missing',
      'attestation gist id is empty — cannot publish a verifiable binding',
    );
  }
  return { attestationGistId: opts.attestationGistId };
}

// ─── step 4: boot_federate ───────────────────────────────────────────────────
//
// Boots this harness's Model B substrate via `bootSingleHarness`. The booter:
//   - opens / creates the per-harness corestore
//   - opens the peer's OWN writable log
//   - resolves the swarm binding from .papercusp/shared.json
//   - joins Hyperswarm + starts announce exchange
//   - starts the read-merge loop (admitted logs → PG)
//
// Soft-skip (phase_0_pending) on boot failure: clone + publish are done;
// federation completes on next online session.

export async function stepBootFederate(opts: {
  workspaceId: string;
  harnessSlug: string;
  bootFn?: (workspaceId: string, harnessSlug: string) => Promise<unknown>;
}): Promise<void> {
  const boot =
    opts.bootFn ??
    (async (wsId: string, slug: string) => {
      const mod = await import('../sync/hyperbee/boot-all');
      return mod.bootSingleHarness(wsId, slug);
    });
  await boot(opts.workspaceId, opts.harnessSlug);
}

// ─── step 5: await_admission_merge ───────────────────────────────────────────
//
// Bounded wait for at least one remote peer to be admitted and merged. This
// confirms federation is live. If the timeout elapses with no peer, the
// result is { remoteOpLanded: false } — the caller maps this to `phase_0_pending`
// (soft status, not an error). The substrate is already booted and will admit
// peers as they come online.

export interface AwaitAdmissionResult {
  remoteOpLanded: boolean;
}

export async function stepAwaitAdmissionMerge(opts: {
  workspaceId: string;
  harnessSlug: string;
  timeoutMs?: number;
  pollMs?: number;
  readAdmittedCountFn?: (workspaceId: string, harnessSlug: string) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<AwaitAdmissionResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  const readAdmitted =
    opts.readAdmittedCountFn ??
    ((wsId: string, slug: string): number => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../sync/hyperbee/boot-all') as typeof import('../sync/hyperbee/boot-all');
        const handle = mod.getBootedHarness(wsId, slug);
        if (!handle) return 0;
        // admitted includes own log; peers = admitted.size - 1
        return Math.max(0, handle.admitted.size - 1);
      } catch {
        return 0;
      }
    });

  if (timeoutMs <= 0) {
    return { remoteOpLanded: false };
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const count = readAdmitted(opts.workspaceId, opts.harnessSlug);
    if (count > 0) {
      return { remoteOpLanded: true };
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
  }

  return { remoteOpLanded: false };
}

// ─── step 6: route_insights ──────────────────────────────────────────────────

export interface RouteInsightsResult {
  insightsPath: string;
}

export function stepRouteInsights(slug: string): RouteInsightsResult {
  return { insightsPath: `/harness/${encodeURIComponent(slug)}/insights` };
}

// ─── orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the full 6-step Model B join flow (D-005).
 *
 * boot_federate failures are non-fatal (substrate may be unreachable).
 * await_admission_merge resolves soft (phase_0_pending) when no peer connects
 * within the timeout — the join still succeeds.
 *
 * Returns the final `JoinState`.
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

  function markDone(id: JoinStepId, detail?: string) {
    state!.steps[id] = { id, status: 'done', ...(detail ? { detail } : {}) };
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
        githubLogin: opts.githubLogin,
        keychainId: opts.keychainId,
        existingGistId: opts.existingGistId,
        fetchFn: opts.fetchFn,
      });
      state.pubkeyBase64 = r.keypair.pubkeyBase64;
      state.attestationGistId = r.attestationGistId;
      markDone('oauth_attest');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markError('oauth_attest', err?.code ?? 'unknown', msg);
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
        // Authenticated clone (B4): pass the joiner's gh token so a PRIVATE
        // upstream they have read on can be cloned. step2 de-tokenizes origin
        // afterward so the token never persists in .git/config.
        token: opts.token,
        execFileFn: opts.execFileFn,
        mkdirFn: opts.mkdirFn,
      });
      state.cloneDir = r.cloneDir;
      markDone('clone_repo');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markError('clone_repo', err?.code ?? 'unknown', msg);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 3: publish_binding (write-free: confirm the attestation gist id) ──
  if (state.steps.publish_binding.status !== 'done') {
    markRunning('publish_binding');
    const gistId = state.attestationGistId ?? opts.existingGistId ?? '';
    try {
      await stepPublishBinding({ attestationGistId: gistId });
      markDone('publish_binding');
    } catch (e: unknown) {
      const err = e instanceof JoinStepError ? e : null;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markError('publish_binding', err?.code ?? 'unknown', msg);
      await saveAndEmit();
      throw e;
    }
    await saveAndEmit();
  }

  // ── Step 4: boot_federate ──
  if (state.steps.boot_federate.status !== 'done' &&
      state.steps.boot_federate.status !== 'phase_0_pending') {
    markRunning('boot_federate');
    try {
      // The booter resolves the swarm binding from `.papercusp/shared.json` in
      // the clone — which only exists if the OWNER committed+pushed it. The
      // JOIN LINK carries everything the file holds (topic + github + repo_id),
      // so synthesize it when absent; otherwise a fresh joiner boots SILENTLY
      // local-only ("done" with no swarm join — found by the packaged
      // browse→join→federate smoke). The owner's committed copy always wins.
      if (state.cloneDir) {
        try {
          const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
          const { join: joinPath, dirname } = await import('node:path');
          const { HARNESS_SHARED_CONFIG_REL_PATH, HARNESS_SHARED_CONFIG_SCHEMA_VERSION } =
            await import('./harness-shared-config-types');
          const cfgPath = joinPath(state.cloneDir, HARNESS_SHARED_CONFIG_REL_PATH);
          // Only when the clone REALLY exists (unit tests mock the clone step).
          if (existsSync(state.cloneDir) && !existsSync(cfgPath)) {
            mkdirSync(dirname(cfgPath), { recursive: true });
            writeFileSync(
              cfgPath,
              `${JSON.stringify(
                {
                  claim_status: 'unclaimed',
                  created_at: Date.now(),
                  github_remote: `https://github.com/${opts.link.github}`,
                  github_repository_id: opts.link.repoId,
                  privacy: 'shared-private',
                  schema_version: HARNESS_SHARED_CONFIG_SCHEMA_VERSION,
                  topic: opts.link.topic,
                },
                null,
                2,
              )}\n`,
            );
          }
        } catch {
          // Best-effort — boot_federate's own soft-skip handles a bad clone dir.
        }
      }
      const { activeWorkspaceId } = await import('../workspace-registry');
      await stepBootFederate({
        workspaceId: activeWorkspaceId(),
        harnessSlug: opts.slug,
        bootFn: opts.bootFederateFn,
      });
      markDone('boot_federate');
    } catch (e: unknown) {
      // Non-fatal: DHT unreachable, port blocked, etc.
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markPhase0('boot_federate', `boot failed (will retry on next session): ${msg}`);
    }
    await saveAndEmit();
  }

  // ── Step 5: await_admission_merge ──
  if (state.steps.await_admission_merge.status !== 'done' &&
      state.steps.await_admission_merge.status !== 'phase_0_pending') {
    markRunning('await_admission_merge');
    try {
      const { activeWorkspaceId } = await import('../workspace-registry');
      const r = await stepAwaitAdmissionMerge({
        workspaceId: activeWorkspaceId(),
        harnessSlug: opts.slug,
        timeoutMs: opts.awaitAdmissionTimeoutMs ?? 30_000,
        pollMs: opts.awaitAdmissionPollMs ?? 1_000,
        readAdmittedCountFn: opts.readAdmittedCountFn,
        sleep: opts.sleepFn,
      });
      if (r.remoteOpLanded) {
        markDone('await_admission_merge', 'remote peer admitted + merge landed');
      } else {
        // Soft: no peer connected yet — federation completes when a peer comes online.
        markPhase0(
          'await_admission_merge',
          'no peer connected within timeout; federation will complete when a peer comes online',
        );
      }
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      markPhase0('await_admission_merge', `admission wait failed: ${msg}`);
    }
    await saveAndEmit();
  }

  // ── Step 6: route_insights ──
  markDone('route_insights');
  state.completedAt = Date.now();
  await saveAndEmit();

  return state;
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

// ─── execFile default ─────────────────────────────────────────────────────────

async function defaultExecFile(
  file: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFile(file, args, { ...(opts ?? {}), encoding: 'utf8' });
}
