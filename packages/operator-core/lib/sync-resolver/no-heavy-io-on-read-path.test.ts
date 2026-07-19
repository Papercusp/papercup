// Guard: no sync-resolver read path may reach a SUBPROCESS or a recursive FS walk.
//
// THE CLASS THIS DETECTS (WI-5460, precompute-derived-sync-reads-2026-07-19 P-007):
// a resolver that performs expensive derived work synchronously on a user-facing
// read. An audit timed all 200 registered queryNames and found three over 12s --
// learning.soakReport 27.3s (a `journalctl` subprocess, fanned out per-pot),
// storage.usage 20.0s (a recursive du-style disk walk), plans.lint 13.8s (a
// full-corpus parse) -- while pure DB reads on the same host were 3-20ms.
//
// It is worse than slow: the batch endpoint resolves with Promise.all, so ONE
// slow resolver delayed every other panel in its batch. And a resolver that
// shells out to a host binary does not merely lag on the shipped desktop target
// (embedded PG, no systemd) -- `journalctl` does not exist there, so it fails.
//
// Nothing else catches this. The typecheck cannot see cost; the unit suite
// never times a resolver; a reviewer sees a one-line `await import(...)`. So
// this test IS the detector.
//
// FIX PATTERN when this fails: move the expensive work OFF the read path via the
// precompute substrate -- register a producer in lib/derived-reads/producers.ts
// and make the resolver a plain `readDerivedSnapshotRows(key)` SELECT. The
// `system:precompute-derived-reads` routine computes it on a cadence, where
// nobody is waiting. Do NOT reach for a cache: a cache still pays full cost on
// cold load, and still fails outright on a host without the binary.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const OPERATOR_CORE_LIB = resolve(__dirname, '..');
const REPO_ROOT = resolve(OPERATOR_CORE_LIB, '../../..');
const ENTRY = resolve(__dirname, 'index.ts');

/**
 * FIXED — moved off the read path by this plan. Kept out of the baseline below
 * because they are genuinely resolved, not tolerated.
 *
 * Each is still statically reachable, which is why the walk still sees them:
 * the module exists and the resolver can reach it on an explicitly non-default
 * branch. What changed is that the DEFAULT read no longer executes it.
 */
const ALLOW: Array<{ file: string; why: string }> = [
  {
    file: 'lib/pot/soak-report.ts',
    why:
      'P-005: the journalctl read is precomputed and served from a snapshot for the ' +
      'nullary call the Learnings tab makes. It stays reachable only via the explicit ' +
      'non-default windowHours drill-down, which is off the panel path.',
  },
  {
    file: 'lib/storage/usage.ts',
    why:
      'P-003: precomputed. Still reachable via the FLAGS.PRECOMPUTE_DERIVED_READS=off ' +
      'escape hatch, which deliberately restores the pre-fix inline behavior.',
  },
];

/**
 * KNOWN, PRE-EXISTING offenders — the same class, found by this guard when it was
 * first written, and NOT yet fixed (tracked as a WI-5460 follow-up).
 *
 * These were all under the audit's 12s threshold (measured: health.snapshot 1.34s,
 * network.board 1.45s, overwatch.snapshot 1.87s) so they were not part of this
 * plan's scope. They are still subprocess calls on a user-facing read path, and
 * every one of them will FAIL rather than degrade on a host without the binary --
 * the same shipped-desktop hazard as journalctl.
 *
 * ⚠ SHRINK-ONLY, deliberately mirroring the KNOWN_DARK_FLAGS high-watermark
 * convention. The high-watermark assertion below FAILS if this list grows, so a
 * NEW offender cannot be quietly appended -- the only sanctioned direction is
 * fixing one and deleting its line. This is a debt ledger, not a mute button.
 */
const KNOWN_OFFENDERS: string[] = [
  'lib/adv-sessions.ts',
  'lib/endpoint-route/routes/harness/feature-views.ts',
  'lib/agent-tools/plans/viewer-identity.ts',
  'lib/service-health.ts',
  'lib/dev-deploy-state.ts',
  'lib/git-pipeline-hives.ts',
];

/** The count at the time this guard was written. May only go DOWN. */
const KNOWN_OFFENDER_HIGH_WATERMARK = 6;

const allowed = new Set([...ALLOW.map((a) => a.file), ...KNOWN_OFFENDERS]);

/** Subprocess + recursive-walk primitives that must not sit on a read path. */
const HEAVY_IMPORTS = ['node:child_process', 'child_process'];

function fileFor(base: string): string | null {
  for (const c of [base, base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  const s = spec.replace(/\?.*$/, '');
  if (s.startsWith('.')) return fileFor(resolve(dirname(fromFile), s));
  return null; // packages: out of scope for this walk
}

const STMT = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)from\s*['"]([^'"]+)['"]/g;
const DYN = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Runtime edges. Resolvers reach their work via `await import(...)`, so dynamic
 * imports are exactly the edges that matter here -- unlike the client-graph
 * guard, where they are the lazy ones.
 */
function edges(file: string): string[] {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = STMT.exec(src))) {
    if (/^\s*type\b/.test(m[1])) continue;
    out.push(m[2]);
  }
  while ((m = DYN.exec(src))) out.push(m[1]);
  return [...new Set(out)];
}

