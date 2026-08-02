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

/**
 * ── URL tracking (EI-19306394439939264, 2026-08-02) ─────────────────────────
 * The THIRD member of the same "silent omission" family, on the same singleton shape.
 *
 * A pool must never outlive the URL that justified it. `connection.ts` learned this
 * (EI-19285027465993737) and fixed it for the MANAGED admin clients by remembering the URL
 * each pool was ACTUALLY BUILT WITH and rebinding through `endStalePool`. The decisive
 * insight: every earlier guard asked *"what SHOULD we connect to?"*, and none asked *"what
 * is the live pool actually bound to?"* — so URL resolution kept returning the right
 * address the whole time the pool served a dead one.
 *
 * A module-level singleton built directly from `postgres(getHarnessAdminUrl(), …)` caches
 * the pool but not the URL, so it can never notice the endpoint moved. That is a live
 * failure mode here: on 2026-08-01 a dead embedded-pg port produced 20,144 ×
 * `ECONNREFUSED 127.0.0.1:20216` over ~2h40m (WI-6739). ⚠ Those particular failures came
 * from the MANAGED `getOrgPg()` path, which is already fixed — the pools guarded here are
 * the half of the class still unguarded, not the proven cause of that outage.
 *
 * The fix for a transactional pool is `getLongLivedAdminPool(label, extra?)`, which
 * re-resolves and rebinds on every use. A compliant file therefore has NO site here at all.
 *
 * ALLOWLIST IS SHRINK-ONLY, and split by WHY — deliberately, so a permanent design
 * exemption is not rationed against a temporary one (the same reasoning as `DarkCase` for
 * dark flags). `listen` entries are permanent; `pending-migration` entries must go to zero.
 * A third test asserts every entry still matches a real site, so migrating a file FAILS
 * until its now-stale entry is deleted — the allowlist cannot quietly outlive its reason.
 */
const LISTEN_EXEMPT: Record<string, string> = {
  // A LISTEN connection carries subscription state a silent rebuild would drop: the caller
  // keeps a live handle that no longer receives notifications — a worse, SILENT failure
  // than the one being fixed. Rebinding these must also re-issue the LISTEN, which belongs
  // with the code owning the subscription.
  'packages/operator-core/lib/agent-activity-bus.ts': 'LISTEN — rebind must re-issue subscription',
  'packages/operator-core/lib/pg-listen-hub.ts': 'LISTEN — rebind must re-issue subscription',
  'packages/operator-core/lib/fleet-assignment-bus.ts': 'LISTEN — rebind must re-issue subscription',
  'packages/operator-core/lib/coord-inbox-bus.ts': 'LISTEN — rebind must re-issue subscription',
  // NOTE: pg-notify-bus.ts and sync-sse.ts also open LISTEN clients from
  // getHarnessAdminUrl(), but neither is in the module-level `let x: T | null = null`
  // singleton shape this guard scans, so neither is a site and neither may be listed here
  // (the shrink-only test rejects an entry matching nothing). If either is ever refactored
  // into that shape, the guard will flag it and it can be added then — which is the
  // self-correcting behaviour we want, not an omission.
};

/** Transactional pools not yet migrated. This map must only ever SHRINK. */
const PENDING_MIGRATION: Record<string, string> = {
  'packages/operator-core/lib/dock-layouts.ts': 'transactional — migrate to getLongLivedAdminPool',
  'packages/operator-core/lib/llm-testing/telemetry.ts': 'transactional — migrate',
  'packages/operator-core/lib/llm-testing/ledger.ts': 'transactional — migrate',
  'packages/operator-core/lib/llm-testing/replay.ts': 'transactional — migrate',
  'packages/operator-core/lib/llm-testing/storage.ts': 'transactional — migrate',
  'packages/operator-core/lib/llm-testing/promotion/promote.ts': 'transactional — migrate',
  'packages/operator-core/lib/llm-testing/promotion/candidates.ts': 'transactional — migrate',
  'packages/operator-core/lib/system-health/desktop-perf-runs.ts': 'transactional — migrate',
  'packages/operator-core/lib/sync/hyperbee/pg-merge-cursor-store.ts': 'transactional — migrate',
  'packages/operator-core/lib/endpoint-route/routes/admin/llm-tests-findings.ts': 'transactional — migrate',
  'packages/operator-core/lib/endpoint-route/routes/admin/llm-tests-runs.ts': 'transactional — migrate',
  'packages/operator-core/lib/endpoint-route/routes/admin/llm-tests-finding-by-id.ts': 'transactional — migrate',
  'packages/operator-core/lib/endpoint-route/routes/admin/llm-tests-run-by-id.ts': 'transactional — migrate',
};

