/**
 * recovery-dependency-scan — the MECHANICAL seed for the P-004 audit.
 *
 * Walks the source tree and returns every `managedSetInterval` registration carrying
 * `category: 'watchdog'` — the timers whose own category is documented in
 * `@papercusp/scheduled-registry` as "out-of-band sentinel — bespoke, MUST SURVIVE WHAT
 * IT WATCHES". That population is what `recovery-dependency-audit.ts` must cover, and
 * this is what makes the coverage check mechanical rather than a list someone remembered
 * to update.
 *
 * Kept in its OWN module so `recovery-dependency-audit.ts` stays pure and importable from
 * anywhere (it is a table + arithmetic; this one touches `node:fs`).
 *
 * DETECTION IS TEXTUAL, not an AST parse — the same technique, and the same tradeoff, as
 * `scripts/check-timer-classification.mjs` and `scripts/check-no-raw-setinterval.mjs`:
 * find each `managedSetInterval(` call, take its balanced-paren argument text, and read
 * the name + category out of it. A textual scan cannot see a category threaded through a
 * variable; those surface as `category: null` and are reported rather than dropped, so
 * an unreadable site can never be mistaken for an absent one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Directories never worth walking — build output, deps, VCS. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'target', 'coverage', '.turbo']);

/** Roots that can contain host-side timers. */
export const SCAN_ROOTS = ['packages', 'libs', 'apps'] as const;

export interface ScannedTimer {
  /** The registered timer name, or null when it is not a literal (a template/variable). */
  name: string | null;
  /** The declared category, or null when it is not a string literal at the call site. */
  category: string | null;
  /** Repo-relative path, always with forward slashes. */
  file: string;
}

function* walkTs(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
    } else if (
      entry.isFile() &&
      full.endsWith('.ts') &&
      !full.endsWith('.test.ts') &&
      !full.endsWith('.integration.test.ts') &&
      !full.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

const CALL = 'managedSetInterval';

/**
 * PURE over a file's text: every `managedSetInterval(...)` call with its literal name and
 * category. Exported so a test can drive it on a fixture string without touching disk.
 */
export function extractManagedTimerCalls(src: string): { name: string | null; category: string | null }[] {
  const out: { name: string | null; category: string | null }[] = [];
  let i = 0;
  while ((i = src.indexOf(`${CALL}(`, i)) !== -1) {
    // Skip a call that is part of a longer identifier (e.g. `wrapManagedSetInterval(`).
    const prev = i > 0 ? src[i - 1] : '';
    if (/[A-Za-z0-9_$]/.test(prev)) {
      i += CALL.length;
      continue;
    }
    const open = i + CALL.length;
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const args = src.slice(open + 1, j);
    const name = /^\s*'([^']*)'/.exec(args)?.[1] ?? null;
    const category = /category:\s*'([^']*)'/.exec(args)?.[1] ?? null;
    out.push({ name, category });
    i = j > i ? j : i + CALL.length;
  }
  return out;
}

/**
 * Every `managedSetInterval` registration under `SCAN_ROOTS`, relative to `repoRoot`.
 * Callers filter by category; returning all of them keeps the "unreadable category"
 * case visible.
 */
export function scanManagedTimers(repoRoot: string): ScannedTimer[] {
  const found: ScannedTimer[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkTs(join(repoRoot, root))) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes(`${CALL}(`)) continue;
      const rel = relative(repoRoot, file).split(sep).join('/');
      for (const call of extractManagedTimerCalls(src)) {
        found.push({ name: call.name, category: call.category, file: rel });
      }
    }
  }
  return found;
}

/** The `category: 'watchdog'` subset — the population the P-004 audit must declare. */
export function scanWatchdogTimers(repoRoot: string): ScannedTimer[] {
  return scanManagedTimers(repoRoot).filter((t) => t.category === 'watchdog');
}
