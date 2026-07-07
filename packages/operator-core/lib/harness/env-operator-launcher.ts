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
 * ── DEFAULT-ON under the desktop (WI-3285) ──────────────────────────────────────────
 * The boot integration (host-bootstrap.ts) runs this on every `PAPERCUSP_DESKTOP=1` boot
 * unless explicitly opted out (`PAPERCUSP_PROVISION_ENV_OPERATORS=0`). It originally
 * shipped dark behind an opt-IN env, which meant every packaged install rendered the env
 * switcher with all-dead buttons (owner-reported on the Windows build, WI-3285:
 * "The buttons should all be operational"). Never on a non-desktop host — the dev box's
 * dev/prod/staging operators are managed by their own launchers and must not be hijacked.
 * The PLANNER below (planEnvOperatorLaunch) is a PURE function and is fully unit-tested;
 * the effectful spawn/probe/tree/toolchain seams are injected.
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
 * ── BUNDLED-FIRST on a packaged install (owner directive 2026-07-06, WI-3285) ────────
 * "All installs are dogfood installs" and env provisioning on user builds means
 * PER-BRANCH BUNDLED SIDECARS — never npm-install-from-source on a user machine.
 * Verified on the real packaged Linux deb (WI-3287): the bundle ships a BARE node (no
 * npm/npx/tsx) and the clone dir is an empty stub, so any from-source path ENOENTs.
 * So the launcher spawns each env from a bundled per-branch `serve.mjs` when the package
 * ships one (see resolveBundledSidecar for the discovery contract:
 * `<env-sidecars-dir>/<branch>/serve.mjs`, dir from PAPERCUSP_ENV_SIDECARS_DIR or
 * `env-sidecars/` next to the running serve.mjs), running it with the SAME node binary
 * that runs this primary (process.execPath — always present, PATH-independent).
 * From-source (node + the tree's own tsx CLI against bin/hono-host.ts, mirroring
 * bin/dev-operator-ifneeded.sh) remains for machines where the cloned source + installed
 * deps actually exist (the dev box). When neither a bundle nor a runnable tree exists,
 * the env is reported unavailable (skipReason 'no-source-tree' / 'no-toolchain') and not
 * spawned — the switcher keeps self-hiding for it. The bundled `release` env always works
 * with no toolchain and is never spawned here (it IS the running package).
 */

import { spawn } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { detectPapercupRoot, hasPapercupMarkers } from './register-papercusp';
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
  /** How the env is served: a source operator host (node+tsx bin/hono-host.ts — the
   *  default) or the Vite SPA dev server (`local` :3055, whose /api proxies to the
   *  primary operator via PAPERCUSP_API_TARGET). */
  run?: 'operator' | 'vite';
}

/**
 * The env operators install-time provisioning brings up (D-006's port/multi-operator
 * model). Includes `local` (:3055) — the Vite SPA dev server run from the working tree,
 * its /api proxied to THIS primary operator (WI-3285: the owner mandated every switcher
 * button be operational on a packaged install; D-006's original "maps to prod or is
 * omitted" left it permanently dead). Deliberately EXCLUDES one DEV_OPERATORS entry:
 *  - `release` — the immutable bundled sidecar (already running as the primary, or at
 *    PAPERCUSP_RELEASE_ORIGIN); it is never spawned from source (it IS the package).
 * Overlaps with whatever the primary/release already serves are handled by the
 * idempotent `already-reachable` / `is-self` skips in the planner — not by omission.
 */
