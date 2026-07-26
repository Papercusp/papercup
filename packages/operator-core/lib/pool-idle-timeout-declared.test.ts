/**
 * Guard: every hand-rolled `postgres(...)` pool must DECLARE its idle policy.
 *
 * Why this exists (2026-07-26, P-009 of shared-hive-cross-machine-scale-10k):
 * postgres-js defaults `idle_timeout` to **0 = never close**. `buildClient()` has
 * always set 30s, so pools built through it self-drain — but the ~13 pools that
 * bypass `buildClient` and only spread `longLivedPoolConnectionOptions()` /
 * `suPoolConnectionOptions()` silently inherited that 0 and held their backends open
 * FOREVER. Measured live: 294 idle vs 3 active connections, 343/512 `max_connections`,
 * with `su-lock-tx` alone parking 34 idle backends.
 *
 * The failure mode is a SILENT OMISSION — nobody wrote "never close", they just didn't
 * write anything — so the fix is to make the choice impossible to leave implicit.
 * Both answers are legitimate and the test accepts either:
 *   - transactional pool → `idle_timeout: poolIdleTimeoutSec()` (drain idle backends)
 *   - LISTEN pool        → `idle_timeout: 0` (idle BY DESIGN; reaping it would silently
 *                          drop the subscription and break notification delivery)
 *
 * That second case is why this is a "declare it" guard rather than a lint banning 0, and
 * why the shared helper deliberately does NOT supply a nonzero default: 5 LISTEN buses
 * spread the same helper, and a default would have broken every one of them.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOTS = ['packages', 'libs', 'apps'];
const SKIP_DIRS = new Set(['node_modules', '_retired', 'dist', 'build', '.git', '.next', 'target']);

/** The option-builder helpers whose call sites must declare an idle policy. */
const HELPERS = ['longLivedPoolConnectionOptions', 'suPoolConnectionOptions'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink / race with a concurrent agent's edit
    }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** A spread of a helper into an object literal, ignoring doc-comment examples. */
function findPoolSites(source: string): { line: number; helper: string }[] {
  const lines = source.split('\n');
  const sites: { line: number; helper: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Skip comments — connection.ts documents the exact spread in a usage example.
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const helper of HELPERS) {
      if (lines[i].includes(`...${helper}(`)) sites.push({ line: i, helper });
    }
  }
  return sites;
}

/**
 * Does the object literal containing this spread declare `idle_timeout`?
 * Scans forward to the end of the enclosing `postgres({...})` call — detected by the
 * first line whose trimmed form starts with `})`, which closes the options object.
 */
function declaresIdleTimeout(source: string, startLine: number): boolean {
  const lines = source.split('\n');
  for (let i = startLine; i < Math.min(lines.length, startLine + 25); i++) {
    const trimmed = lines[i].trim();
    if (i > startLine && (trimmed.startsWith('})') || trimmed.startsWith('});'))) return false;
    if (/\bidle_timeout\s*:/.test(lines[i])) return true;
  }
  return false;
}

describe('pool idle policy is always declared (P-009 connection saturation)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('finds the pool sites it is meant to guard (test is not vacuously green)', () => {
    const total = files.reduce((n, f) => n + findPoolSites(readFileSync(f, 'utf8')).length, 0);
    // Guards against the scan silently matching nothing (bad root, renamed helper).
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('every pool spreading a shared connection-options helper declares idle_timeout', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const site of findPoolSites(source)) {
        if (!declaresIdleTimeout(source, site.line)) {
          offenders.push(`${relative(REPO_ROOT, file)}:${site.line + 1} (${site.helper})`);
        }
      }
    }
    expect(
      offenders,
      `These pools leave idle_timeout implicit, so postgres-js's 0 default applies and ` +
        `their backends are held open FOREVER. Declare the intent explicitly:\n` +
        `  transactional → idle_timeout: poolIdleTimeoutSec()\n` +
        `  LISTEN        → idle_timeout: 0  // idle by design; reaping drops the subscription\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });
});
