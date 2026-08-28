/**
 * Background immutable dependency-generation producer (P-004 / WI-305952).
 *
 * Git-sync calls this after its publication legs settle.  The expensive
 * dependency-tree walk/copy stays in the existing dependency-generation.sh
 * store; this module only adds orchestration around that store:
 *
 *   candidate commit -> cheap immutable input fingerprint -> atomic attempt
 *   marker on the existing git-sync routine -> existing publisher -> ready or
 *   failed marker + awaitable event.
 *
 * The marker is deliberately latest-state metadata on the existing routine,
 * not a second cache or scheduler.  The generation store's .inputs index remains
 * the durable many-key cache.  A gate whose exact marker has already rotated out
 * falls back to that index and therefore remains correct across version skew.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { createTextCollector } from '../child-output';
import { emitAwaitedEvent } from '../events/await/engine';
import { createNotifyBus } from '../pg-notify-bus';

export const DEPENDENCY_PREBUILD_NOTIFY_CHANNEL = 'papercusp_dependency_prebuild_changed';
export const DEPENDENCY_PREBUILD_EVENT_PREFIX = 'dependency-generation:prebuild';
export const DEPENDENCY_PREBUILD_IDLE_TIMEOUT_MS = 30 * 60_000;
export const DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS = 90 * 60_000;
export const DEPENDENCY_PREBUILD_RETRY_COOLDOWN_MS = 5 * 60_000;
export const DEPENDENCY_PREBUILD_WAIT_MS = 30_000;
export const DEPENDENCY_PREBUILD_RECONCILE_MS = 1_000;

const FULL_COMMIT_RE = /^[0-9a-f]{40,64}$/i;
const INPUT_FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const GENERATION_ID_RE = /^v1-[0-9a-f]{64}$/i;

export interface DependencyPrebuildTarget {
  workspaceId: string;
  installSlug: string;
}

interface DependencyPrebuildBase {
  schema: 1;
  key: string;
  candidate: string;
  inputFingerprint: string;
  attemptId: string;
  queuedAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  producerPid: number;
  childPid: number | null;
}

export interface DependencyPrebuildBuildingState extends DependencyPrebuildBase {
  status: 'building';
  completedAtMs: null;
}

export interface DependencyPrebuildReadyState extends DependencyPrebuildBase {
  status: 'ready';
  completedAtMs: number;
  identity: string;
  token: string;
  reused: boolean;
}

export interface DependencyPrebuildFailedState extends DependencyPrebuildBase {
  status: 'failed';
  completedAtMs: number;
  error: string;
}

export type DependencyPrebuildState =
  | DependencyPrebuildBuildingState
  | DependencyPrebuildReadyState
  | DependencyPrebuildFailedState;

export interface DependencyPrebuildRequest extends DependencyPrebuildTarget {
  candidate: string;
  integrationRoot: string;
  toolingRoot: string;
  queuedAtMs?: number;
}

export interface DependencyPrebuildCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}

export interface DependencyPrebuildCommandOptions {
  cwd: string;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  onSpawn?: (pid: number) => void;
  onProgress?: () => void;
}

export type DependencyPrebuildCommand = (
  command: string,
  args: string[],
  options: DependencyPrebuildCommandOptions,
) => Promise<DependencyPrebuildCommandResult>;

export interface DependencyPrebuildDeps {
  command?: DependencyPrebuildCommand;
  readState?: (target: DependencyPrebuildTarget) => Promise<DependencyPrebuildState | null>;
  claimState?: (target: DependencyPrebuildTarget, state: DependencyPrebuildBuildingState) => Promise<boolean>;
  heartbeatState?: (target: DependencyPrebuildTarget, state: DependencyPrebuildBuildingState) => Promise<boolean>;
  settleState?: (
    target: DependencyPrebuildTarget,
    state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
  ) => Promise<boolean>;
  emitTerminal?: (
    target: DependencyPrebuildTarget,
    state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
  ) => Promise<void>;
  now?: () => number;
  attemptId?: () => string;
}

export type DependencyPrebuildRunOutcome =
  | 'ready'
  | 'failed'
  | 'deduped-building'
  | 'deduped-ready'
  | 'deduped-failed'
  | 'superseded';

function db(sql?: Sql): Sql {
  return sql ?? (getOrgPg().sql as unknown as Sql);
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function dependencyPrebuildKey(candidate: string, inputFingerprint: string): string {
  return `${candidate.toLowerCase()}:${inputFingerprint.toLowerCase()}`;
}

/** Strictly decode routine metadata. Malformed state is absence, never readiness. */
export function parseDependencyPrebuildState(value: unknown): DependencyPrebuildState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const candidate = typeof raw.candidate === 'string' ? raw.candidate : '';
  const inputFingerprint = typeof raw.inputFingerprint === 'string' ? raw.inputFingerprint : '';
  const key = typeof raw.key === 'string' ? raw.key : '';
  const attemptId = typeof raw.attemptId === 'string' ? raw.attemptId : '';
  const queuedAtMs = finiteInt(raw.queuedAtMs);
  const startedAtMs = finiteInt(raw.startedAtMs);
  const updatedAtMs = finiteInt(raw.updatedAtMs);
  const producerPid = finiteInt(raw.producerPid);
  const hasChildPid = Object.prototype.hasOwnProperty.call(raw, 'childPid');
  const childPid = raw.childPid === null ? null : finiteInt(raw.childPid);
  if (
    raw.schema !== 1 ||
    !FULL_COMMIT_RE.test(candidate) ||
    !INPUT_FINGERPRINT_RE.test(inputFingerprint) ||
    key !== dependencyPrebuildKey(candidate, inputFingerprint) ||
    !attemptId ||
    queuedAtMs === null ||
    startedAtMs === null ||
    updatedAtMs === null ||
    producerPid === null ||
    !hasChildPid
  ) {
    return null;
  }
  const base: DependencyPrebuildBase = {
    schema: 1,
    key,
    candidate,
    inputFingerprint,
    attemptId,
    queuedAtMs,
    startedAtMs,
    updatedAtMs,
    producerPid,
    childPid,
  };
  if (raw.status === 'building' && raw.completedAtMs === null) {
    return { ...base, status: 'building', completedAtMs: null };
  }
  const completedAtMs = finiteInt(raw.completedAtMs);
  if (completedAtMs === null) return null;
  if (raw.status === 'ready') {
    const identity = typeof raw.identity === 'string' ? raw.identity : '';
    const token = typeof raw.token === 'string' ? raw.token : '';
    if (!GENERATION_ID_RE.test(identity) || !token) return null;
    return {
      ...base,
      status: 'ready',
      completedAtMs,
      identity,
      token,
      reused: raw.reused === true,
    };
  }
  if (raw.status === 'failed') {
    const error = typeof raw.error === 'string' ? raw.error.trim() : '';
    if (!error) return null;
    return { ...base, status: 'failed', completedAtMs, error };
  }
  return null;
}