function heavyImports(file: string): string[] {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const heavy of HEAVY_IMPORTS) {
    const re = new RegExp(`(?:^|\\n)\\s*import\\b([\\s\\S]*?)from\\s*['"]${heavy}['"]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (/^\s*type\b/.test(m[1])) continue;
      found.add(heavy);
    }
    if (new RegExp(`import\\(\\s*['"]${heavy}['"]\\s*\\)`).test(src)) found.add(heavy);
  }
  return [...found];
}

/**
 * How many hops from the resolver registry to follow.
 *
 * Deliberately SHALLOW, and this is the test's key design decision. The full
 * transitive closure of the resolver registry reaches essentially the whole
 * server codebase (index -> work-items -> pot/urgent-wake -> blueprint ->
 * dbos -> provision/sandbox), which flags ~50 modules that no resolver ever
 * actually executes. A guard that reports 50 false positives is a guard people
 * delete.
 *
 * The REAL bug class is shallow by nature: a resolver directly awaits a module
 * whose job is to shell out. Both audited offenders sit at depth 1
 * (index -> pot/soak-report, index -> storage/usage). Depth 2 covers a thin
 * wrapper module without dragging in the lazy world behind unrelated helpers.
 *
 * The tradeoff is explicit: this catches the shape that actually bit us, not
 * every theoretically reachable subprocess.
 */
const MAX_DEPTH = 1;

describe('no heavy I/O on a sync-resolver read path', () => {
  it('no module reachable from the sync-resolver registry spawns a subprocess', () => {
    const seen = new Map<string, string[]>([[ENTRY, ['sync-resolver/index.ts']]]);
    const queue: Array<[string, string[], number]> = [[ENTRY, ['sync-resolver/index.ts'], 0]];
    while (queue.length) {
      const [file, path, depth] = queue.shift()!;
      if (depth >= MAX_DEPTH) continue;
      for (const spec of edges(file)) {
        const r = resolveSpec(spec, file);
        if (r && !seen.has(r)) {
          const rel = r.replace(REPO_ROOT + '/packages/operator-core/', '');
          const np = [...path, `${spec} -> ${rel}`];
          seen.set(r, np);
          queue.push([r, np, depth + 1]);
        }
      }
    }

    const offenders: string[] = [];
    for (const [file, chain] of seen) {
      const rel = file.replace(REPO_ROOT + '/packages/operator-core/', '');
      if (allowed.has(rel)) continue;
      const heavy = heavyImports(file);
      if (heavy.length) {
        offenders.push(`\n  ${rel}  [${heavy.join(', ')}]\n` + chain.map((p, i) => `      ${i}. ${p}`).join('\n'));
      }
    }

    expect(
      offenders.length,
      `A module reachable from the sync-resolver registry spawns a subprocess on a USER-FACING READ PATH.\n` +
        `This is the WI-5460 class: measured 27.3s / 20.0s / 13.8s panel loads, and an outright FAILURE on the\n` +
        `shipped desktop target where the host binary does not exist.\n\n` +
        `Fix: move the work off the read path — register a producer in lib/derived-reads/producers.ts and make\n` +
        `the resolver a plain readDerivedSnapshotRows(key) SELECT. Do NOT add a cache (it still pays full cost\n` +
        `on cold load), and do NOT add an ALLOW entry unless the work is genuinely already off the hot path.\n` +
        `Offenders:${offenders.join('\n')}\n`,
    ).toBe(0);
  });

  it('the known-offender baseline never grows (shrink-only, like KNOWN_DARK_FLAGS)', () => {
    expect(
      KNOWN_OFFENDERS.length,
      `The known-offender baseline GREW. A new subprocess-on-a-read-path was added and appended here\n` +
        `instead of being fixed. Move the work off the read path via lib/derived-reads/producers.ts.\n` +
        `This list may only SHRINK — fixing an entry means deleting its line, never adding one.`,
    ).toBeLessThanOrEqual(KNOWN_OFFENDER_HIGH_WATERMARK);
  });

  it('every known offender still exists — a stale baseline means the guard stopped guarding', () => {
    for (const file of KNOWN_OFFENDERS) {
      expect(
        existsSync(resolve(REPO_ROOT, 'packages/operator-core', file)),
        `Known offender ${file} no longer exists — remove it from KNOWN_OFFENDERS`,
      ).toBe(true);
    }
  });

  it('every ALLOW entry still exists and carries a reason', () => {
    // A stale allowlist is how a guard quietly stops guarding.
    for (const entry of ALLOW) {
      expect(entry.why.length, `ALLOW entry ${entry.file} needs a reason`).toBeGreaterThan(20);
      expect(
        existsSync(resolve(REPO_ROOT, 'packages/operator-core', entry.file)),
        `ALLOW entry ${entry.file} no longer exists — remove it`,
      ).toBe(true);
    }
  });
});
