/**
 * env-operator-launcher — install-time provisioning of the local env operators
 * (dogfood-silent-canonical-hive-join P-017, owner directives D-006/D-007/D-009).
 *
 * The cross-platform env switcher (EnvSwitcherBar) self-hides on a packaged,
 * single-operator install: only ONE env (the running sidecar) is reachable, and the
 * bar needs ≥2. This module brings the OTHER *enabled* env operators up — spawning
 * each from the already-cloned `papercup` source (bootstrap-papercusp-hive clones it)
 * on its fixed dev-box port (dev :3270 / prod :3070 / staging :3170), all sharing the
 * ONE embedded Postgres via RLS — so the switcher lights up. It is the missing
 * "install brings up the chosen local operators" half of D-006; the data/control
 * contract (dev-operators.ts, env-switcher-prefs.ts, the route + bar) already shipped
 * (D-009). This module does NOT change that contract — it just starts the operators
 * the reachability probe already reports.
 *
 * ── SAFETY: the EI-126 single-writer invariant is load-bearing ──────────────────────
 * Only the PRIMARY operator may run the shared-DB background machinery (the hyperbee
 * substrate, git-export drains, DBOS scheduled workflows). TWO writers against one
 * papercusp DB caused the DBOS appVersion war, doubled drain loops, and the
 * plan-content federation echo that rewrote single plans ~100k times (a 102 GB
 * substrate_outbox — host-bootstrap.ts EI-126). So every operator THIS launcher spawns
 * is strictly REQUEST-ONLY: `PAPERCUSP_BACKGROUND_WORKERS=0` (which short-circuits the
 * substrate / git-export / DBOS / periodic-sweep boot blocks, all gated on
 * backgroundWorkersEnabled()). The existing primary keeps the single-writer machinery;
 * the extra envs are read/serve-only siblings, exactly as the dev box runs :3170
 * request-only alongside the :3070 primary today.
 *
 * ── DEFAULT-OFF, ships dark ─────────────────────────────────────────────────────────
 * The boot integration (host-bootstrap.ts) gates this on `PAPERCUSP_PROVISION_ENV_OPERATORS=1`
 * AND `PAPERCUSP_DESKTOP=1` — same idiom as the other default-off boot toggles
 * (PAPERCUSP_DBOS_ENABLE, PAPERCUSP_GIT_EXPORT_COMMIT). It ships dark because the spawn
 * path is toolchain-dependent and only END-TO-END verifiable on a real packaged build
 * (D-009 folds that verify into P-008/P-010). A release build flips it on by exporting
 * the env before the sidecar build, mirroring the PAPERCUP_DOGFOOD_HIVE_* injection in
 * bin/release-local.sh. The PLANNER below (planEnvOperatorLaunch) is a PURE function and
 * is fully unit-tested; the effectful spawn/probe/tree seams are injected.
 *
 * ── PROCESS LIFECYCLE / REAPING (handle at the live-verify, P-008/P-010) ────────────
 * Spawned operators are detached + unref'd so they outlive this boot turn. They are
 * request-only siblings of the primary, sharing its embedded Postgres — so when the
 * desktop (and its embedded PG) exits they lose their DB and idle/error rather than serve
 * stale state. But nothing here REAPS them on desktop shutdown (the dev box delegates that
 * to Tauri's beforeDevCommand watchdog in bin/dev-operator-ifneeded.sh). The packaged
 * build's live verify must own env-operator reaping — most cleanly the Tauri host tracking
 * the returned pids and TERM/KILL-ing them on exit, mirroring the dev watchdog. This is
 * deferred WITH the live spawn verify (not before it) because process-lifecycle behaviour
 * is platform-specific and only observable on a real build.
 *
 * ── GRACEFUL on a machine without the toolchain ─────────────────────────────────────
 * A non-bundled env runs from SOURCE (`npx tsx bin/hono-host.ts`, mirroring
 * bin/dev-operator-ifneeded.sh), so it needs Node + the cloned repo + installed deps.
 * When the toolchain or the source tree is absent, the env is reported unavailable
 * (skipReason 'no-toolchain' / 'no-source-tree') and simply not spawned — the switcher
 * keeps self-hiding for it. The bundled `release` env always works with no toolchain and
 * is never spawned from source here.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { detectPapercupRoot } from './register-papercusp';
import { readEnvSwitcherPrefs } from './env-switcher-prefs';

/** One provisionable env operator: which fixed local port it serves and which git
 *  tree/branch it represents (D-006). */
export interface EnvOperatorSpec {
  /** Stable env id — must match a `kind:'env'` DEV_OPERATORS id (dev-operators.ts). */
  id: string;
  /** Fixed local port (mirrors dev_wrapper.rs TARGETS + DEV_OPERATORS). */
  port: number;
  /** The git branch/tree this env serves (D-006). Used by the (release-build)
   *  worktree-preparation seam; the conservative default runs the detected checkout. */
  branch: string;
}

