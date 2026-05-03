/**
 * Action manifest format + env resolution for per-branch actions.
 *
 * Sources of actions:
 *   1. Harness-shipped:  <staging>/.harness/actions/<branch>/<name>.sh
 *      Optional manifest at  <staging>/.harness/actions/<branch>/<name>.manifest.json
 *
 *   2. Plugin-contributed: each enabled plugin's papercusp.json may declare a
 *      `branchActions` object. Keys are action names; values are full
 *      manifests including `branches` (which branches to expose on) and
 *      `scriptPath` (relative to the plugin install dir).
 *
 * Env resolution strategies:
 *   - { from: 'plugin', plugin, field }   → plugin-configs/<plugin>.json[field]
 *   - { from: 'config', field }           → (plugin actions only) the contributing
 *                                            plugin's own plugin-configs[field]
 *   - { from: 'harness', field }          → .harness/env.json[field]
 *   - { from: 'literal', value }          → that string verbatim
 *
 * Resolution returns both the resolved env dict and a list of `missing`
 * required entries — the API layer uses these to colour the UI chip.
 *
 * The dependency tracking is intentionally one-way: actions never *write*
 * back into plugin-configs. If a value is missing, we surface a "configure"
 * link to the existing plugin-config editor.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type EnvSource =
  | { from: 'plugin'; plugin: string; field: string; required?: boolean; description?: string }
  | { from: 'config'; field: string; required?: boolean; description?: string }
  | { from: 'harness'; field: string; required?: boolean; description?: string }
  | { from: 'literal'; value: string };

export interface ActionManifest {
  /** Human-friendly name shown in the menu (defaults to `name`). */
  displayName?: string;
  description?: string;
  /** Map of env-var-name → resolution strategy. */
  env?: Record<string, EnvSource>;
  /** Default 1800 (30min). */
  timeoutSec?: number;
}

/**
 * Plugin-contributed action manifest (script-based). Same shape as
 * ActionManifest plus which branches it shows up on and where the
 * script lives. Used by `branchActions` field.
 */
export interface PluginActionManifest extends ActionManifest {
  /** Branches this action should appear on. Default = all three. */
  branches?: Array<'staging' | 'testing' | 'production'>;
  /** Script path relative to the plugin install dir. Required. */
  scriptPath: string;
}

/**
 * Plugin-contributed button (URL-based). Plugins declare:
 *
 *   "buttons": {
 *     "staging":    { "build": "/api/plugins/@scope/myplug/build-staging" },
 *     "production": { "build": "/api/plugins/@scope/myplug/build-prod" }
 *   }
 *
 * Or with extra metadata:
 *
 *   "buttons": {
 *     "staging": {
 *       "build": {
 *         "url": "/api/plugins/@scope/myplug/build-staging",
 *         "displayName": "Build & deploy (staging)",
 *         "method": "POST"
 *       }
 *     }
 *   }
 *
 * The substrate POSTs (default) to `url` with JSON body:
 *   { harness, branch, button }
 *
 * Plugin handler can:
 *   - return text/event-stream (SSE) → substrate forwards lines to the
 *     xterm runner modal verbatim;
 *   - return application/json → substrate shows it as a one-line summary;
 *   - return text/plain or anything else → substrate shows the body.
 *
 * URL is relative to the operator's origin. Plugin authors typically
 * point at their own apiRoutes (mounted under /api/plugins/<slug>/...).
 */
export type ButtonDecl =
  | string
  | {
      url: string;
      method?: 'POST' | 'GET';
      displayName?: string;
      description?: string;
    };

export type ButtonsManifest = Partial<
  Record<'staging' | 'testing' | 'production', Record<string, ButtonDecl>>
>;

export function normalizeButtonDecl(d: ButtonDecl): {
  url: string; method: 'POST' | 'GET'; displayName?: string; description?: string;
} {
  if (typeof d === 'string') return { url: d, method: 'POST' };
  return { url: d.url, method: d.method ?? 'POST', displayName: d.displayName, description: d.description };
}

