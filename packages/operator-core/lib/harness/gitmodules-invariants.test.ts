import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Recurrence guard for the 2026-06-25 "Setting up Papercusp workspace failed"
 * incident: the papercup→papercusp identity rename overreached into `.gitmodules`
 * and rewrote two submodule URLs to repos that were never actually renamed on
 * GitHub (`Papercusp/papercusp-db.git`, `Papercusp/papercusp-shared.git` → 404).
 * Every FRESH dogfood clone then failed submodule init with a bare "setup failed",
 * while the dev box was unaffected (its `.git/config` kept the correct URLs).
 *
 * These are load-bearing source submodules (34+ active imports of
 * `@papercusp/db-org` and `@papercusp/papercusp-shared`), so a stale URL is a
 * hard release blocker, not a cosmetic nit. This test parses the committed
 * `.gitmodules` and fails the build the instant a submodule URL points at a
 * known-dead name — catching the regression in CI instead of on a user's Mac.
 *
 * See agent-insights/macos-packaged-app-path-and-git +
 * setup-wizard-github-network-timeout.
 */

function findRepoRoot(start: string): string {
  let dir = start;
  // Walk up until we find the superproject `.gitmodules` (it lists ~30 entries).
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, '.gitmodules');
    if (existsSync(candidate)) {
      const body = readFileSync(candidate, 'utf8');
      if (body.includes('libs/papercusp-db') && body.includes('papercusp-desktop')) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate superproject .gitmodules from ' + start);
}

interface SubmoduleEntry {
  name: string;
  path: string;
  url: string;
}

function parseGitmodules(body: string): SubmoduleEntry[] {
  const entries: SubmoduleEntry[] = [];
  let cur: Partial<SubmoduleEntry> | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[submodule "(.+)"\]$/.exec(line);
    if (header) {
      if (cur?.path && cur?.url) entries.push(cur as SubmoduleEntry);
      cur = { name: header[1] };
      continue;
    }
    if (!cur) continue;
    const kv = /^(path|url)\s*=\s*(.+)$/.exec(line);
    if (kv) (cur as Record<string, string>)[kv[1]] = kv[2].trim();
  }
  if (cur?.path && cur?.url) entries.push(cur as SubmoduleEntry);
  return entries;
}

describe('.gitmodules submodule URL invariants (release blocker)', () => {
  const root = findRepoRoot(process.cwd());
  const entries = parseGitmodules(readFileSync(join(root, '.gitmodules'), 'utf8'));

  it('parses the expected superproject submodule set', () => {
    // Sanity: we actually parsed the big superproject file, not a stray fixture.
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((e) => e.path)).toContain('libs/papercusp-db');
    expect(entries.map((e) => e.path)).toContain('libs/papercusp-shared');
  });

  it('references NONE of the known-dead papercusp-* rename URLs (the 2026-06-25 incident)', () => {
    // These repos do NOT exist on GitHub — the rename overreached. The real
    // repos kept their original `papercup-*` names.
    const DEAD = [/Papercusp\/papercusp-db(\.git)?$/i, /Papercusp\/papercusp-shared(\.git)?$/i];
    const offenders = entries.filter((e) => DEAD.some((re) => re.test(e.url)));
    expect(
      offenders,
      `stale submodule URL(s) point at a non-existent renamed repo → fresh clones fail setup: ` +
        offenders.map((o) => `${o.path} → ${o.url}`).join(', '),
    ).toEqual([]);
  });

  it('the load-bearing source submodules point at the real (papercup-named) repos', () => {
    const byPath = new Map(entries.map((e) => [e.path, e.url]));
    expect(byPath.get('libs/papercusp-db')).toBe('https://github.com/Papercusp/papercup-db.git');
    expect(byPath.get('libs/papercusp-shared')).toBe(
      'https://github.com/Papercusp/papercup-shared.git',
    );
  });

  it('every submodule URL is an https GitHub URL under the Papercusp org', () => {
    const bad = entries.filter((e) => !/^https:\/\/github\.com\/Papercusp\/[\w.-]+\.git$/i.test(e.url));
    expect(
      bad,
      `non-conforming submodule URL(s): ${bad.map((b) => `${b.path} → ${b.url}`).join(', ')}`,
    ).toEqual([]);
  });
});