/**
 * The env operators install-time provisioning brings up (D-006's port/multi-operator
 * model). Deliberately EXCLUDES two DEV_OPERATORS entries:
 *  - `local` (:3055) — the Vite HMR frontend has NO operator of its own (its /api
 *    proxies to prod); in a packaged build it maps to the prod sidecar or is omitted
 *    (D-006), so there is nothing to spawn.
 *  - `release` — the immutable bundled sidecar (already running as the primary, or at
 *    PAPERCUSP_RELEASE_ORIGIN); it is never spawned from source (it IS the package).
 * Overlaps with whatever the primary/release already serves are handled by the
 * idempotent `already-reachable` / `is-self` skips in the planner — not by omission.
 */
export const PROVISIONABLE_ENV_OPERATORS: readonly EnvOperatorSpec[] = [
  { id: 'dev', port: 3270, branch: 'staging' }, // the user's working-tree checkout (the cloned source as-is)
  { id: 'prod', port: 3070, branch: 'main' }, // the green/release tree
  { id: 'staging', port: 3170, branch: 'staging' }, // the shared integration tree
] as const;

export type LaunchAction = 'spawn' | 'skip';
export type SkipReason =
  | 'disabled' // the user turned this env off (env-switcher-prefs)
  | 'is-self' // it's the port THIS operator already serves
  | 'already-reachable' // another operator already answers on this port (idempotent)
  | 'no-source-tree' // the cloned papercup source isn't present
  | 'no-toolchain'; // no Node/npx+tsx run path on this machine

export interface EnvOperatorPlanEntry extends EnvOperatorSpec {
  /** http origin the switcher would navigate to, e.g. http://127.0.0.1:3170. */
  origin: string;
  action: LaunchAction;
  /** Present iff action==='skip' — WHY it was skipped. */
  skipReason?: SkipReason;
}

export interface PlanEnvOperatorLaunchInput {
  /** Candidate specs (default PROVISIONABLE_ENV_OPERATORS). */
  specs?: readonly EnvOperatorSpec[];
  /** Env ids the user disabled (env-switcher-prefs `disabled`). */
  disabledIds?: readonly string[];
  /** Ports already served by a live operator (idempotent skip). */
  reachablePorts?: readonly number[];
  /** The port THIS operator listens on — never re-spawn self. */
  selfPort?: number | null;
  /** Whether the cloned `papercup` source tree exists (a launchable env runs from it). */
  hasSourceTree: boolean;
  /** Whether a Node/npx+tsx run path is available on this machine. */
  hasToolchain: boolean;
  /** Bind host for the rendered origin (default 127.0.0.1). */
  host?: string;
}

/**
 * PURE planner: decide, per env, spawn-or-skip and (when skipped) WHY. No side effects.
 *
 * Skip precedence (deterministic, most-specific first):
 *   disabled → is-self → already-reachable → no-source-tree → no-toolchain → spawn.
 * `disabled` wins over everything (an off env is never started regardless of state);
 * `is-self` / `already-reachable` win over the env gates so an already-up operator is
 * never reported as "no toolchain"; the source/toolchain gates apply only to an env we
 * would otherwise actually spawn.
 */
export function planEnvOperatorLaunch(
  input: PlanEnvOperatorLaunchInput,
): EnvOperatorPlanEntry[] {
  const specs = input.specs ?? PROVISIONABLE_ENV_OPERATORS;
  const host = input.host ?? '127.0.0.1';
  const disabled = new Set(input.disabledIds ?? []);
  const reachable = new Set(input.reachablePorts ?? []);
  const selfPort = input.selfPort ?? null;

  return specs.map((spec): EnvOperatorPlanEntry => {
    const origin = `http://${host}:${spec.port}`;
    const base = { ...spec, origin };
    const skip = (skipReason: SkipReason): EnvOperatorPlanEntry => ({
      ...base,
      action: 'skip',
      skipReason,
    });

    if (disabled.has(spec.id)) return skip('disabled');
    if (selfPort != null && selfPort === spec.port) return skip('is-self');
    if (reachable.has(spec.port)) return skip('already-reachable');
    if (!input.hasSourceTree) return skip('no-source-tree');
    if (!input.hasToolchain) return skip('no-toolchain');
    return { ...base, action: 'spawn' };
  });
}

/** A spawned operator handle (the bits the launcher reports + the boot path can reap). */
export interface SpawnedOperator {
  id: string;
  port: number;
  pid?: number;
}

