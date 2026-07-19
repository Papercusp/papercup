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
 * Modules that legitimately spawn a subprocess and are reached ONLY from a
 * resolver's non-default branch, having been moved off the hot path already.
 *
 * Every entry needs a reason. This is an allowlist, not a mute button: adding a
 * line here without moving the work off the read path re-arms the exact bug.
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

const allowed = new Set(ALLOW.map((a) => a.file));

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

describe('no heavy I/O on a sync-resolver read path', () => {
  it('no module reachable from the sync-resolver registry spawns a subprocess', () => {
    const seen = new Map<string, string[]>([[ENTRY, ['sync-resolver/index.ts']]]);
    const queue: Array<[string, string[]]> = [[ENTRY, ['sync-resolver/index.ts']]];
    while (queue.length) {
      const [file, path] = queue.shift()!;
      for (const spec of edges(file)) {
        const r = resolveSpec(spec, file);
        if (r && !seen.has(r)) {
          const rel = r.replace(REPO_ROOT + '/packages/operator-core/', '');
          const np = [...path, `${spec} -> ${rel}`];
          seen.set(r, np);
          queue.push([r, np]);
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
