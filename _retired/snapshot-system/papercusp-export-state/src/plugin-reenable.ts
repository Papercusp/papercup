/**
 * §15.6 step 10 — plugin re-enable + capability-spoofing-safe consent.
 *
 * The capture pass records `manifest.plugins[]` with each plugin's
 * declared capabilities AT capture time. The restore pass cannot blindly
 * trust those — a malicious manifest could under-declare to slip past
 * the consent screen. Instead we read the *installed* plugin's actual
 * `papercusp.json`, take the union of its capabilities, and re-prompt.
 *
 * v1.0 of the substrate hands us the user's consent decision (`grant-all`
 * or `reject`) as a single up-front choice; v1.1 will support per-cap.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SnapshotPlugin, SnapshotPluginRuntime } from './manifest';
import { papercuspPath } from './paths';

export interface ConsentSummary {
  /** Plugins enumerated by name with their union-of-caps. */
  plugins: { name: string; version: string; caps: string[]; configJson: string; shapeJson?: string; pluginVersionPinned?: boolean }[];
  /** Plugins the manifest claimed but that aren't installed locally. */
  missing: { name: string; version: string }[];
  /**
   * Plugins where the installed manifest's caps differ from the snapshot
   * manifest's claim. Caller surfaces these so the user notices.
   */
  capDeltas: { name: string; declaredInSnapshot: string[]; installed: string[] }[];
  /**
   * Plugins whose required runtime isn't available on this host.
   *
   * Per rev3 plan A9 fix: the runtime requirement is derived from the
   * INSTALLED plugin's manifest at consent time (NOT from the snapshot's
   * advisory `runtime` field), so a plugin re-published with a different
   * runtime is always evaluated against current reality. The snapshot's
   * own `runtime` field is informational only — it records what the
   * source environment used.
   *
   * Caller surfaces these alongside `missing` so the user sees "5
   * plugins skipped: 3 not installed, 2 require WASM runtime which
   * isn't available in this build."
   */
  skipped: {
    name: string;
    version: string;
    requiredRuntime: SnapshotPluginRuntime;
    reason: 'runtime-not-available';
  }[];
}

/**
 * Which plugin runtimes this host can satisfy. Caller passes this from
 * the operator's environment introspection (e.g. JS is always true; WASM
 * depends on jco availability; daemon depends on bwrap on Linux).
 */
export interface RuntimeAvailability {
  js: boolean;
  wasm: boolean;
  daemon: boolean;
}

export const ALL_RUNTIMES_AVAILABLE: RuntimeAvailability = {
  js: true,
  wasm: true,
  daemon: true,
};

/**
 * Resolved per-call so PAPERCUSP_HOME changes mid-process (e.g. in
 * tests) take effect. Cost is negligible — it's an env-var read +
 * a path join.
 */
function globalPluginsDir(): string {
  return papercuspPath('global-plugins');
}

export async function readInstalledPluginCaps(
  pluginName: string,
): Promise<{
  found: boolean;
  capabilities: string[];
  version?: string;
  /**
   * Runtime declared in the installed plugin's manifest. Used by
   * `buildConsentSummary` to derive whether the host can satisfy
   * the snapshot's plugin set. Defaults to 'js' when absent — that
   * was the only runtime before Phase G of the rev3 plan.
   */
  runtime?: SnapshotPluginRuntime;
}> {
  // Plugin can be installed as either a scoped name or a bare-dir name.
  // `apps/operator/app/api/plugins/enable/route.ts` does the same dance.
  const candidates = await resolveCandidateDirs(pluginName);
  for (const dir of candidates) {
    try {
      const m = JSON.parse(
        await fs.readFile(join(dir, 'papercusp.json'), 'utf8'),
      ) as { capabilities?: unknown; version?: string; runtime?: unknown };
      const caps = Array.isArray(m.capabilities)
        ? m.capabilities.filter((c): c is string => typeof c === 'string')
        : [];
      const runtime: SnapshotPluginRuntime | undefined =
        m.runtime === 'js' || m.runtime === 'wasm' || m.runtime === 'daemon'
          ? m.runtime
          : undefined;
      return { found: true, capabilities: caps, version: m.version, runtime };
    } catch {
      continue;
    }
  }
  return { found: false, capabilities: [] };
}

