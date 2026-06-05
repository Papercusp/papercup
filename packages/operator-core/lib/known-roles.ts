import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { harnessPath } from './harness-paths';

let _cache: { value: string[]; expires: number } | null = null;
const TTL_MS = 30_000;

/**
 * The single source of truth for "what role names exist." Walks every
 * .md file under the global prompts directory (top-level + all subdirs:
 * org/, department/, staging/, testing/, production/, …). Names are
 * deduped — same role may appear in multiple subdirs as a phase variant.
 *
 * `_archived/`, files starting with `_`, and README.md are skipped.
 *
 * Cached for 30 seconds. The list re-reads on next call after the TTL,
 * so dropping a new prompt file is picked up without a server restart.
 */
export function getKnownRoles(): string[] {
  const now = Date.now();
  if (_cache && _cache.expires > now) return _cache.value;
  const found = new Set<string>();
  function walk(dir: string) {
    let entries: Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('_') || e.name === 'README.md') continue;
      if (e.isFile() && e.name.endsWith('.md')) {
        found.add(e.name.replace(/\.md$/, ''));
      } else if (e.isDirectory()) {
        walk(join(dir, e.name));
      }
    }
  }
  try {
    const dir = harnessPath('prompts');
    if (existsSync(dir)) walk(dir);
  } catch {}
  let roles = [...found].sort();
  if (roles.length === 0) roles = ['orchestrator'];
  _cache = { value: roles, expires: now + TTL_MS };
  return roles;
}