const URL_TRACKING_ALLOWLIST = { ...LISTEN_EXEMPT, ...PENDING_MIGRATION };

/**
 * Module-level singleton pools built DIRECTLY from `getHarnessAdminUrl()` — the shape that
 * cannot notice the endpoint moved. Narrower than {@link findSingletonPoolSites} by the
 * URL source: a pool built from a bespoke URL (the watchdog tick-lock) is not admin-pool
 * discovery and is out of scope.
 */
function findUntrackedAdminPoolSites(source: string): { line: number; name: string }[] {
  const lines = source.split('\n');
  return findSingletonPoolSites(source).filter((site) => {
    for (let i = site.line; i < Math.min(lines.length, site.line + 3); i++) {
      if (lines[i].includes('getHarnessAdminUrl(')) return true;
    }
    return false;
  });
}

describe('the URL-tracking guard itself detects an untracked admin pool (non-vacuity)', () => {
  const UNTRACKED = `
let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) {
    pool = postgres(getHarnessAdminUrl(), {
      ...longLivedPoolConnectionOptions('some-pool'),
      max: 4,
      idle_timeout: poolIdleTimeoutSec(),
      prepare: false,
    });
  }
  return pool;
}`;
  // The migrated shape: no postgres(...) call survives, so there is no site to flag.
  const MIGRATED = `
const db = () => getLongLivedAdminPool('some-pool', { max: 4, prepare: false });`;
  // A singleton built from a BESPOKE url is out of scope — it is not admin discovery.
  const BESPOKE_URL = `
let _tickLockSql: Sql | null = null;
function tickLockSql(): Sql {
  if (!_tickLockSql) {
    _tickLockSql = postgres(watchdogTickLockUrl(), { max: 1, idle_timeout: 0 });
  }
  return _tickLockSql;
}`;

  it('flags a singleton admin pool that tracks no URL', () => {
    expect(findUntrackedAdminPoolSites(UNTRACKED)).toHaveLength(1);
  });

  it('finds nothing in a migrated file', () => {
    expect(findUntrackedAdminPoolSites(MIGRATED)).toEqual([]);
  });

  it('ignores a singleton built from a bespoke (non-discovery) URL', () => {
    expect(findUntrackedAdminPoolSites(BESPOKE_URL)).toEqual([]);
  });
});

describe('admin pools track the URL they were built with (EI-19306394439939264)', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('finds the admin-pool sites it is meant to guard (test is not vacuously green)', () => {
    const total = files.reduce((n, f) => n + findUntrackedAdminPoolSites(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it('no NEW singleton admin pool bypasses getLongLivedAdminPool', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (URL_TRACKING_ALLOWLIST[rel]) continue;
      const source = readFileSync(file, 'utf8');
      for (const site of findUntrackedAdminPoolSites(source)) {
        offenders.push(`${rel}:${site.line + 1} (${site.name})`);
      }
    }
    expect(
      offenders,
      `These singleton pools are built directly from getHarnessAdminUrl() and remember no ` +
        `URL, so they can never notice the endpoint moved and will serve a DEAD address ` +
        `until the process restarts (WI-6739: 20,144 ECONNREFUSED over ~2h40m).\n` +
        `  transactional → const db = () => getLongLivedAdminPool('<label>', { max, prepare })\n` +
        `  LISTEN        → add to LISTEN_EXEMPT; a silent rebuild would drop the subscription\n` +
        offenders.map((o) => `  - ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('every allowlist entry still matches a real site (allowlist is shrink-only)', () => {
    const stale: string[] = [];
    for (const rel of Object.keys(URL_TRACKING_ALLOWLIST)) {
      const full = join(REPO_ROOT, rel);
      let source: string;
      try {
        source = readFileSync(full, 'utf8');
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      if (findUntrackedAdminPoolSites(source).length === 0) stale.push(`${rel} (no untracked pool left)`);
    }
    expect(
      stale,
      `These allowlist entries no longer describe anything — the pool was migrated or the ` +
        `file moved. Delete them; an exemption that outlives its reason silently re-permits ` +
        `the bug it was granted for:\n` + stale.map((s) => `  - ${s}`).join('\n'),
    ).toEqual([]);
  });
});
