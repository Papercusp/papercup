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
import { harnessPackageDir } from './harness-paths';
import { getRole } from './role-registry';

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

// Builtin role ids: simple slugs.
// Plugin-contributed role ids: `<plugin-slug>:<local-id>` where the
// plugin slug allows '@', '/', '.', '-' (npm scoped names).
const ROLE_RE = /^@?[a-z0-9][a-z0-9_/.-]*(:[a-z][a-z0-9-]*)?$/;

/** Sanitize a role id (which may contain `:`/`/`/`@` for plugin roles) for filesystem use. */
function safeRoleName(role: string): string {
  return role.replace(/[:/@]/g, '_');
}

function lockPath(projectPath: string, role: string): string {
  return join(projectPath, '.harness', 'experts', `${safeRoleName(role)}.dispatch-lock`);
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
        // Sanitize role id for filesystem use (`:`/`/`/`@` → `_`).
        const safeName = role.replace(/[:/@]/g, '_');
        const resultPath = join(resultsDir, `${safeName}-${expertId}.log`);
        const contextJson = JSON.stringify(ctx.context ?? {}).replace(/'/g, `'\\''`);
        const reason = (ctx.reason ?? '').replace(/'/g, `'\\''`);

        // Resolve role's budget cap (informational; agent self-respects via env).
        const roleManifest = (() => {
          try { return getRole(role, project.slug); } catch { return null; }
        })();
        const budgetCents = roleManifest?.budgetCents;

        // For plugin-contributed roles, materialise the plugin's prompt
        // into the harness's per-project prompts dir under a synthesised
        // role id, then invoke that. Built-in roles (no `:` in the id)
        // use the harness package's prompts directly via invoke().
        let invokeRole = role;
        let promptShadowDir: string | null = null;
        if (role.includes(':')) {
          const roleManifest = getRole(role, project.slug);
          if (!roleManifest || roleManifest.source.kind !== 'plugin') {
            throw new Error(`plugin role not found in registry: ${role}`);
          }
          const src = roleManifest.source;
          const promptSrc = join(src.dir, src.promptPath);
          if (!existsSync(promptSrc)) {
            throw new Error(`plugin role prompt missing: ${promptSrc}`);
          }
          // Synthesise a role id that invoke() can resolve via prompt
          // override config. We write to STATE_DIR/expert-prompts/ and
          // patch the invocation to read it via the existing
          // promptOverrides config.json mechanism — but to avoid mutating
          // the user's config.json mid-flight, we go via the env-var
          // PAPERCUSP_PROMPT_OVERRIDE path that invoke() will pick up.
          // The simpler proven path: write the prompt under a synthetic
          // name in $STATE_DIR/prompts/ and tell invoke() to use that
          // directory via $HARNESS_DIR override.
          //
          // Implementation chosen: we materialise the prompt at
          // $STATE_DIR/expert-prompts/<safeName>.md and run a fixed-name
          // synthetic invocation by SETTING $HARNESS_DIR to a per-run
          // shadow directory that contains a `prompts/<safeName>.md`
          // pointing at our materialised prompt. This way invoke() finds
          // the prompt without us needing to teach run.sh about plugin
          // paths or modify config.json.
          // Materialise under ramTmpRoot (Linux: /dev/shm tmpfs;
          // macOS+Windows: os.tmpdir() page-cache-backed) so the
          // harness directory stays pure-code. Bash subprocess sources
          // prompts from $HARNESS_DIR pointing here; cleanup happens
          // inline in the wrapper after invoke completes.
          const ramRoot = (process.platform === 'linux' && existsSync('/dev/shm'))
            ? '/dev/shm'
            : require('node:os').tmpdir();
          promptShadowDir = require('node:fs').mkdtempSync(
            join(ramRoot, `papercusp-expert-${safeName}-${expertId}-`),
          ) as string;
          mkdirSync(join(promptShadowDir, 'prompts'), { recursive: true });
          // Symlink to harness prompts so other roles still resolve
          // (the "shared" identity dir, base prompts, etc.). Then
          // overlay the plugin's prompt on top with the synthetic name.
          const fs2 = require('node:fs');
          for (const entry of fs2.readdirSync(harnessDirPkg)) {
            const target = join(harnessDirPkg, entry);
            const link = join(promptShadowDir, entry);
            if (entry === 'prompts') continue; // we own this one
            try { fs2.symlinkSync(target, link); } catch { /* may exist */ }
          }
          for (const entry of fs2.readdirSync(join(harnessDirPkg, 'prompts'))) {
            try {
              fs2.symlinkSync(
                join(harnessDirPkg, 'prompts', entry),
                join(promptShadowDir, 'prompts', entry),
              );
            } catch { /* may exist */ }
          }
          // Overlay the plugin prompt as <safeName>.md
          fs2.copyFileSync(promptSrc, join(promptShadowDir, 'prompts', `${safeName}.md`));
          // Write a tiny role.json so any registry-aware code can resolve
          // metadata for this run if needed.
          fs2.writeFileSync(
            join(promptShadowDir, 'prompts', `${safeName}.role.json`),
            JSON.stringify({
              id: safeName,
              whenUseful: roleManifest.whenUseful,
              output: roleManifest.output,
              alwaysFireOn: roleManifest.alwaysFireOn ?? [],
              budgetCents: roleManifest.budgetCents,
              featureSize: roleManifest.featureSize,
            }),
          );
          invokeRole = safeName;
          // The wrapper below will use $PROMPT_SHADOW_DIR as HARNESS_DIR.
          // We pass it via env so the cleanup at the end can rm it.
        }

        const promptShadowEnvAssign = (invokeRole !== role && promptShadowDir)
          ? `export HARNESS_DIR='${promptShadowDir.replace(/'/g, "'\\''")}'`
          : `export HARNESS_DIR='${harnessDirPkg}'`;

        const cleanupPromptShadow = (invokeRole !== role && promptShadowDir)
          ? `rm -rf '${promptShadowDir.replace(/'/g, "'\\''")}'`
          : ':';

        const wrapper = `
          set -e
          export PROJECT_DIR='${project.path}'
          export STATE_DIR='${stateDir}'
          ${promptShadowEnvAssign}
          export LOG_DIR="$STATE_DIR/logs"
          export EXPERT_ID='${expertId}'
          export EXPERT_ROLE='${role}'
          export EXPERT_REASON='${reason}'
          export EXPERT_CONTEXT='${contextJson}'
          export EXPERT_BUDGET_CENTS='${budgetCents ?? ''}'
          mkdir -p "$LOG_DIR" '${resultsDir}'
          source <(awk '/^(log|config_get|invoke|run_hook|snapshot_state|notify_event|harness_slug|fire_plugin_hook|check_cost_cap|prune_logs)\\(\\)/,/^}/' "${harnessDirPkg}/run.sh")
          invoke ${invokeRole} "EXPERT_ID=${expertId}" "EXPERT_REASON=${reason}" 2>&1 | tee '${resultPath}'
          ${cleanupPromptShadow}
          echo "__EXPERT_DONE__" >> '${resultPath}'
        `;
        // Decrypt search-provider keys from PG (Migration 047) and pass them
        // through as env vars so OMP's web_search providers see them.
        // Best-effort: PG unavailable / no keys → child runs without them.
        let searchProviderEnv: Record<string, string> = {};
        try {
          const { buildSpawnEnv } = await import('./search-provider-credentials');
          searchProviderEnv = await buildSpawnEnv();
        } catch { /* ignore */ }
        const child = spawn('bash', ['-c', wrapper], {
          cwd: project.path,
          env: {
            ...process.env,
            ...searchProviderEnv,
            CLAUDE: process.env.AGENT_CMD ?? process.env.CLAUDE ?? 'omp -p',
          },
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

        // Sum total cost from all stream-json log files belonging to this run.
        // run_id pattern is `<ts>-<safeName>` per invoke(); we match prefix.
        const sumCostUsd = (): number => {
          const fs = require('node:fs');
          try {
            const dir = join(stateDir, 'logs');
            const files = fs.readdirSync(dir).filter((f: string) =>
              f.endsWith('.jsonl') && f.includes(`-${invokeRole}`),
            );
            let total = 0;
            for (const f of files) {
              try {
                const raw = fs.readFileSync(join(dir, f), 'utf8');
                for (const line of raw.split('\n')) {
                  if (!line) continue;
                  try {
                    const obj = JSON.parse(line);
                    // Two known shapes from claude-cli: top-level `result`
                    // events carry `total_cost_usd`; older streams put it
                    // at the root.
                    const c = obj?.total_cost_usd ?? obj?.result?.total_cost_usd;
                    if (typeof c === 'number') total = Math.max(total, c);
                  } catch { /* skip non-json line */ }
                }
              } catch { /* skip unreadable file */ }
            }
            return total;
          } catch { return 0; }
        };

        // For `output.kind === 'spec'` roles, the agent writes its
        // bullets to a known per-expert file. On success, we append them
        // to the project's SPEC.md under a marker comment. The next
        // scoper-replan picks them up alongside user-authored bullets.
        const appendSpecBulletsIfNeeded = async (status: 'succeeded' | 'failed') => {
          if (status !== 'succeeded') return;
          if (roleManifest?.output?.kind !== 'spec') return;
          const fs = require('node:fs');
          const bulletsPath = join(stateDir, 'expert-spec-bullets', `${expertId}.md`);
          let bullets = '';
          try { bullets = fs.readFileSync(bulletsPath, 'utf8').trim(); } catch { /* nothing to append */ }
          if (!bullets) return;
          const specPath = join(project.path, 'SPEC.md');
          if (!fs.existsSync(specPath)) return;
          const section = (roleManifest.output as { specSection?: string }).specSection ?? `expert:${role}`;
          const block = `\n<!-- appended by ${role} (${expertId}) at ${new Date().toISOString()} — section: ${section} -->\n${bullets}\n`;
          try { fs.appendFileSync(specPath, block, 'utf8'); } catch { /* best-effort */ }
        };

        const finalise = async (status: 'succeeded' | 'failed', summary: string) => {
          await appendSpecBulletsIfNeeded(status).catch(() => undefined);
          releaseLock(project.path, role);
          // Compute cost vs budget for telemetry. If we're over budget,
          // append a warning to the summary so the OperatorActionLog row
          // surfaces it; downstream tuning of the role's whenUseful or
          // budgetCents is informed by this signal.
          let withCost = summary;
          try {
            const costUsd = sumCostUsd();
            const costCents = Math.round(costUsd * 100);
            if (costCents > 0) {
              withCost = `${summary} · cost=${costUsd.toFixed(3)}`;
              if (typeof budgetCents === 'number' && budgetCents > 0 && costCents > budgetCents) {
                withCost += ` · OVER BUDGET (cap=${(budgetCents / 100).toFixed(2)})`;
              }
            }
          } catch { /* cost calc failure shouldn't block finalise */ }
          await updateUserAction({
            id, status,
            summary: withCost,
            detailUrl: resultPath,
          }).catch(() => undefined);
        };
        // Hard cost-cap enforcement: if the agent's cumulative
        // total_cost_usd exceeds budgetCents (with a small overshoot
        // tolerance for the in-flight chunk that triggered the check),
        // kill the entire process group. detached:true above means the
        // child became its own group leader; `process.kill(-pid)`
        // signals every descendant including claude + its tool calls.
        // Without this, a runaway prompt could quietly burn through
        // the budget despite our advisory env-var hint.
        const childPid = child.pid;
        const HARD_KILL_OVERSHOOT_RATIO = 1.15; // allow 15% slop before killing
        let killedForBudget = false;

        const poll = setInterval(() => {
          let done = false;
          try {
            const txt = readFileSync(resultPath, 'utf8');
            done = txt.includes('__EXPERT_DONE__');
          } catch { /* not yet */ }

          // Mid-run budget check (cheap; sums one or two .jsonl files).
          if (!done && !killedForBudget && typeof budgetCents === 'number' && budgetCents > 0 && childPid) {
            try {
              const cost = sumCostUsd();
              const cents = Math.round(cost * 100);
              if (cents > budgetCents * HARD_KILL_OVERSHOOT_RATIO) {
                killedForBudget = true;
                clearInterval(poll);
                try { process.kill(-childPid, 'SIGTERM'); } catch { /* group may already be gone */ }
                // Give SIGTERM a beat; if it didn't take, escalate.
                setTimeout(() => {
                  try { process.kill(-childPid, 'SIGKILL'); } catch { /* ignore */ }
                }, 2000);
                void finalise(
                  'failed',
                  `${role} KILLED — over budget at ${cost.toFixed(3)} (cap ${(budgetCents / 100).toFixed(2)})`,
                );
                return;
              }
            } catch { /* cost calc failure shouldn't crash the poll */ }
          }

          if (done) {
            clearInterval(poll);
            void finalise('succeeded', `${role} completed (${Math.floor((Date.now() - startTs) / 1000)}s)`);
          } else if (Date.now() - startTs > LOCK_TTL_MS) {
            // Wall-clock timeout — also a SIGTERM the child group; otherwise
            // detached children outlive their tracking.
            if (childPid) {
              try { process.kill(-childPid, 'SIGTERM'); } catch { /* ignore */ }
              setTimeout(() => {
                try { process.kill(-childPid, 'SIGKILL'); } catch { /* ignore */ }
              }, 2000);
            }
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