export interface MissingEnvEntry {
  name: string;
  from: EnvSource['from'];
  plugin?: string;
  field?: string;
  description?: string;
}

export interface EnvResolution {
  /** Env vars whose source resolved cleanly. */
  env: Record<string, string>;
  /** Required vars whose source was empty/absent — UI surfaces these. */
  missing: MissingEnvEntry[];
}

function harnessConfigDir(harnessSlug: string): string {
  // Mirrors lib/papercusp-root resolution. Cheap path resolution here so
  // this module is dependency-light and unit-testable.
  const env = process.env.PAPERCUSP_HOME;
  if (env) return join(env, 'harnesses', harnessSlug);
  // Active workspace per registry.json
  try {
    const idx = join(homedir(), '.papercusp-workspaces', 'registry.json');
    if (existsSync(idx)) {
      // We don't parse registry.json here — keep dep-light. The caller
      // (route handler) already passes the harnesses dir down via the
      // env or by calling resolveEnv with explicit `harnessConfigsDir`.
    }
  } catch { /* ignore */ }
  return join(homedir(), '.papercusp-workspaces', 'default', '.papercusp', 'harnesses', harnessSlug);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch { return null; }
}

/**
 * Resolve a manifest's env requirements. Caller passes the harness's
 * config dir (where `plugin-configs/` and `env.json` live). For
 * plugin-contributed actions, pass `contributingPlugin` so `from: 'config'`
 * can resolve to that plugin's own config.
 */
export async function resolveEnv(
  manifest: ActionManifest | undefined,
  args: {
    harnessConfigsDir: string;
    contributingPlugin?: string;
  },
): Promise<EnvResolution> {
  const out: EnvResolution = { env: {}, missing: [] };
  if (!manifest?.env) return out;

  for (const [name, src] of Object.entries(manifest.env)) {
    if (src.from === 'literal') {
      out.env[name] = src.value;
      continue;
    }

    let value: string | undefined;

    if (src.from === 'plugin') {
      const cfg = await readJson<Record<string, unknown>>(
        join(args.harnessConfigsDir, 'plugin-configs', `${src.plugin}.json`),
      );
      const v = cfg?.[src.field];
      if (typeof v === 'string' && v.length > 0) value = v;
    } else if (src.from === 'config') {
      if (!args.contributingPlugin) {
        // 'config' only valid for plugin-contributed actions.
        if (src.required) out.missing.push({ name, from: src.from, field: src.field, description: src.description });
        continue;
      }
      const cfg = await readJson<Record<string, unknown>>(
        join(args.harnessConfigsDir, 'plugin-configs', `${args.contributingPlugin}.json`),
      );
      const v = cfg?.[src.field];
      if (typeof v === 'string' && v.length > 0) value = v;
    } else if (src.from === 'harness') {
      const env = await readJson<Record<string, unknown>>(
        join(args.harnessConfigsDir, 'env.json'),
      );
      const v = env?.[src.field];
      if (typeof v === 'string' && v.length > 0) value = v;
    }

    if (value !== undefined) {
      out.env[name] = value;
    } else if (src.required) {
      out.missing.push({
        name,
        from: src.from,
        plugin: src.from === 'plugin' ? src.plugin : (src.from === 'config' ? args.contributingPlugin : undefined),
        field: 'field' in src ? src.field : undefined,
        description: src.description,
      });
    }
  }
  return out;
}

/** Read an inline action manifest sibling to `<name>.sh`. */
export async function readInlineManifest(
  stagingPath: string, branch: string, name: string,
): Promise<ActionManifest | null> {
  return readJson<ActionManifest>(
    join(stagingPath, '.harness', 'actions', branch, `${name}.manifest.json`),
  );
}

// re-exported so the test file can stub.
export const __test = { harnessConfigDir };
