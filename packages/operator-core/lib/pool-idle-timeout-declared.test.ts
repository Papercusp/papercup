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
 *
 * ── application_name (WI-6062, 2026-07-26) ──────────────────────────────────
 * A SEPARATE class of the same "silent omission" bug: a hand-rolled `postgres(...)`
 * MODULE-LEVEL SINGLETON pool (`let pool: ...|null = null; ... pool = postgres(...)`)
 * that skips `longLivedPoolConnectionOptions()`/`suPoolConnectionOptions()` entirely
 * ALSO inherits postgres-js's other silent default: `application_name: 'postgres.js'`
 * (its own literal fallback string, not blank — see `node_modules/postgres/src/index.js`).
 * Found live: 10 `llm-testing/*` singleton pools (ledger/telemetry/storage/promotion/
 * replay + 4 admin routes) all built their own bare `postgres(getHarnessAdminUrl(), {
 * max, prepare: false })` — no helper, no tag — so any connection they opened was
 * PERMANENTLY UNATTRIBUTABLE in `pg_stat_activity` (indistinguishable from any other
 * untagged pool) AND missed the helper's WI-3816 dead-client zombie-detection GUCs,
 * which is exactly why 2 of them sat open, idle, unexplained, for 6.65 days (WI-6062).
 * The second describe block below extends the SAME guard shape to this class: find
 * every module-level singleton pg-client declaration, then require its `postgres(...)`
 * assignment to declare an application_name (via one of the two shared helpers, or an
 * inline `application_name:` for a bespoke case like the watchdog tick-lock). Scoped to
 * the SINGLETON shape deliberately — a function-scoped, always-`.end()`-ed client (a
 * script, a gym cycle, a test fixture) isn't the "opened once, held forever" leak shape
 * this guards against, so those are correctly out of scope here.
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
    // Tests are excluded deliberately: they contain fixture pool literals (including
    // this file's own deliberately-omitted one, which the guard correctly flagged when
    // they were in scope) that are not real connection pools.
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.integration.test.ts')
    )
      out.push(full);
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

/**
 * WI-6062: find MODULE-LEVEL singleton pg-client declarations — the
 * `let name: <type> | null = null;` (or `undefined`) shape at column 0 — then the
 * `name = postgres(...)` assignment that later fills them in, anywhere in the same
 * file. This is deliberately narrower than "every `postgres(...)` call": a
 * function-scoped client that is always `.end()`-ed on every path (a script, a gym
 * cycle, a test fixture) is a different, lower-risk shape — it gets reaped every time
 * it's used, so it can't accumulate into the "opened once, held forever" leak this
 * guards against. Only a column-0 `let ... = null` singleton, reassigned once and then
 * reused indefinitely, has that shape.
 */
function findSingletonPoolSites(source: string): { line: number; name: string }[] {
  const lines = source.split('\n');
  const declRe = /^let\s+(\w+)\s*:[^=]*=\s*(?:null|undefined);/;
  const names = new Set<string>();
  for (const line of lines) {
    const m = declRe.exec(line);
    if (m) names.add(m[1]);
  }
  if (names.size === 0) return [];
  const sites: { line: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    for (const name of names) {
      if (new RegExp(`\\b${name}\\s*=\\s*postgres\\(`).test(lines[i])) sites.push({ line: i, name });
    }
  }
  return sites;
}

/**
 * Does the `postgres(...)` call starting at this line declare an application_name —
 * either directly (a bespoke inline tag, e.g. the watchdog tick-lock) or via one of
 * the shared `longLivedPoolConnectionOptions()` / `suPoolConnectionOptions()` helpers
 * (which always set it — see connection.ts's `pgAppName`)? Same forward-scan-to-
 * closing-brace shape as {@link declaresIdleTimeout}.
 */
function declaresApplicationName(source: string, startLine: number): boolean {
  const lines = source.split('\n');
  for (let i = startLine; i < Math.min(lines.length, startLine + 25); i++) {
    const trimmed = lines[i].trim();
    if (i > startLine && (trimmed.startsWith('})') || trimmed.startsWith('});'))) return false;
    if (/\bapplication_name\s*:/.test(lines[i])) return true;
    if (HELPERS.some((h) => lines[i].includes(`...${h}(`))) return true;
  }
  return false;
}