export async function readDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  sql?: Sql,
): Promise<DependencyPrebuildState | null> {
  const rows = await db(sql)<{ state: unknown }[]>`
    SELECT metadata->'dependency_prebuild' AS state
      FROM harness_shared.routines
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  return parseDependencyPrebuildState(rows[0]?.state ?? null);
}

async function notifyDependencyPrebuildChange(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildState,
  sql?: Sql,
): Promise<void> {
  const payload = JSON.stringify({
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    candidate: state.candidate,
    inputFingerprint: state.inputFingerprint,
    status: state.status,
  });
  try {
    await db(sql)`SELECT pg_notify(${DEPENDENCY_PREBUILD_NOTIFY_CHANNEL}, ${payload})`;
  } catch (error) {
    console.warn(
      `[dependency-prebuild] PG notify failed for ${target.installSlug}/${state.candidate.slice(0, 12)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Atomic cross-process dedupe claim on candidate+input identity. */
export async function claimDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildBuildingState,
  sql?: Sql,
): Promise<boolean> {
  const staleBeforeMs = state.startedAtMs - DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS;
  const retryBeforeMs = state.startedAtMs - DEPENDENCY_PREBUILD_RETRY_COOLDOWN_MS;
  const rows = await db(sql)<{ claimed: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
       AND CASE
             WHEN COALESCE(metadata->'dependency_prebuild'->>'queuedAtMs', '') ~ '^[0-9]+$'
               THEN (metadata->'dependency_prebuild'->>'queuedAtMs')::bigint
             ELSE 0
           END <= ${state.queuedAtMs}
       AND (
         metadata->'dependency_prebuild' IS NULL
         OR metadata->'dependency_prebuild'->>'key' IS DISTINCT FROM ${state.key}
         OR metadata->'dependency_prebuild'->>'status' NOT IN ('building', 'ready', 'failed')
         OR (
           metadata->'dependency_prebuild'->>'status' = 'building'
           AND CASE
                 WHEN COALESCE(metadata->'dependency_prebuild'->>'updatedAtMs', '') ~ '^[0-9]+$'
                   THEN (metadata->'dependency_prebuild'->>'updatedAtMs')::bigint
                 ELSE 0
               END < ${staleBeforeMs}
         )
         OR (
           metadata->'dependency_prebuild'->>'status' = 'failed'
           AND CASE
                 WHEN COALESCE(metadata->'dependency_prebuild'->>'completedAtMs', '') ~ '^[0-9]+$'
                   THEN (metadata->'dependency_prebuild'->>'completedAtMs')::bigint
                 ELSE 0
               END < ${retryBeforeMs}
         )
       )
    RETURNING true AS claimed
  `;
  const claimed = rows.length > 0;
  if (claimed) await notifyDependencyPrebuildChange(target, state, sql);
  return claimed;
}

export async function heartbeatDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildBuildingState,
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)<{ updated: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
       AND metadata->'dependency_prebuild'->>'attemptId' = ${state.attemptId}
       AND metadata->'dependency_prebuild'->>'key' = ${state.key}
       AND metadata->'dependency_prebuild'->>'status' = 'building'
    RETURNING true AS updated
  `;
  return rows.length > 0;
}

export async function settleDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)<{ updated: boolean }[]>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('dependency_prebuild', ${JSON.stringify(state)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${target.workspaceId}
       AND install_slug = ${target.installSlug}
       AND target_role = 'system:git-sync'
       AND metadata->'dependency_prebuild'->>'attemptId' = ${state.attemptId}
       AND metadata->'dependency_prebuild'->>'key' = ${state.key}
       AND metadata->'dependency_prebuild'->>'status' = 'building'
    RETURNING true AS updated
  `;
  const updated = rows.length > 0;
  if (updated) await notifyDependencyPrebuildChange(target, state, sql);
  return updated;
}

export async function emitDependencyPrebuildTerminal(
  target: DependencyPrebuildTarget,
  state: DependencyPrebuildReadyState | DependencyPrebuildFailedState,
): Promise<void> {
  const payload = {
    workspaceId: target.workspaceId,
    installSlug: target.installSlug,
    candidate: state.candidate,
    inputFingerprint: state.inputFingerprint,
    status: state.status,
    ...(state.status === 'ready' ? { identity: state.identity } : { error: state.error }),
  };
  const summary =
    state.status === 'ready'
      ? `dependency generation ${state.identity} ready for ${state.candidate.slice(0, 12)}`
      : `dependency generation prebuild failed for ${state.candidate.slice(0, 12)}: ${state.error.slice(0, 240)}`;
  await Promise.all([
    emitAwaitedEvent({
      key: `${DEPENDENCY_PREBUILD_EVENT_PREFIX}:${state.status}`,
      workspaceId: target.workspaceId,
      summary,
      payload,
      source: 'git-sync:dependency-prebuild',
    }),
    emitAwaitedEvent({
      key: `${DEPENDENCY_PREBUILD_EVENT_PREFIX}:${state.status}:${state.candidate}:${state.inputFingerprint}`,
      workspaceId: target.workspaceId,
      summary,
      payload,
      source: 'git-sync:dependency-prebuild',
    }),
  ]).then(() => undefined);
}

function terminateProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // It already exited between the timer and the kill.
    }
  }
}

export const runDependencyPrebuildCommand: DependencyPrebuildCommand = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = createTextCollector(child.stdout);
    const stderr = createTextCollector(child.stderr);
    let settled = false;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    const finish = (code: number, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        signal,
        timedOut,
      });
    };
    const terminate = (reason: string) => {
      if (settled || timedOut) return;
      timedOut = true;
      stderr.append(`${stderr.peek() ? '\n' : ''}${reason}`);
      if (child.pid) {
        terminateProcessGroup(child.pid, 'SIGTERM');
        setTimeout(() => terminateProcessGroup(child.pid!, 'SIGKILL'), 10_000).unref?.();
      }
      setTimeout(() => finish(-1), 20_000).unref?.();
    };
    const progress = () => {
      options.onProgress?.();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => terminate(`dependency prebuild made no output progress for ${options.idleTimeoutMs}ms`),
        options.idleTimeoutMs,
      );
      idleTimer.unref?.();
    };
    child.stdout?.on('data', progress);
    child.stderr?.on('data', progress);
    if (child.pid) options.onSpawn?.(child.pid);
    progress();
    hardTimer = setTimeout(
      () => terminate(`dependency prebuild exceeded ${options.hardTimeoutMs}ms hard ceiling`),
      options.hardTimeoutMs,
    );
    hardTimer.unref?.();
    child.on('error', (error) => {
      stderr.append(`${stderr.peek() ? '\n' : ''}${String(error)}`);
      finish(-1);
    });
    child.on('close', (code, signal) => finish(code ?? -1, signal));
  });

export function parseDependencyInputFingerprintResult(output: string, expectedCandidate: string): string | null {
  const match = /DEPENDENCY_INPUT_FINGERPRINT\s+schema=1\s+candidate=([0-9a-f]{40,64})\s+input=([0-9a-f]{64})\b/i.exec(
    output,
  );
  if (!match || match[1].toLowerCase() !== expectedCandidate.toLowerCase()) return null;
  return match[2].toLowerCase();
}

export function parseDependencyGenerationReadyResult(
  output: string,
  expectedInputFingerprint: string,
): Pick<DependencyPrebuildReadyState, 'identity' | 'token' | 'reused'> | null {
  const line = output.split(/\r?\n/).find((entry) => /DEPENDENCY_GENERATION_RESULT\s+schema=1\b/.test(entry));
  if (!line) return null;
  const identity = /\bidentity=([^\s]+)/.exec(line)?.[1] ?? '';
  const token = /\btoken=([^\s]+)/.exec(line)?.[1] ?? '';
  const inputFingerprint = /\binput=([0-9a-f]{64})\b/i.exec(line)?.[1] ?? '';
  if (
    !GENERATION_ID_RE.test(identity) ||
    !token ||
    inputFingerprint.toLowerCase() !== expectedInputFingerprint.toLowerCase()
  ) {
    return null;
  }
  return {
    identity,
    token,
    reused: /\breused=true\b/.test(line),
  };
}

function boundedFailure(result: DependencyPrebuildCommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const suffix = detail.slice(-4_000);
  const termination = result.timedOut
    ? 'timed out'
    : result.signal
      ? `terminated by ${result.signal}`
      : `exited ${result.code}`;
  return suffix ? `${termination}: ${suffix}` : termination;
}

/** Run one candidate producer. Cross-process dedupe is the routine-state claim. */
export async function runDependencyGenerationPrebuild(
  request: DependencyPrebuildRequest,
  deps: DependencyPrebuildDeps = {},
): Promise<DependencyPrebuildRunOutcome> {
  const command = deps.command ?? runDependencyPrebuildCommand;
  const readState = deps.readState ?? readDependencyPrebuildState;
  const claimState = deps.claimState ?? claimDependencyPrebuildState;
  const heartbeatState = deps.heartbeatState ?? heartbeatDependencyPrebuildState;
  const settleState = deps.settleState ?? settleDependencyPrebuildState;
  const emitTerminal = deps.emitTerminal ?? emitDependencyPrebuildTerminal;
  const now = deps.now ?? Date.now;
  const target: DependencyPrebuildTarget = {
    workspaceId: request.workspaceId,
    installSlug: request.installSlug,
  };
  const candidate = request.candidate.toLowerCase();
  if (!FULL_COMMIT_RE.test(candidate)) {
    throw new Error(`dependency prebuild candidate is not a full commit: ${request.candidate}`);
  }
  const generationScript = join(request.toolingRoot, 'apps/operator/bin/release/dependency-generation.sh');
  const fingerprintResult = await command(
    'bash',
    [generationScript, '--integration', request.integrationRoot, '--fingerprint-ref', candidate],
    {
      cwd: request.toolingRoot,
      idleTimeoutMs: 2 * 60_000,
      hardTimeoutMs: 5 * 60_000,
    },
  );
  const inputFingerprint = parseDependencyInputFingerprintResult(
    fingerprintResult.stdout + fingerprintResult.stderr,
    candidate,
  );
  if (fingerprintResult.code !== 0 || !inputFingerprint) {
    throw new Error(`dependency prebuild could not derive exact candidate input: ${boundedFailure(fingerprintResult)}`);
  }

  const queuedAtMs = request.queuedAtMs ?? now();
  const startedAtMs = now();
  const key = dependencyPrebuildKey(candidate, inputFingerprint);
  const current = await readState(target).catch(() => null);
  if (current?.key === key) {
    if (current.status === 'ready') return 'deduped-ready';
    if (current.status === 'building' && startedAtMs - current.updatedAtMs < DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS) {
      return 'deduped-building';
    }
    if (current.status === 'failed' && startedAtMs - current.completedAtMs < DEPENDENCY_PREBUILD_RETRY_COOLDOWN_MS) {
      return 'deduped-failed';
    }
  }

  let building: DependencyPrebuildBuildingState = {
    schema: 1,
    status: 'building',
    key,
    candidate,
    inputFingerprint,
    attemptId: (deps.attemptId ?? randomUUID)(),
    queuedAtMs,
    startedAtMs,
    updatedAtMs: startedAtMs,
    completedAtMs: null,
    producerPid: process.pid,
    childPid: null,
  };
  if (!(await claimState(target, building))) return 'superseded';

  // A ready selector for the same immutable inputs can be re-keyed to this
  // candidate without running the publisher. The setup consumer validates the
  // transported token again before copying.
  if (current?.status === 'ready' && current.inputFingerprint === inputFingerprint) {
    const completedAtMs = now();
    const ready: DependencyPrebuildReadyState = {
      ...building,
      status: 'ready',
      completedAtMs,
      updatedAtMs: completedAtMs,
      identity: current.identity,
      token: current.token,
      reused: true,
    };
    if (await settleState(target, ready)) await emitTerminal(target, ready);
    return 'ready';
  }

  let lastHeartbeatAtMs = building.updatedAtMs;
  const heartbeat = (patch: Partial<Pick<DependencyPrebuildBuildingState, 'childPid'>> = {}) => {
    const at = now();
    if (!patch.childPid && at - lastHeartbeatAtMs < 30_000) return;
    lastHeartbeatAtMs = at;
    building = { ...building, ...patch, updatedAtMs: at };
    void heartbeatState(target, building).catch(() => {});
  };
  const installSafeScript = join(request.toolingRoot, 'scripts/npm-install-safe.mjs');
  const result = await command(
    process.execPath,
    [
      installSafeScript,
      '--repo-root',
      request.integrationRoot,
      '--exec-under-lock',
      '--',
      'bash',
      generationScript,
      '--integration',
      request.integrationRoot,
      '--ensure-ref',
      candidate,
    ],
    {
      cwd: request.toolingRoot,
      idleTimeoutMs: DEPENDENCY_PREBUILD_IDLE_TIMEOUT_MS,
      hardTimeoutMs: DEPENDENCY_PREBUILD_HARD_TIMEOUT_MS,
      onSpawn: (pid) => heartbeat({ childPid: pid }),
      onProgress: () => heartbeat(),
    },
  );
  const completedAtMs = now();
  const parsed = parseDependencyGenerationReadyResult(result.stdout + result.stderr, inputFingerprint);
  if (result.code === 0 && parsed) {
    const ready: DependencyPrebuildReadyState = {
      ...building,
      status: 'ready',
      completedAtMs,
      updatedAtMs: completedAtMs,
      ...parsed,
    };
    if (await settleState(target, ready)) await emitTerminal(target, ready);
    return 'ready';
  }
  const failed: DependencyPrebuildFailedState = {
    ...building,
    status: 'failed',
    completedAtMs,
    updatedAtMs: completedAtMs,
    error:
      result.code === 0 ? 'publisher completed without a matching immutable generation result' : boundedFailure(result),
  };
  if (await settleState(target, failed)) await emitTerminal(target, failed);
  return 'failed';
}

const notifyState = pinModuleState('@papercusp/operator-core.dependency-prebuild-notify-bus', () => ({
  bus: createNotifyBus(DEPENDENCY_PREBUILD_NOTIFY_CHANNEL, 'dependency-prebuild'),
}));

export interface AwaitDependencyPrebuildOptions {
  timeoutMs?: number;
  reconcileMs?: number;
}

export interface AwaitDependencyPrebuildDeps {
  readState?: (target: DependencyPrebuildTarget) => Promise<DependencyPrebuildState | null>;
  subscribe?: (handler: (payload: string) => void) => () => void;
  now?: () => number;
}

/**
 * Push-first cross-process wait with a one-second state reconciliation backstop.
 * Subscribe-before-read closes the lost-wake window; the sweep covers a failed
 * LISTEN and keeps state (not notification delivery) authoritative.
 */
export async function awaitDependencyPrebuildState(
  target: DependencyPrebuildTarget,
  candidate: string,
  inputFingerprint: string,
  options: AwaitDependencyPrebuildOptions = {},
  deps: AwaitDependencyPrebuildDeps = {},
): Promise<DependencyPrebuildState | null> {
  const key = dependencyPrebuildKey(candidate, inputFingerprint);
  const readState = deps.readState ?? readDependencyPrebuildState;
  const subscribe = deps.subscribe ?? ((handler) => notifyState.bus.subscribe(handler));
  const now = deps.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_PREBUILD_WAIT_MS;
  const reconcileMs = options.reconcileMs ?? DEPENDENCY_PREBUILD_RECONCILE_MS;
  const deadline = now() + timeoutMs;
  let wake: (() => void) | null = null;
  const unsubscribe = subscribe((payload) => {
    try {
      const parsed = JSON.parse(payload) as Partial<DependencyPrebuildTarget> & {
        candidate?: string;
        inputFingerprint?: string;
      };
      if (
        parsed.workspaceId !== target.workspaceId ||
        parsed.installSlug !== target.installSlug ||
        parsed.candidate?.toLowerCase() !== candidate.toLowerCase() ||
        parsed.inputFingerprint?.toLowerCase() !== inputFingerprint.toLowerCase()
      ) {
        return;
      }
    } catch {
      // An empty/legacy payload is still a valid edge: re-read authoritative state.
    }
    wake?.();
  });
  try {
    while (true) {
      const current = await readState(target);
      if (!current || current.key !== key || current.status !== 'building') {
        return current?.key === key ? current : null;
      }
      const remaining = deadline - now();
      if (remaining <= 0) return current;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        wake = finish;
        const timer = setTimeout(finish, Math.min(reconcileMs, remaining));
        timer.unref?.();
      });
    }
  } finally {
    wake = null;
    unsubscribe();
  }
}
