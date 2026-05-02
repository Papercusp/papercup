/**
 * Filesystem-backed TokenStorage for the operator runtime.
 *
 * Reads/writes `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json`,
 * which is the same authoritative location the rest of the substrate
 * uses. After every mutation the PG mirror is refreshed.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { mirrorPluginConfig } from '@/lib/plugin-configs-pg';
import type { TokenStorage } from './token';

function HARNESSES_DIR() { return papercuspPath('harnesses'); }

function configPath(plugin: string, harness: string): string {
  return join(HARNESSES_DIR(), harness, 'plugin-configs', `${plugin}.json`);
}

export const fsTokenStorage: TokenStorage = {
  async read(plugin, harness) {
    try {
      const raw = await fs.readFile(configPath(plugin, harness), 'utf8');
      const j = JSON.parse(raw);
      return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  },
  async update(plugin, harness, patch) {
    const path = configPath(plugin, harness);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(path, 'utf8')) ?? {};
    } catch {
      // file might not exist yet
    }
    const next = { ...existing, ...patch };
    await fs.mkdir(join(HARNESSES_DIR(), harness, 'plugin-configs'), { recursive: true });
    await fs.writeFile(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    try {
      await mirrorPluginConfig(harness, plugin, next);
    } catch {
      // PG mirror is best-effort here; the file is authoritative
    }
  },
};