async function resolveCandidateDirs(pluginName: string): Promise<string[]> {
  const direct = join(globalPluginsDir(), pluginName);
  const out: string[] = [direct];
  // Scoped name: try the basename suffix too.
  if (pluginName.startsWith('@')) {
    const slug = pluginName.split('/').pop();
    if (slug) out.push(join(globalPluginsDir(), slug));
  }
  // And the inverse: scan all installed plugins for one whose manifest.name matches.
  try {
    const entries = await fs.readdir(globalPluginsDir(), { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = join(globalPluginsDir(), e.name);
      if (out.includes(dir)) continue;
      try {
        const m = JSON.parse(
          await fs.readFile(join(dir, 'papercusp.json'), 'utf8'),
        ) as { name?: string };
        if (m.name === pluginName) out.push(dir);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir missing — empty install set */
  }
  return out;
}

export async function buildConsentSummary(
  snapshotPlugins: SnapshotPlugin[],
  /**
   * Optional. When provided, plugins whose installed-manifest runtime
   * isn't satisfied by this host go into `summary.skipped` instead of
   * `summary.plugins`. Defaults to all-runtimes-available so existing
   * callers (mostly tests + dev mode) are unaffected.
   */
  available: RuntimeAvailability = ALL_RUNTIMES_AVAILABLE,
): Promise<ConsentSummary> {
  const summary: ConsentSummary = {
    plugins: [],
    missing: [],
    capDeltas: [],
    skipped: [],
  };
  for (const sp of snapshotPlugins) {
    const installed = await readInstalledPluginCaps(sp.name);
    if (!installed.found) {
      summary.missing.push({ name: sp.name, version: sp.version });
      continue;
    }
    // Per rev3 plan A9: derive runtime requirement from INSTALLED
    // manifest, not snapshot. Default 'js' when installed manifest
    // doesn't declare (legacy plugins predating the runtime field).
    const requiredRuntime: SnapshotPluginRuntime = installed.runtime ?? 'js';
    if (!available[requiredRuntime]) {
      summary.skipped.push({
        name: sp.name,
        version: installed.version ?? sp.version,
        requiredRuntime,
        reason: 'runtime-not-available',
      });
      continue;
    }
    const declared = new Set(sp.capabilities);
    const have = new Set(installed.capabilities);
    const union = Array.from(new Set([...declared, ...have])).sort();
    if (
      [...declared].some((c) => !have.has(c)) ||
      [...have].some((c) => !declared.has(c))
    ) {
      summary.capDeltas.push({
        name: sp.name,
        declaredInSnapshot: [...declared].sort(),
        installed: [...have].sort(),
      });
    }
    summary.plugins.push({
      name: sp.name,
      version: installed.version ?? sp.version,
      caps: union,
      configJson: sp.configJson,
      ...(sp.shapeJson ? { shapeJson: sp.shapeJson } : {}),
      ...(sp.pluginVersionPinned !== undefined ? { pluginVersionPinned: sp.pluginVersionPinned } : {}),
    });
  }
  return summary;
}

/**
 * Persists the snapshot's per-plugin config into the new harness's
 * plugin-configs/<plugin>.json — the substrate enable flow normally writes
 * these via `papercusp plugin enable`. For restore we write directly so
 * we can re-enable in batch without prompting again.
 *
 * Also writes the `enabled-plugins.json` index file from the manifest's
 * plugin list — without this, the forked harness has plugin configs on
 * disk but nothing tells the operator they're enabled, so its
 * `pendingProvisioning` queue stays empty after fork.
 *
 * Scoped plugin names (`@papercupai/cloudflare-stack`) are preserved as
 * directory paths (`plugin-configs/@papercupai/cloudflare-stack.json`),
 * matching the convention the operator + `papercusp plugin enable` use.
 */
export async function persistPluginConfigs(args: {
  newSlug: string;
  plugins: ConsentSummary['plugins'];
}): Promise<void> {
  const baseDir = papercuspPath('harnesses', args.newSlug, 'plugin-configs');
  await fs.mkdir(baseDir, { recursive: true });

  const enabled: Record<string, { version: string; enabledAt: string; configHash: string }> = {};
  const enabledAt = new Date().toISOString();

  for (const p of args.plugins) {
    let json: unknown;
    try {
      json = JSON.parse(p.configJson);
    } catch {
      json = {};
    }
    // Use the full plugin name as the on-disk path. For scoped names
    // (`@scope/name`), the `/` splits into a sub-directory.
    const configPath = join(baseDir, `${p.name}.json`);
    await fs.mkdir(dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(json, null, 2) + '\n');

    enabled[p.name] = {
      version: p.version,
      enabledAt,
      configHash: '',
    };
  }

  // Write the enabled-plugins.json index — without this, the operator's
  // pendingProvisioning logic finds no enabled plugins after fork.
  const enabledPath = papercuspPath('harnesses', args.newSlug, 'enabled-plugins.json');
  await fs.writeFile(enabledPath, JSON.stringify({ enabled }, null, 2) + '\n');
}
