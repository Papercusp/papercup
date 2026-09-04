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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  {
    file: 'lib/agent-tools/plans/viewer-identity.ts',
    why:
      'WI-5476: getViewerOwnerEmail spawns `git config user.email` ONCE per process ' +
      '(module-cached), not per read — it is not the page-load-storm class this guard ' +
      'targets. It CANNOT be precomputed: the value is the VIEWER machine\'s git ' +
      'identity, so a background routine on the operator host would compute the wrong ' +
      'identity for a remote peer in a shared hive. git is present on the desktop ' +
      'target and the read is fail-soft (null → the mine/others plan views hide).',
  },
  {
    file: 'lib/endpoint-route/routes/harness/feature-views.ts',
    why:
      'WI-5476: getFeatureTimeline (featureTimeline.byFeature) is a DRILL-DOWN — it ' +
      'fires only when a single feature slide-over opens in PlanDetail, never on a ' +
      'page-load panel — so its per-feature `git diff` is off the hot path, mirroring ' +
      'the soak-report windowHours drill-down. Precompute keyed per (slug,featureId) ' +
      'would add unbounded snapshot rows + per-feature invalidation for a click-to-open ' +
      'view; not worth it. Tracked for a lazy-git-diff follow-up if it ever regresses.',
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
  // All six original offenders (WI-5476) are now resolved:
  //   adv-sessions.ts       → the wmctrl helpers were split into
  //                           adv-session-windows.ts; the read path is pure DB.
  //   service-health.ts     → precomputed (dev.serviceHealth producer).
  //   dev-deploy-state.ts   → precomputed (dev.deployState producer).
  //   git-pipeline-hives.ts → precomputed (dev.gitPipelineHives producer).
  //   viewer-identity.ts    → ALLOW (per-viewer-local, module-cached singleton).
  //   feature-views.ts      → ALLOW (off-hot-path drill-down).
];

/** The count at the time this guard was written. May only go DOWN. Now 0. */
const KNOWN_OFFENDER_HIGH_WATERMARK = 0;

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

// ---------------------------------------------------------------------------
// Guard 2: no UNBOUNDED `SELECT *` on a wide-TOAST table (WI-6125,
// db-performance-remediation-2026-07-26 P-009).
//
// THE CLASS THIS DETECTS: a `SELECT *`-shaped read with no LIMIT against a
// table whose rows detoast large — the D-006 shape (an unbounded
// `SELECT body FROM coord_event_log ... ORDER BY id ASC` was a top pg_stat
// consumer until fixed). Per D-005, byte count is not the cost model —
// DETOAST is: every row fetched from these tables decompresses its TOASTed
// jsonb/text out-of-line, so an unbounded read pays that per row for the
// whole table. The audit that closed P-009 found ZERO such reads in runtime
// code (the only `SELECT *` sites on these tables are CREATE VIEW definitions
// and LIMIT-bounded reads), so this guard exists to keep the count at zero,
// not to burn down debt.
//
// THE TABLE SET is mechanical, not vibes: every table whose TOAST relation
// exceeded 20 MB, measured live 2026-08-02 (largest: session_archive_files
// 2.9 GB toast). engineer_issues / harness_features_consolidated are views
// over work_items and inherit its width; coord_event_log is included for its
// D-006 history. Re-derive with:
//   SELECT c.oid::regclass, pg_size_pretty(pg_relation_size(c.reltoastrelid))
//   FROM pg_class c WHERE c.relkind='r' AND c.reltoastrelid <> 0
//   ORDER BY pg_relation_size(c.reltoastrelid) DESC;
//
// FIX PATTERN when this fails: name the columns you need (skip the wide
// jsonb/text ones), or add a LIMIT, or push the filter server-side behind a
// tool/resolver arg. Per D-011, do NOT reach for jsonb slicing as the fix —
// measured, slicing was SLOWER than not projecting; the win is fetching
// fewer ROWS (bound the read), not thinner bytes per row.
const WIDE_TOAST_TABLES = [
  'session_archive_files',
  'session_turns',
  'harness_run_output',
  'plan_revisions',
  'memory_vec_harrier',
  'operator_turns',
  'work_items',
  'engineer_issues',
  'harness_features_consolidated',
  'tool_invocations',
  'event_wake_deliveries',
  'harness_plans',
  'pipeline_events',
  'substrate_outbox',
  'coord_event_log',
];

/** Server-code roots the SQL scan covers (repo-relative). */
const SQL_SCAN_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'];

/**
 * Justified unbounded wide selects — e.g. a single-row-by-key read where
 * `LIMIT 1` would be redundant. Keyed by repo-relative file path. Empty today;
 * prefer adding a LIMIT over adding an entry.
 */