export interface LaunchEnvOperatorsDeps {
  /** Candidate specs (default PROVISIONABLE_ENV_OPERATORS). */
  specs?: readonly EnvOperatorSpec[];
  /** Read the per-machine enabled/disabled prefs (default readEnvSwitcherPrefs). */
  readPrefs?: () => { disabled: string[] };
  /** Probe one origin for a live operator (default: GET /api/desktop/version). Never throws. */
  probe?: (origin: string) => Promise<boolean>;
  /** Resolve the cloned `papercup` source root (default detectPapercupRoot). null ⇒ absent. */
  detectSourceRoot?: () => string | null;
  /** Whether a Node/npx+tsx run path exists (default: a `which`-style check). */
  hasToolchain?: () => Promise<boolean>;
  /** This operator's listen port (default: PAPERCUSP_HONO_PORT / PORT). */
  selfPort?: number | null;
  /** Prepare the on-disk tree for an env (worktree/branch checkout) and return its path.
   *  DEFAULT: prepareEnvWorktree (env-tree-prepare.ts) — dev runs the working tree in
   *  place; prod/staging get their own git worktree on main/staging under
   *  ~/.papercusp/env-trees/ (D-006). It is idempotent + best-effort + returns null on any
   *  git failure (shallow/offline clone), so that env is simply skipped → the switcher
   *  self-hides it. Returning null ⇒ this env's tree couldn't be prepared → skipped. */
  prepareTree?: (entry: EnvOperatorPlanEntry, sourceRoot: string) => Promise<string | null>;
  /** Spawn one operator from `treePath` on its port (default: detached `npx tsx
   *  bin/hono-host.ts`, request-only). Returns the handle, or null on a spawn failure. */
  spawnOperator?: (
    entry: EnvOperatorPlanEntry,
    treePath: string,
  ) => SpawnedOperator | null;
  /** Delay between spawns (ms) to avoid embedded-PG migration contention on cold boot
   *  (staggered boot, D-006). Default 4000. */
  staggerMs?: number;
  /** Sleep seam (tests pass a no-op). Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Bind host (default 127.0.0.1). */
  host?: string;
  /** Log sink (default console.log). */
  log?: (message: string) => void;
}

export interface LaunchEnvOperatorsResult {
  /** The full plan (every candidate, spawn-or-skip + reason). */
  planned: EnvOperatorPlanEntry[];
  /** The operators actually spawned this run. */
  spawned: SpawnedOperator[];
  /** Skipped envs with their reason (mirrors planned skips + any prepare/spawn failure). */
  skipped: { id: string; reason: string }[];
}

/** Default reachability probe — GET /api/desktop/version, server-side (no CORS). Never throws. */
async function defaultProbe(origin: string, timeoutMs = 700): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(`${origin}/api/desktop/version`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** This operator's listen port (same env the host + dev-operators.ts read). */
function defaultSelfPort(): number | null {
  const raw = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Default toolchain check: is the cloned source's apps/operator runnable? We need an
 *  `npx`/`node` on PATH AND the operator entrypoint present. Best-effort, never throws. */
async function defaultHasToolchain(sourceRoot: string | null): Promise<boolean> {
  if (!sourceRoot) return false;
  try {
    // The operator entrypoint the dev-operator script runs (`npx tsx bin/hono-host.ts`).
    const entry = join(sourceRoot, 'apps', 'operator', 'bin', 'hono-host.ts');
    if (!existsSync(entry)) return false;
    // node is the runtime; npx ships with it. process.execPath is always present here,
    // but the SPAWNED env uses `npx tsx` from PATH, so require node_modules/.bin too.
    return existsSync(join(sourceRoot, 'node_modules', '.bin'));
  } catch {
    return false;
  }
}

/** Default spawn — mirror bin/dev-operator-ifneeded.sh's invocation, REQUEST-ONLY.
 *  Detached + unref'd + stdio:ignore so the spawned operator outlives this boot turn
 *  and never blocks it. The EI-126 single-writer knobs are the load-bearing safety here. */
function defaultSpawnOperator(
  entry: EnvOperatorPlanEntry,
  treePath: string,
): SpawnedOperator | null {
  try {
    const child = spawn('npx', ['tsx', 'bin/hono-host.ts'], {
      cwd: join(treePath, 'apps', 'operator'),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PAPERCUSP_HONO_PORT: String(entry.port),
        // ── EI-126 single-writer safety — the extra envs are request-only siblings ──
        PAPERCUSP_BACKGROUND_WORKERS: '0',
        PAPERCUSP_DBOS_ENABLE: '0',
        // The provisioning launcher must not re-run for the children (no recursion).
        PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
        // Each child reached by top-level navigation, not the primary's IPC fast path;
        // disabling IPC avoids clobbering the last-writer-wins endpoint-ipc.json discovery.
        PAPERCUSP_IPC_ENABLE: '0',
        // A stable DBOS VMID per env (matches the dev script's desktop-dev-<port> convention).
        DBOS__VMID: `desktop-env-${entry.port}`,
      },
    });
    child.unref();
    return { id: entry.id, port: entry.port, pid: child.pid };
  } catch {
    return null;
  }
}

const sleepReal = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    // Don't let a pending stagger timer hold the boot turn / process open.
    (t as { unref?: () => void }).unref?.();
  });

