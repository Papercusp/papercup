/**
 * dev-operators — the canonical multi-operator ENV targets for the cross-platform
 * env switcher (dogfood-silent-canonical-hive-join P-012..P-014 / P-017, D-006/D-008).
 *
 * The dev box runs several operator stacks on fixed local ports — prod :3070 (the
 * green/release tree), staging :3170 (the staging tree), dev :3270 (the working tree),
 * and local :3055 (the Vite HMR frontend, whose /api proxies to :3070). The native
 * Linux GTK dev-wrapper bar (papercusp-desktop/src-tauri/src/dev_wrapper.rs `TARGETS`)
 * switches the webview between them. This module is the DATA twin of that list so the
 * cross-platform in-webview switcher (EnvSwitcherBar) renders the same envs on
 * macOS/Windows/Linux. KEEP THE TWO LISTS IN SYNC.
 *
 * Plus a "release" env (D-008): the UNCHANGED code from the installed release PACKAGE —
 * the immutable bundled operator that ships in the installer and can't be broken by
 * local edits. It is the always-good escape hatch (it REPLACES the old remote-main
 * git-reset button). Its origin comes from PAPERCUSP_RELEASE_ORIGIN (set by the Tauri
 * host / provisioning for the bundled operator) and falls back to prod :3070 on the dev
 * box (where the green release IS :3070).
 *
 * WHY SERVER-SIDE reachability: a webview served from one origin (:3070) cannot
 * cross-origin `fetch` another operator's /api/desktop/version (CORS) — so the operator
 * itself probes the sibling ports (server→localhost, no CORS) and reports which envs are
 * live. NAVIGATION between operators is a top-level `window.location` change, which is
 * NOT CORS-bound, so the switch itself works purely client-side.
 *
 * On a packaged single-operator install only the running operator is reachable; the
 * switcher self-hides until install-time provisioning (P-017) brings the others up.
 */

import { defaultDetectSourceRoot } from './env-operator-launcher';

export interface DevOperatorDescriptor {
  /** Stable id (persisted/selected). */
  id: string;
  /** Short button label. */
  label: string;
  /** Fixed local port this env listens on. */
  port: number;
  /** Hover tooltip explaining what the env serves. */
  tooltip: string;
  /**
   * True for envs that can ONLY exist where a papercup source checkout is
   * present (`dev` = the working tree itself; `local` = the Vite HMR dev
   * frontend). On an install without a source tree these are OMITTED from the
   * resolved list entirely — a button for an env that cannot exist is not a
   * "disabled" state, it's noise (owner-reported greyed-button wall on the mac
   * build, WI-3284; plan env-switcher-packaged-all-platforms-2026-07-06).
   * `prod`/`staging` stay: packaged installs run them from the per-branch
   * BUNDLED sidecars (owner directive 2026-07-06), no source needed.
   */
  requiresSourceTree?: boolean;
}

/**
 * Canonical env targets. Mirrors dev_wrapper.rs `TARGETS` (order + ports + meaning).
 */
export const DEV_OPERATORS: readonly DevOperatorDescriptor[] = [
  {
    id: 'dev',
    label: 'dev',
    port: 3270,
    tooltip:
      'Dev operator (:3270) — this session’s own working-tree build. The default target.',
    requiresSourceTree: true,
  },
  {
    id: 'prod',
    label: 'prod',
    port: 3070,
    tooltip:
      'Production operator (:3070) — the deployed green-`main` release build.',
  },
  {
    id: 'staging',
    label: 'staging',
    port: 3170,
    tooltip:
      'Staging operator (:3170) — the shared integration-tree build (latest `staging`).',
  },
  {
    id: 'local',
    label: 'local',
    port: 3055,
    tooltip:
      'Local Vite SPA (:3055) — the hot-reloading dev frontend; its /api proxies to :3070.',
    requiresSourceTree: true,
  },
] as const;

export interface ResolvedDevOperator extends DevOperatorDescriptor {
  /** http origin to navigate to, e.g. `http://127.0.0.1:3170`. */
  origin: string;
  /** Whether the operator answered a /version probe (self is always true). */
  reachable: boolean;
  /** That operator's sidecar sha (8 hex), when reachable. */
  sha: string | null;
  /** True for the operator serving THIS request (highlighted as active). */
  isSelf: boolean;
  /** 'env' = a switchable branch operator; 'release' = the immutable bundled package code (D-008). */
  kind: 'env' | 'release';
  /** Whether the user wants this env (D-007). Disabled envs are not provisioned/started; 'release' is always enabled. */
  enabled: boolean;
}

export interface ResolveDevOperatorsResult {
  operators: ResolvedDevOperator[];
  /** The port this operator listens on (null if undeterminable). */
  selfPort: number | null;
}

export interface ResolveDevOperatorsDeps {
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Override the detected self port (tests). `null` = none. */
  selfPort?: number | null;
  /** Bind host to probe/navigate (default 127.0.0.1). */
  bindHost?: string;
  /** Per-probe timeout in ms (default 700). */
  timeoutMs?: number;
  /** Candidate env operators (default DEV_OPERATORS). */
  candidates?: readonly DevOperatorDescriptor[];
  /** Env ids the user has disabled (D-007) — reflected as `enabled:false`. 'release' is never disabled. */
  disabledIds?: readonly string[];
  /**
   * Whether a papercup source checkout exists on this machine (tests). Default:
   * `defaultDetectSourceRoot() != null` — the SAME detection launchEnvOperators
   * uses, so it also counts a packaged install's first-boot extracted tree
   * (PAPERCUSP_DEV_SOURCE_ROOT). When false, `requiresSourceTree` envs
   * (dev/local) are omitted from the result entirely — see the descriptor doc.
   */
  hasSourceTree?: boolean;
}

