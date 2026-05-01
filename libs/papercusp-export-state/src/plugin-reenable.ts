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
import { join } from 'node:path';
import type { SnapshotPlugin } from './manifest';
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
}

const GLOBAL_PLUGINS_DIR = papercuspPath('global-plugins');

export async function readInstalledPluginCaps(
  pluginName: string,
): Promise<{ found: boolean; capabilities: string[]; version?: string }> {
  // Plugin can be installed as either a scoped name or a bare-dir name.
  // `apps/operator/app/api/plugins/enable/route.ts` does the same dance.
  const candidates = await resolveCandidateDirs(pluginName);
  for (const dir of candidates) {
    try {
      const m = JSON.parse(
        await fs.readFile(join(dir, 'papercusp.json'), 'utf8'),
      ) as { capabilities?: unknown; version?: string };
      const caps = Array.isArray(m.capabilities)
        ? m.capabilities.filter((c): c is string => typeof c === 'string')
        : [];
      return { found: true, capabilities: caps, version: m.version };
    } catch {
      continue;
    }
  }
  return { found: false, capabilities: [] };
}

async function resolveCandidateDirs(pluginName: string): Promise<string[]> {
  const direct = join(GLOBAL_PLUGINS_DIR, pluginName);
  const out: string[] = [direct];
  // Scoped name: try the basename suffix too.
  if (pluginName.startsWith('@')) {
    const slug = pluginName.split('/').pop();
    if (slug) out.push(join(GLOBAL_PLUGINS_DIR, slug));
  }
  // And the inverse: scan all installed plugins for one whose manifest.name matches.
  try {
    const entries = await fs.readdir(GLOBAL_PLUGINS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = join(GLOBAL_PLUGINS_DIR, e.name);
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
): Promise<ConsentSummary> {
  const summary: ConsentSummary = { plugins: [], missing: [], capDeltas: [] };
  for (const sp of snapshotPlugins) {
    const installed = await readInstalledPluginCaps(sp.name);
    if (!installed.found) {
      summary.missing.push({ name: sp.name, version: sp.version });
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
 */
export async function persistPluginConfigs(args: {
  newSlug: string;
  plugins: ConsentSummary['plugins'];
}): Promise<void> {
  const dir = papercuspPath('harnesses', args.newSlug, 'plugin-configs');
  await fs.mkdir(dir, { recursive: true });
  for (const p of args.plugins) {
    let json: unknown;
    try {
      json = JSON.parse(p.configJson);
    } catch {
      json = {};
    }
    const slug = p.name.startsWith('@') ? p.name.split('/').pop() ?? p.name : p.name;
    await fs.writeFile(
      join(dir, `${slug}.json`),
      JSON.stringify(json, null, 2) + '\n',
    );
  }
}