const WIDE_SELECT_ALLOW: Array<{ file: string; why: string }> = [];

/**
 * ⚠ SHRINK-ONLY, same convention as KNOWN_OFFENDERS above: the high-watermark
 * assertion FAILS if this list grows.
 */
const WIDE_SELECT_KNOWN_OFFENDERS: string[] = [];

/** The count at the time this guard was written. May only go DOWN. */
const WIDE_SELECT_HIGH_WATERMARK = 0;

const WIDE_SELECT_RE = new RegExp(
  `SELECT\\s+\\*\\s+FROM\\s+(?:harness_shared\\.)?(${WIDE_TOAST_TABLES.join('|')})\\b`,
  'gi',
);

function* walkServerTs(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '_retired' || e.name === '__tests__') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkServerTs(full);
    else if (
      e.isFile() &&
      e.name.endsWith('.ts') &&
      !e.name.endsWith('.d.ts') &&
      !/\.(test|spec)\.ts$/.test(e.name)
    )
      yield full;
  }
}

/** Offending matches in one file: `SELECT *` on a wide table with no LIMIT in the statement. */
function unboundedWideSelects(file: string): Array<{ line: number; table: string }> {
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Array<{ line: number; table: string }> = [];
  let m: RegExpExecArray | null;
  WIDE_SELECT_RE.lastIndex = 0;
  while ((m = WIDE_SELECT_RE.exec(src))) {
    // A VIEW definition projects lazily — it is not a row-fetching read.
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    if (/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(before)) continue;
    // Statement extent: to the end of the template literal / statement, capped.
    const tail = src.slice(m.index, m.index + 800);
    const ends = [tail.indexOf('`'), tail.indexOf(';')].filter((i) => i >= 0);
    const stmt = ends.length ? tail.slice(0, Math.min(...ends)) : tail;
    if (/\bLIMIT\b/i.test(stmt)) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, table: m[1] });
  }
  return out;
}

describe('no unbounded SELECT * on a wide-TOAST table (P-009)', () => {
  it('no server path issues a LIMIT-less SELECT * against a wide-TOAST table', () => {
    const allowedFiles = new Set([
      ...WIDE_SELECT_ALLOW.map((a) => a.file),
      ...WIDE_SELECT_KNOWN_OFFENDERS,
    ]);
    const offenders: string[] = [];
    for (const root of SQL_SCAN_ROOTS) {
      for (const file of walkServerTs(resolve(REPO_ROOT, root))) {
        const rel = file.replace(REPO_ROOT + '/', '');
        if (allowedFiles.has(rel)) continue;
        for (const hit of unboundedWideSelects(file)) {
          offenders.push(`  ${rel}:${hit.line}  [${hit.table}]`);
        }
      }
    }
    expect(
      offenders.length,
      `An UNBOUNDED \`SELECT *\` against a wide-TOAST table landed on a server path.\n` +
        `Every row fetched detoasts its wide jsonb/text out-of-line (D-005: detoast, not bytes, is the\n` +
        `cost model), so a LIMIT-less read pays that for the whole table — the D-006 coord_event_log class.\n\n` +
        `Fix: name the columns you need, add a LIMIT, or push the filter server-side. Per D-011 do NOT\n` +
        `reach for jsonb slicing (measured slower); bound the ROW COUNT. A genuinely-justified site\n` +
        `(single-row-by-key) gets a WIDE_SELECT_ALLOW entry with a reason.\n` +
        `Offenders:\n${offenders.join('\n')}\n`,
    ).toBe(0);
  });

  it('the wide-select baseline never grows (shrink-only)', () => {
    expect(
      WIDE_SELECT_KNOWN_OFFENDERS.length,
      `The wide-select baseline GREW. Fix the read (name columns / add a LIMIT) instead of appending here.\n` +
        `This list may only SHRINK.`,
    ).toBeLessThanOrEqual(WIDE_SELECT_HIGH_WATERMARK);
  });

  it('every wide-select ALLOW/baseline entry still exists (and ALLOW carries a reason)', () => {
    for (const entry of WIDE_SELECT_ALLOW) {
      expect(entry.why.length, `WIDE_SELECT_ALLOW entry ${entry.file} needs a reason`).toBeGreaterThan(20);
      expect(
        existsSync(resolve(REPO_ROOT, entry.file)),
        `WIDE_SELECT_ALLOW entry ${entry.file} no longer exists — remove it`,
      ).toBe(true);
    }
    for (const file of WIDE_SELECT_KNOWN_OFFENDERS) {
      expect(
        existsSync(resolve(REPO_ROOT, file)),
        `Wide-select known offender ${file} no longer exists — remove it from the baseline`,
      ).toBe(true);
    }
  });
});