/** This operator's listen port, from the same env the host reads (PAPERCUSP_HONO_PORT / PORT). */
function detectSelfPort(): number | null {
  const raw = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The "release" env origin (D-008): the UNCHANGED code from the installed release
 * PACKAGE. The Tauri host / provisioning sets PAPERCUSP_RELEASE_ORIGIN to the bundled
 * operator's origin; on the dev box (no bundled binary) it falls back to prod :3070.
 */
export function resolveReleaseOrigin(deps: { host?: string } = {}): string {
  const host = deps.host ?? '127.0.0.1';
  const env = process.env.PAPERCUSP_RELEASE_ORIGIN;
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, '');
  // Packaged desktop (PAPERCUSP_DESKTOP=1) with no explicit origin: the bundled
  // primary operator IS the release code, and its port is DYNAMIC — the old
  // unconditional `:3070` fallback pointed at a port that doesn't exist on a
  // user install, so the release escape-hatch button rendered permanently dead
  // (owner-reported on the mac build 2026-07-06, WI-3284). Resolve to SELF: the
  // bar then marks release as the active env (honest — you're ON the release
  // code) instead of an unreachable ghost. The dev box keeps the `:3070`
  // fallback (its operators run without PAPERCUSP_DESKTOP; the green release
  // really is :3070 there).
  if (process.env.PAPERCUSP_DESKTOP === '1') {
    const selfPort = detectSelfPort();
    if (selfPort != null) return `http://${host}:${selfPort}`;
  }
  return `http://${host}:3070`;
}

/** Probe one operator's /api/desktop/version (server-side; no CORS). Never throws. */
async function probeVersion(
  origin: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ reachable: boolean; sha: string | null }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${origin}/api/desktop/version`, { signal: ctrl.signal });
      if (!res.ok) return { reachable: false, sha: null };
      let sha: string | null = null;
      try {
        const j = (await res.json()) as { sidecarSha?: unknown };
        sha = typeof j?.sidecarSha === 'string' ? j.sidecarSha : null;
      } catch {
        /* non-JSON body — still reachable */
      }
      return { reachable: true, sha };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { reachable: false, sha: null };
  }
}

function portOfOrigin(origin: string): number {
  try {
    const u = new URL(origin);
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return NaN;
  }
}

/**
 * Resolve the env targets with live reachability. Probes every non-self candidate's
 * /api/desktop/version in parallel (bounded by timeoutMs); failures are reported as
 * `reachable:false`, never thrown. Appends the "release" env (D-008) as the last entry.
 */
export async function resolveDevOperators(
  deps: ResolveDevOperatorsDeps = {},
): Promise<ResolveDevOperatorsResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const host = deps.bindHost ?? '127.0.0.1';
  const timeoutMs = deps.timeoutMs ?? 700;
  const selfPort = deps.selfPort !== undefined ? deps.selfPort : detectSelfPort();
  const disabled = new Set(deps.disabledIds ?? []);
  // Omit source-tree-only envs (dev/local) where no runnable source tree exists —
  // without one they CANNOT run, and rendering them as permanently grey buttons
  // is the WI-3284 owner-reported wall. prod/staging remain (the per-branch
  // bundled sidecars serve them; owner directive 2026-07-06). Uses the launcher's
  // own detection so a packaged install's first-boot extracted tree
  // (PAPERCUSP_DEV_SOURCE_ROOT, WI-3308) counts — a raw detectPapercupRoot()
  // here omitted dev/local from the list while local was literally running
  // (WI-3307 mac verify, 2026-07-07).
  const hasSourceTree = deps.hasSourceTree ?? defaultDetectSourceRoot() != null;
  const candidates = (deps.candidates ?? DEV_OPERATORS).filter(
    (d) => hasSourceTree || !d.requiresSourceTree,
  );

  const envOps = await Promise.all(
    candidates.map(async (d): Promise<ResolvedDevOperator> => {
      const origin = `http://${host}:${d.port}`;
      const isSelf = selfPort != null && selfPort === d.port;
      // self is reachable by definition — skip its probe.
      const { reachable, sha } = isSelf
        ? { reachable: true, sha: null }
        : await probeVersion(origin, doFetch, timeoutMs);
      return { ...d, origin, reachable, sha, isSelf, kind: 'env', enabled: !disabled.has(d.id) };
    }),
  );

  // The "release" escape env (D-008) — the immutable bundled package code.
  const releaseOrigin = resolveReleaseOrigin({ host });
  const releasePort = portOfOrigin(releaseOrigin);
  const releaseIsSelf = selfPort != null && releasePort === selfPort;
  const releaseProbe = releaseIsSelf
    ? { reachable: true, sha: null }
    : await probeVersion(releaseOrigin, doFetch, timeoutMs);
  const releaseOp: ResolvedDevOperator = {
    id: 'release',
    label: 'release',
    port: releasePort,
    tooltip:
      'Release — the unchanged code from the installed release package (immutable; the safe, always-good env).',
    origin: releaseOrigin,
    kind: 'release',
    isSelf: releaseIsSelf,
    enabled: true,
    ...releaseProbe,
  };

  return { operators: [...envOps, releaseOp], selfPort };
}