export const PROVISIONABLE_ENV_OPERATORS: readonly EnvOperatorSpec[] = [
  { id: 'dev', port: 3270, branch: 'staging' }, // the user's working-tree checkout (the cloned source as-is)
  { id: 'prod', port: 3070, branch: 'main' }, // the green/release tree
  { id: 'staging', port: 3170, branch: 'staging' }, // the shared integration tree
  { id: 'local', port: 3055, branch: 'staging', run: 'vite' }, // the Vite SPA over the working tree
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
  /** Present iff action==='spawn': 'bundled' runs the package's per-branch serve.mjs
   *  (no toolchain needed); 'source' runs the cloned tree (dev box). */
  spawnMode?: 'bundled' | 'source';
  /** For spawnMode==='bundled': absolute path to that branch's bundled serve.mjs
   *  (stamped by launchEnvOperators after planning; the planner stays pure). */
  bundlePath?: string;
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
  /** Env ids with a bundled sidecar in the package (owner directive 2026-07-06 /
   *  WI-3285; contract: <sidecarDir>/env-sidecars/<envId>/serve.mjs): a bundled env
   *  spawns with NO source tree and NO toolchain. `run:'vite'` envs are source-only. */
  bundledEnvIds?: readonly string[];
  /** Bind host for the rendered origin (default 127.0.0.1). */
  host?: string;
}

/**
 * PURE planner: decide, per env, spawn-or-skip and (when skipped) WHY. No side effects.
 *
 * Skip precedence (deterministic, most-specific first):
 *   disabled → is-self → already-reachable → [bundled? spawn] → no-source-tree →
 *   no-toolchain → spawn (source).
 * `disabled` wins over everything (an off env is never started regardless of state);
 * `is-self` / `already-reachable` win over the env gates so an already-up operator is
 * never reported as "no toolchain". A bundled per-branch sidecar (owner directive
 * 2026-07-06) spawns REGARDLESS of source/toolchain — that's the packaged-install path;
 * the source/toolchain gates apply only to an env we'd otherwise run from the tree.
 * `run:'vite'` envs are source-only (the SPA dev server transforms the tree).
 */
