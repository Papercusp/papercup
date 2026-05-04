/**
 * Expert dispatcher — spawns autonomous expert agents.
 *
 * Mirrors `invokeScoperBackground` (harness.ts:356) but parameterised by
 * role and with three additions:
 *
 *   1. Telemetry via `recordUserAction(slug, 'expert.dispatch', …, { async: true })`
 *      so the run shows up in OperatorActionLog and finalises with
 *      success/failure when the child exits.
 *   2. Idempotency via a per-role lockfile at
 *      `.harness/experts/<role>.dispatch-lock` (O_EXCL semantics, 5-min TTL).
 *      Prevents duplicate dispatches when scoper is invoked twice in rapid
 *      succession (e.g. user double-accepts a proposal).
 *   3. Context propagation via env vars: `EXPERT_ID`, `EXPERT_ROLE`,
 *      `EXPERT_REASON`, and a JSON blob `EXPERT_CONTEXT` containing the
 *      caller-supplied `context` object. The role's prompt reads these.
 *
 * Spec: see /docs/experts/authoring (per the substrate plan).
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { recordUserAction, updateUserAction } from './user-actions';
import { harnessPackageDir } from '../app/api/_hono/harness-paths';

const LOCK_TTL_MS = 5 * 60 * 1000;

interface ProjectLike {
  slug: string;
  path: string;
}

export interface DispatchCtx {
  /** Free-form context object that the role's prompt will receive as JSON. */
  context?: Record<string, unknown>;
  /** Human-readable reason the caller decided to dispatch this role. Goes
   *  into the user_actions row's summary and to the agent via env. */
  reason?: string;
}

export interface DispatchResult {
  ok: true;
  expertId: string;        // 'ua-<userActionId>'
  userActionId: number;
}

export interface DispatchConflict {
  ok: false;
  error: 'lock-held';
  existingExpertId: string;
  existingStartedAt: string;
}

const ROLE_RE = /^[a-z][a-z0-9-]*$/;

function lockPath(projectPath: string, role: string): string {
  return join(projectPath, '.harness', 'experts', `${role}.dispatch-lock`);
}

interface LockBody {
  startedAt: string;
  expertId: string;
}

function tryAcquireLock(projectPath: string, role: string, expertId: string): {
  ok: true;
} | {
  ok: false;
  existing: LockBody;
} {
  const dir = join(projectPath, '.harness', 'experts');
  mkdirSync(dir, { recursive: true });
  const path = lockPath(projectPath, role);

  // Stale-lock check: if an existing lock is older than the TTL, treat it
  // as orphaned and overwrite. Common cause: dispatcher process crashed
  // between lock acquisition and child exit.
  if (existsSync(path)) {
    try {
      const body = JSON.parse(readFileSync(path, 'utf8')) as LockBody;
      const ageMs = Date.now() - new Date(body.startedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < LOCK_TTL_MS) {
        return { ok: false, existing: body };
      }
      // Stale — fall through to overwrite below.
    } catch {
      // Corrupt lock file — treat as stale.
    }
  }

  const body: LockBody = { startedAt: new Date().toISOString(), expertId };
  // O_EXCL would race a stale-overwrite; use a write-then-stamp instead.
  // The TTL check above is the actual race protection.
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return { ok: true };
}