describe('the guard itself detects an undeclared idle policy (non-vacuity)', () => {
  // Proven against fixtures rather than by temporarily breaking a real pool: this tree
  // is shared and auto-committed every few minutes, so a deliberately-wrong file
  // becomes a real commit other agents pull.
  const OMITTED = `
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-new-pool'),
      max: 4,
      prepare: false,
    });`;
  const TRANSACTIONAL = `
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-new-pool'),
      max: 4,
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });`;
  const LISTENER = `
    listenerSql = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions("some-bus"),
      max: 1,
      idle_timeout: 0,
    });`;
  const DOC_COMMENT_ONLY = `
     * Usage: \`postgres(url, { ...longLivedPoolConnectionOptions('x'), max: 1 })\`
     * — spread FIRST so a call site's own overrides still win.`;
  // The bug's real shape: a NEXT pool declared after one that did it right. A naive
  // forward scan would run past the first pool's closing brace and find its
  // idle_timeout, exonerating the offender.
  const OMITTED_AFTER_A_GOOD_ONE = `${TRANSACTIONAL}\n${OMITTED}`;

  it('flags a pool that omits idle_timeout', () => {
    const sites = findPoolSites(OMITTED);
    expect(sites).toHaveLength(1);
    expect(declaresIdleTimeout(OMITTED, sites[0].line)).toBe(false);
  });

  it('accepts both legitimate declarations', () => {
    for (const src of [TRANSACTIONAL, LISTENER]) {
      const sites = findPoolSites(src);
      expect(sites).toHaveLength(1);
      expect(declaresIdleTimeout(src, sites[0].line)).toBe(true);
    }
  });

  it('does not scan past the enclosing object into a neighbouring pool', () => {
    const sites = findPoolSites(OMITTED_AFTER_A_GOOD_ONE);
    expect(sites).toHaveLength(2);
    expect(declaresIdleTimeout(OMITTED_AFTER_A_GOOD_ONE, sites[0].line)).toBe(true);
    expect(declaresIdleTimeout(OMITTED_AFTER_A_GOOD_ONE, sites[1].line)).toBe(false);
  });

  it('ignores the usage example in a doc comment', () => {
    expect(findPoolSites(DOC_COMMENT_ONLY)).toEqual([]);
  });
});

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

describe('the singleton-pool guard itself detects an undeclared application_name (non-vacuity)', () => {
  const UNTAGGED = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 2, prepare: false });
  return pool;
}`;
  const TAGGED_VIA_HELPER = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) {
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-pool'),
      max: 2,
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });
  }
  return pool;
}`;
  const TAGGED_INLINE = `
let _tickLockSql: Sql | null = null;
function tickLockSql(): Sql {
  if (!_tickLockSql) {
    _tickLockSql = postgres(watchdogTickLockUrl(), {
      max: 1,
      idle_timeout: 0,
      connection: { application_name: \`pcusp:watchdog-ticklock:p\${process.pid}\` },
    });
  }
  return _tickLockSql;
}`;
  // The bug's real shape: a function-scoped client (always .end()-ed) must NOT be
  // flagged — only the module-level singleton is the "held forever" leak shape.
  const FUNCTION_SCOPED_NOT_A_SINGLETON = `
async function run() {
  let gymSql: postgres.Sql | undefined;
  try {
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });
  } finally {
    if (gymSql) await gymSql.end({ timeout: 5 });
  }
}`;

  it('flags a singleton pool that omits application_name', () => {
    const sites = findSingletonPoolSites(UNTAGGED);
    expect(sites).toHaveLength(1);
    expect(declaresApplicationName(UNTAGGED, sites[0].line)).toBe(false);
  });

  it('accepts both legitimate declarations (shared helper, or inline tag)', () => {
    for (const src of [TAGGED_VIA_HELPER, TAGGED_INLINE]) {
      const sites = findSingletonPoolSites(src);
      expect(sites).toHaveLength(1);
      expect(declaresApplicationName(src, sites[0].line)).toBe(true);
    }
  });

  it('ignores a function-scoped (always-.end()-ed) client — not the singleton shape', () => {
    expect(findSingletonPoolSites(FUNCTION_SCOPED_NOT_A_SINGLETON)).toEqual([]);
  });
});

describe('singleton pg-client pools always declare an application_name (WI-6062)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('finds the singleton sites it is meant to guard (test is not vacuously green)', () => {
    const total = files.reduce((n, f) => n + findSingletonPoolSites(readFileSync(f, 'utf8')).length, 0);
    // Guards against the scan silently matching nothing (bad root, renamed pattern).
    // Measured live 2026-07-26: ~14 module-level singleton pg-client pools.
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('every module-level singleton pg-client pool declares an application_name', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const site of findSingletonPoolSites(source)) {
        if (!declaresApplicationName(source, site.line)) {
          offenders.push(`${relative(REPO_ROOT, file)}:${site.line + 1} (${site.name})`);
        }
      }
    }
    expect(
      offenders,
      `These singleton pools leave application_name undeclared, so postgres-js's own ` +
        `'postgres.js' default applies and any connection they open is PERMANENTLY ` +
        `UNATTRIBUTABLE in pg_stat_activity (WI-6062: this is exactly how 2 llm-testing ` +
        `pools sat idle, unexplained, for 6.65 days). Route the pool through the shared ` +
        `helper (spread FIRST so a call site's own overrides still win):\n` +
        `  ...longLivedPoolConnectionOptions('<label>')  // also declare idle_timeout\n` +
        `or, for a bespoke case, tag it inline: connection: { application_name: '<label>' }\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });
});