export function planEnvOperatorLaunch(
  input: PlanEnvOperatorLaunchInput,
): EnvOperatorPlanEntry[] {
  const specs = input.specs ?? PROVISIONABLE_ENV_OPERATORS;
  const host = input.host ?? '127.0.0.1';
  const disabled = new Set(input.disabledIds ?? []);
  const reachable = new Set(input.reachablePorts ?? []);
  const bundled = new Set(input.bundledEnvIds ?? []);
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
    if (spec.run !== 'vite' && bundled.has(spec.id)) {
      return { ...base, action: 'spawn', spawnMode: 'bundled' };
    }
    if (!input.hasSourceTree) return skip('no-source-tree');
    if (!input.hasToolchain) return skip('no-toolchain');
    return { ...base, action: 'spawn', spawnMode: 'source' };
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
  /** Resolve the runnable source root (default defaultDetectSourceRoot:
   *  PAPERCUSP_DEV_SOURCE_ROOT exact-checked, else detectPapercupRoot). null ⇒ absent. */
  detectSourceRoot?: () => string | null;
  /** Whether a Node/npx+tsx run path exists (default: a `which`-style check). */
  hasToolchain?: () => Promise<boolean>;
  /** Resolve the bundled per-branch sidecar for a branch (owner directive 2026-07-06 /
   *  WI-3285): absolute path to that branch's serve.mjs, or null when the package
   *  doesn't ship one. DEFAULT: resolveBundledSidecar — `<dir>/<branch>/serve.mjs`
   *  under PAPERCUSP_ENV_SIDECARS_DIR, else `env-sidecars/` next to the RUNNING
   *  serve.mjs (process.argv[1]). */
  detectBundledSidecar?: (branch: string) => string | null;
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

/**
 * Default source-root resolution (WI-3306/WI-3308 extraction↔launcher contract, msg
 * mrano4w7): prefer `PAPERCUSP_DEV_SOURCE_ROOT` — the tree the serve-side first-boot
 * extracted from the packaged `source.tar.zst` — then fall back to the dev-box walk
 * (detectPapercupRoot). The env var is EXACT-checked (marker files, no walk-up) so a
 * half-extracted / missing tree degrades to the fallback instead of matching a parent.
 * Deliberately NOT the primary's PAPERCUSP_INTEGRATION_ROOT: that var re-points
 * prompt-assembly / capability base-dirs / git-pipeline on the PRIMARY, and on a
 * packaged install the primary is the release — only the dev/local CHILDREN may see
 * the extracted tree.
 */
export function defaultDetectSourceRoot(): string | null {
  const extracted = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
  if (extracted && extracted.trim() !== '') {
    const root = resolve(extracted);
    if (hasPapercupMarkers(root)) return root;
  }
  return detectPapercupRoot();
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

/**
 * Bundled env-sidecar discovery — THE PINNED PACKAGING CONTRACT (owner directive
 * 2026-07-06; contract pinned on plan env-switcher-packaged-all-platforms-2026-07-06,
 * msg mra0qw49):
 *
 *   <sidecarDir>/env-sidecars/<envId>/serve.mjs
 *
 * where <sidecarDir> = dirname(PAPERCUSP_SIDECAR_BIN) — main.rs already sets it on
 * every platform and WSLENV-forwards it, so discovery needs zero Rust changes.
 * PAPERCUSP_ENV_SIDECARS_DIR overrides explicitly (tests / future packaging); the
 * running serve.mjs's own dir (process.argv[1]) is the last-resort fallback. Each env
 * dir is a SIDECAR-SHAPED bundle (serve.mjs + spa/ + db-sql/ …) so the env operator
 * serves its own UI; there is NO per-env node — the launcher reuses the primary's
 * runtime (process.execPath; npm/npx/tsx are verifiably absent on real installs,
 * WI-3287). V1 packaging ships exactly one extra bundle: env-sidecars/staging/.
 *
 * PROD SPECIAL CASE: when env-sidecars/prod/ is absent (the V1 default), prod resolves
 * to the PRIMARY's own <sidecarDir>/serve.mjs — the installed release IS green `main`,
 * so the prod button serves the same code on its fixed :3070 port.
 */
export function resolveBundledSidecar(envId: string): string | null {
  try {
    const explicit = process.env.PAPERCUSP_ENV_SIDECARS_DIR;
    const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
    const sidecarDir = sidecarBin
      ? dirname(sidecarBin)
      : process.argv[1]
        ? dirname(process.argv[1])
        : null;
    const baseDir =
      explicit && explicit.trim() !== ''
        ? explicit
        : sidecarDir
          ? join(sidecarDir, 'env-sidecars')
          : null;
    if (!baseDir) return null;
    const bundle = join(baseDir, envId, 'serve.mjs');
    if (existsSync(bundle)) return bundle;
    if (envId === 'prod' && sidecarDir) {
      const primary = join(sidecarDir, 'serve.mjs');
      if (existsSync(primary)) return primary;
    }
    return null;
  } catch {
    return null;
  }
}

/** The tsx CLI installed by the tree's own npm install — spawning it via
 *  process.execPath works on a packaged install where `npx` is not on PATH. */
function resolveTsxCli(treePath: string): string | null {
  const cli = join(treePath, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return existsSync(cli) ? cli : null;
}

/** The vite CLI for the `local` env — hoisting may place it under the app or the root. */
function resolveViteCli(treePath: string): string | null {
  for (const cli of [
    join(treePath, 'apps', 'operator-vite', 'node_modules', 'vite', 'bin', 'vite.js'),
    join(treePath, 'node_modules', 'vite', 'bin', 'vite.js'),
  ]) {
    if (existsSync(cli)) return cli;
  }
  return null;
}

/** Env additions every SOURCE-spawned child gets (extraction↔launcher contract, msg
 *  mrano4w7 / WI-3306): the child's OWN tree as its PAPERCUSP_INTEGRATION_ROOT — its
 *  prompt/capability/git internals must resolve to the tree it serves, never inherit
 *  the primary's — and the bundled-sidecar dir(s) prepended to PATH so tree-spawned
 *  subprocesses find the packaged node on installs where nothing useful is on PATH
 *  (the runtime lives at <sidecarDir>/bin/node; both dirs are added, existence-gated). */
export function sourceChildEnv(treePath: string): Record<string, string> {
  const env: Record<string, string> = { PAPERCUSP_INTEGRATION_ROOT: treePath };
  const sidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
  if (sidecarBin) {
    const sidecarDir = dirname(sidecarBin);
    const dirs = [sidecarDir, join(sidecarDir, 'bin')].filter((d) => existsSync(d));
    if (dirs.length > 0) env.PATH = [...dirs, process.env.PATH ?? ''].join(delimiter);
  }
  return env;
}

/** Default spawn — mirror bin/dev-operator-ifneeded.sh's invocation, REQUEST-ONLY.
 *  Detached + unref'd + stdio:ignore so the spawned operator outlives this boot turn
 *  and never blocks it. The EI-126 single-writer knobs are the load-bearing safety here.
 *  Prefers `process.execPath` + the tree's own tsx/vite CLI over `npx` from PATH — a
 *  GUI-launched packaged app has no shell PATH to speak of (WI-3285). */
function defaultSpawnOperator(
  entry: EnvOperatorPlanEntry,
  treePath: string,
): SpawnedOperator | null {
  try {
    if (entry.spawnMode === 'bundled' && entry.bundlePath) {
      // Packaged install: run the bundled env sidecar with the same node that runs
      // this primary. Self-contained — no source tree, no toolchain. The env dir is
      // sidecar-shaped (serve.mjs + spa/ + db-sql/ …): point the asset roots INTO it
      // when present so the env operator serves ITS OWN UI/build, not the primary's
      // (a prod-fallback bundle IS the primary's dir, so these resolve to the same
      // paths there — harmless).
      const envDir = dirname(entry.bundlePath);
      const spaDir = join(envDir, 'spa');
      const docsDir = join(envDir, 'internal-docs');
      const child = spawn(process.execPath, [entry.bundlePath], {
        cwd: envDir,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          PAPERCUSP_HONO_PORT: String(entry.port),
          ...(existsSync(spaDir) ? { PAPERCUSP_SPA_DIST: spaDir } : {}),
          ...(existsSync(docsDir) ? { PAPERCUSP_DOCS_ROOT: docsDir } : {}),
          // ── EI-126 single-writer safety — the extra envs are request-only siblings ──
          // (shared embedded PG; ONLY the primary runs the background machinery)
          PAPERCUSP_BACKGROUND_WORKERS: '0',
          PAPERCUSP_DBOS_ENABLE: '0',
          PAPERCUSP_DBOS_ROUTINES: '0',
          PAPERCUSP_DBOS_ORCHESTRATOR: '0',
          // The provisioning launcher must not re-run for the children (no recursion).
          PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
          // Each child reached by top-level navigation, not the primary's IPC fast path.
          PAPERCUSP_IPC_ENABLE: '0',
          DBOS__VMID: `desktop-env-${entry.port}`,
          // WI-3287 (found live on the first real packaged-Linux verify,
          // 2026-07-07): this child re-execs the SAME serve.mjs as the primary
          // under the SAME $HOME. Two things in serve.ts are unconditional and
          // MUST be told this is a request-only sibling, not another primary:
          //  1. The cold-start singleton lock (`operator.lock`) is held by the
          //     primary for its ENTIRE lifetime (released only on shutdown) —
          //     without PAPERCUSP_ENV_OPERATOR_ID scoping its own lock file,
          //     this child's boot ALWAYS aborts with "another `serve` holds the
          //     cold-start lock" the moment the primary is up (which is always,
          //     by the time this launcher runs). It also keeps this child off
          //     the primary's operator.json / sticky-port-memory files (those
          //     must name the primary alone — a reconnecting client or the next
          //     restart must never be handed an env sidecar's port).
          //  2. PAPERCUSP_USE_EMBEDDED_PG='0' + the inherited
          //     HARNESS_ADMIN_DATABASE_URL/HARNESS_DATABASE_URL (already in
          //     process.env — the primary's own ensurePostgres() stamped them)
          //     route this child straight to serve.ts's "attach to external
          //     Postgres" branch, so it NEVER calls startEmbeddedPostgresServer
          //     (double-initdb against the SAME dataDir) or sweepOrphanPostgres
          //     — which, on the shared dataDir, would find the primary's own
          //     live postmaster and KILL it, mistaking it for an orphan. The
          //     "shared embedded PG, EI-126 request-only" contract only holds
          //     with this attach-not-manage path.
          PAPERCUSP_ENV_OPERATOR_ID: entry.id,
          PAPERCUSP_USE_EMBEDDED_PG: '0',
        },
      });
      child.unref();
      return { id: entry.id, port: entry.port, pid: child.pid };
    }
    if (entry.run === 'vite') {
      // The `local` env: the Vite SPA dev server over the working tree, its /api
      // proxied to THIS primary operator (the packaged install has no :3070 prod).
      const viteCli = resolveViteCli(treePath);
      if (!viteCli) return null;
      const selfPort = defaultSelfPort();
      const child = spawn(process.execPath, [viteCli], {
        cwd: join(treePath, 'apps', 'operator-vite'),
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ...sourceChildEnv(treePath),
          ...(selfPort != null
            ? { PAPERCUSP_API_TARGET: `http://127.0.0.1:${selfPort}` }
            : {}),
          // The provisioning launcher must not re-run for the children (no recursion).
          PAPERCUSP_PROVISION_ENV_OPERATORS: '0',
        },
      });
      child.unref();
      return { id: entry.id, port: entry.port, pid: child.pid };
    }
    const tsxCli = resolveTsxCli(treePath);
    const [cmd, args] = tsxCli
      ? [process.execPath, [tsxCli, 'bin/hono-host.ts']]
      : ['npx', ['tsx', 'bin/hono-host.ts']];
    const child = spawn(cmd as string, args as string[], {
      cwd: join(treePath, 'apps', 'operator'),
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...sourceChildEnv(treePath),
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
  const detectSourceRoot = deps.detectSourceRoot ?? defaultDetectSourceRoot;
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

  // Which envs ship a bundled sidecar in this package (owner directive 2026-07-06;
  // <sidecarDir>/env-sidecars/<envId>/serve.mjs, prod falling back to the primary's
  // own bundle) — the packaged-install spawn path that needs no source or toolchain.
  const detectBundledSidecar = deps.detectBundledSidecar ?? resolveBundledSidecar;
  const bundleByEnvId = new Map<string, string>();
  for (const s of specs) {
    if (s.run === 'vite') continue;
    const bundle = detectBundledSidecar(s.id);
    if (bundle) bundleByEnvId.set(s.id, bundle);
  }

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
    bundledEnvIds: [...bundleByEnvId.keys()],
    host,
  });
  // Stamp each bundled entry with its bundle path (the planner is pure and path-free).
  for (const entry of planned) {
    if (entry.action === 'spawn' && entry.spawnMode === 'bundled') {
      entry.bundlePath = bundleByEnvId.get(entry.id);
    }
  }

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

    // A bundled sidecar is self-contained — no source tree to prepare; it runs from
    // its own bundle dir. Only source spawns need the worktree/branch checkout.
    let treePath: string | null = null;
    if (entry.spawnMode === 'bundled' && entry.bundlePath) {
      treePath = dirname(entry.bundlePath);
    } else {
      try {
        treePath = await prepareTree(entry, sourceRoot as string);
      } catch {
        treePath = null;
      }
    }
    if (!treePath) {
      skipped.push({ id: entry.id, reason: 'tree-prepare-failed' });
      continue;
    }
    const handle = spawnOperator(entry, treePath);
    if (handle) {
      spawned.push(handle);
      log(
        `[env-operators] spawned ${entry.id} on :${entry.port} (${entry.spawnMode ?? 'source'}, request-only, pid=${handle.pid ?? '?'})`,
      );
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