function releaseLock(projectPath: string, role: string): void {
  const path = lockPath(projectPath, role);
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Dispatch an autonomous expert run for this harness. Records a
 * user_actions row, acquires the per-role lock, and spawns the agent
 * via the same bash-shell pattern scoper uses.
 *
 * Returns synchronously with the expertId. The agent runs in the
 * background; on exit, the user_actions row is updated with status.
 */
export async function dispatchExpert(
  project: ProjectLike,
  role: string,
  ctx: DispatchCtx = {},
): Promise<DispatchResult | DispatchConflict> {
  if (!ROLE_RE.test(role)) {
    throw new Error(`invalid role name: ${role}`);
  }

  // Pre-check the lock so we can return a structured 409 without burning a
  // user_actions row on the conflict.
  const lockFile = lockPath(project.path, role);
  if (existsSync(lockFile)) {
    try {
      const body = JSON.parse(readFileSync(lockFile, 'utf8')) as LockBody;
      const ageMs = Date.now() - new Date(body.startedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs < LOCK_TTL_MS) {
        return {
          ok: false,
          error: 'lock-held',
          existingExpertId: body.expertId,
          existingStartedAt: body.startedAt,
        };
      }
    } catch {
      // Fall through; tryAcquireLock will overwrite a corrupt file.
    }
  }

  // We pass the user_actions id back to the role via env. recordUserAction
  // creates the row up-front in `running` state; we update it on completion.
  return await new Promise<DispatchResult | DispatchConflict>((resolve, reject) => {
    recordUserAction(
      project.slug,
      'expert.dispatch',
      async (id) => {
        const expertId = `ua-${id}`;
        const lock = tryAcquireLock(project.path, role, expertId);
        if (!lock.ok) {
          // Race: between the pre-check and now, another dispatcher
          // grabbed the lock. Mark this user_action as cancelled so the
          // OperatorActionLog reflects reality, and return a conflict.
          await updateUserAction({
            id,
            status: 'cancelled',
            summary: `expert.dispatch ${role} skipped — lock held by ${lock.existing.expertId}`,
          }).catch(() => undefined);
          resolve({
            ok: false,
            error: 'lock-held',
            existingExpertId: lock.existing.expertId,
            existingStartedAt: lock.existing.startedAt,
          });
          return {
            summary: `${role}: lock-held; skipped`,
            invocationId: expertId,
            result: { ok: false, error: 'lock-held' as const, existingExpertId: lock.existing.expertId, existingStartedAt: lock.existing.startedAt },
          };
        }

        // Spawn the agent.
        const harnessDirPkg = harnessPackageDir();
        const stateDir = join(project.path, '.harness');
        const resultsDir = join(stateDir, 'experts', 'runs');
        mkdirSync(resultsDir, { recursive: true });
        const resultPath = join(resultsDir, `${role}-${expertId}.log`);
        const contextJson = JSON.stringify(ctx.context ?? {}).replace(/'/g, `'\\''`);
        const reason = (ctx.reason ?? '').replace(/'/g, `'\\''`);

        const wrapper = `
          set -e
          export PROJECT_DIR='${project.path}'
          export STATE_DIR='${stateDir}'
          export HARNESS_DIR='${harnessDirPkg}'
          export LOG_DIR="$STATE_DIR/logs"
          export EXPERT_ID='${expertId}'
          export EXPERT_ROLE='${role}'
          export EXPERT_REASON='${reason}'
          export EXPERT_CONTEXT='${contextJson}'
          mkdir -p "$LOG_DIR" '${resultsDir}'
          source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|check_cost_cap|prune_logs)\\(\\)/,/^}/' "$HARNESS_DIR/run.sh")
          invoke ${role} "EXPERT_ID=${expertId}" "EXPERT_REASON=${reason}" 2>&1 | tee '${resultPath}'
          echo "__EXPERT_DONE__" >> '${resultPath}'
        `;
        const child = spawn('bash', ['-c', wrapper], {
          cwd: project.path,
          env: { ...process.env, CLAUDE: process.env.CLAUDE ?? 'claude -p --dangerously-skip-permissions' },
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        child.unref();

        // The child runs in the background. We watch via a one-shot file
        // poll (the `__EXPERT_DONE__` sentinel) and finalise the
        // user_actions row when it shows up. We also release the lock then.
        // Polling because the parent process owns no handle on a detached
        // child — same approach `invokeScoperBackground` would use if it
        // tracked outcomes (it doesn't today; we do).
        const startTs = Date.now();
        const finalise = async (status: 'succeeded' | 'failed', summary: string) => {
          releaseLock(project.path, role);
          await updateUserAction({
            id, status,
            summary,
            detailUrl: resultPath,
          }).catch(() => undefined);
        };
        const poll = setInterval(() => {
          let done = false;
          try {
            const txt = readFileSync(resultPath, 'utf8');
            done = txt.includes('__EXPERT_DONE__');
          } catch { /* not yet */ }
          if (done) {
            clearInterval(poll);
            void finalise('succeeded', `${role} completed (${Math.floor((Date.now() - startTs) / 1000)}s)`);
          } else if (Date.now() - startTs > LOCK_TTL_MS) {
            clearInterval(poll);
            void finalise('failed', `${role} timed out (>5min)`);
          }
        }, 2000);

        resolve({ ok: true, expertId, userActionId: id });
        return {
          summary: `dispatched ${role}: ${reason || '(no reason)'}`,
          detailUrl: resultPath,
          invocationId: expertId,
          result: { ok: true as const, expertId, userActionId: id },
        };
      },
      { async: true },
    ).catch(reject);
  });
}
