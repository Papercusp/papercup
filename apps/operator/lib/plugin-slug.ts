import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';
function GLOBAL_PLUGINS_DIR() { return papercuspPath('global-plugins'); }

/**
 * Translate whatever the UI/caller passes (manifest name, dir basename, or
 * `@scope/<name>` form) into the slug the CLI expects: a path under
 * `~/.papercusp/global-plugins/` that contains a `papercusp.json`.
 *
 * Looks in:
 *   1. the literal input as a top-level dir
 *   2. every top-level dir's manifest `name`
 *   3. every `@scope/<name>/` subdir's manifest `name` (so callers passing a
 *      bare basename for a scoped-only install still resolve correctly)
 */
export async function resolvePluginCliSlug(input: string): Promise<string> {
  if (!input) return input;
  if (existsSync(join(GLOBAL_PLUGINS_DIR(), input))) return input;
  if (!existsSync(GLOBAL_PLUGINS_DIR())) return input;
  const entries = await fs.readdir(GLOBAL_PLUGINS_DIR(), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = join(GLOBAL_PLUGINS_DIR(), e.name);
    try {
      const m = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8'));
      if (m?.name === input) return e.name;
    } catch { /* no manifest at this level */ }
    if (!e.name.startsWith('@')) continue;
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const sub of inner) {
      if (!sub.isDirectory() && !sub.isSymbolicLink()) continue;
      const subPath = `${e.name}/${sub.name}`;
      try {
        const m = JSON.parse(await fs.readFile(join(dir, sub.name, 'papercusp.json'), 'utf8'));
        if (m?.name === input) return subPath;
        if (input === subPath) return subPath;
        if (input === sub.name) return subPath;
      } catch { /* skip */ }
    }
  }
  return input;
}