/**
 * Bring up the enabled, not-yet-running env operators from the cloned source.
 * Idempotent (skips ports already served + this operator's own port), graceful
 * (missing tree/toolchain ⇒ that env is skipped, never an error), staggered (avoids
 * cold-boot migration contention), and fully defensive (a per-env prepare/spawn failure
 * is recorded as a skip and never aborts the rest). The caller (host-bootstrap.ts) runs
 * this fire-and-forget + non-fatal behind the default-off env gate.
 */
export async function launchEnvOperators(
  deps: LaunchEnvOperatorsDeps = {},
): Promise<LaunchEnvOperatorsResult> {
  const specs = deps.specs ?? PROVISIONABLE_ENV_OPERATORS;
  const host = deps.host ?? '127.0.0.1';
  const readPrefs = deps.readPrefs ?? (() => readEnvSwitcherPrefs());
  const probe = deps.probe ?? ((origin: string) => defaultProbe(origin));
  const detectSourceRoot = deps.detectSourceRoot ?? detectPapercupRoot;
  const selfPort = deps.selfPort !== undefined ? deps.selfPort : defaultSelfPort();
  const spawnOperator = deps.spawnOperator ?? defaultSpawnOperator;
  const staggerMs = deps.staggerMs ?? 4000;
  const sleep = deps.sleep ?? sleepReal;
  const log = deps.log ?? ((m: string) => console.log(m));

  const sourceRoot = detectSourceRoot();
  const hasSourceTree = !!sourceRoot;
  const hasToolchain = deps.hasToolchain
    ? await deps.hasToolchain()
    : await defaultHasToolchain(sourceRoot);

  // Probe every candidate port in parallel for an already-live operator (idempotent skip).
  const reachableEntries = await Promise.all(
    specs.map(async (s) => ({ port: s.port, up: await probe(`http://${host}:${s.port}`) })),
  );
  const reachablePorts = reachableEntries.filter((e) => e.up).map((e) => e.port);

  const disabledIds = readPrefs().disabled;
  const planned = planEnvOperatorLaunch({
    specs,
    disabledIds,
    reachablePorts,
    selfPort,
    hasSourceTree,
    hasToolchain,
    host,
  });

  const spawned: SpawnedOperator[] = [];
  const skipped: { id: string; reason: string }[] = [];

  // Default: the real branch-differentiating worktree prepare (D-006) — dev runs the
  // working tree in place; prod/staging get their own git worktree on main/staging under
  // ~/.papercusp/env-trees/. It degrades to null→skip on any git failure, so a shallow/
  // offline clone simply doesn't get that env (the switcher self-hides it). Lazy-imported
  // so the type-only back-reference in env-tree-prepare stays a pure type edge.
  const prepareTree =
    deps.prepareTree ??
    (async (entry: EnvOperatorPlanEntry, root: string) => {
      const { prepareEnvWorktree } = await import('./env-tree-prepare');
      return prepareEnvWorktree(entry, root);
    });

  for (const entry of planned) {
    if (entry.action === 'skip') {
      skipped.push({ id: entry.id, reason: entry.skipReason ?? 'skip' });
      continue;
    }
    // Stagger between *actual operator boots* only: no wait before the first real spawn,
    // and a skip / prepare-fail / spawn-fail never consumes a stagger slot (it boots
    // nothing, so there's no migration contention to space out). Keyed on spawned.length
    // rather than loop position so the gap always sits between two live boots.
    if (spawned.length > 0 && staggerMs > 0) await sleep(staggerMs);

    let treePath: string | null = null;
    try {
      treePath = await prepareTree(entry, sourceRoot as string);
    } catch {
      treePath = null;
    }
    if (!treePath) {
      skipped.push({ id: entry.id, reason: 'tree-prepare-failed' });
      continue;
    }
    const handle = spawnOperator(entry, treePath);
    if (handle) {
      spawned.push(handle);
      log(`[env-operators] spawned ${entry.id} on :${entry.port} (request-only, pid=${handle.pid ?? '?'})`);
    } else {
      skipped.push({ id: entry.id, reason: 'spawn-failed' });
      log(`[env-operators] spawn FAILED for ${entry.id} on :${entry.port} (non-fatal)`);
    }
  }

  log(
    `[env-operators] provisioning done — spawned=${spawned.length} skipped=${skipped.length}` +
      (skipped.length ? ` (${skipped.map((s) => `${s.id}:${s.reason}`).join(', ')})` : ''),
  );
  return { planned, spawned, skipped };
}
