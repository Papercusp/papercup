/**
 * Guard scripts must derive their own repo root, never hardcode it (WI-10811).
 *
 * THE CLASS THIS POLICES — and why it is worth its own file:
 * `pretooluse-control-bytes-content-guard.mjs` set its REPO_ROOT to a quoted
 * absolute path pointing at the staging tree. Run anywhere else — the checkpoint
 * worktree the green gate actually uses — every path it was asked about fell
 * OUTSIDE that literal root, so the hook decided "not my repo" and allowed
 * everything. It did not crash and it did not warn: it silently stopped guarding.
 * The gate then red-pinned on the guard's own test, hours later, fleet-wide.
 *
 * WHY A SECOND, CLASS-WIDE GUARD: the fix for WI-10811 shipped with a recurrence
 * guard, but that guard asserts about ONE file. It cannot see the next hook
 * someone adds. This directory holds 11+ hook scripts and the population of this
 * bug was exactly 1 — measured, not assumed (see the census note below), which is
 * precisely the state in which a per-file assertion feels sufficient and isn't.
 *
 * FAIL-OPEN IS WHAT MAKES THIS EXPENSIVE. A guard that crashes gets fixed in
 * minutes because everything stops. A guard that quietly answers "allow" looks
 * exactly like a guard with nothing to report, so the failure is invisible at
 * the moment it starts and is discovered only by whatever it let through.
 *
 * SCOPE, STATED HONESTLY: this scans hook + guard scripts by path. It is a
 * TEXTUAL check on assignment shape, so it cannot catch a root smuggled in
 * through a helper, an env default, or string concatenation. It is a ratchet
 * against the one shape that actually bit us, not a proof of portability.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');

/**
 * Absolute paths that are genuinely machine-global and therefore legitimately
 * hardcoded — a process reading /proc is not making a claim about where the
 * repo lives. Without this the guard would flag correct code, and a guard that
 * flags correct code is one people learn to route around.
 */
const SYSTEM_PREFIXES = ['/proc', '/sys', '/dev', '/etc', '/tmp', '/var', '/usr', '/bin', '/opt'];

/** Identifiers that name "where the tree I operate on lives". */
const ROOT_ISH = /(ROOT|REPO|WORKSPACE|CHECKOUT|TREE_?BASE)/i;

/**
 * The detector, kept PURE and exercised against in-memory controls below, so
 * its falsifiability never requires mutating a file in this shared tree
 * (git-sync sweeps the whole tree every few minutes and would commit the mutant).
 */
export function findHardcodedRootAssignments(text: string): string[] {
  const out: string[] = [];
  // A `selfTest()` body is FIXTURE code: its root is a synthetic tree handed to a pure
  // helper (`isCandidateFile(root, '/repo/a.css')`), never the root the script operates
  // on — so it cannot produce the fail-open this guard exists to prevent. Scanning it
  // reported a false offender the moment the 8th nudge script grew a self-test, which
  // would have red-pinned the fleet gate on correct code (WI-37593, 2026-08-09).
  //
  // The block ends at the first COLUMN-0 `}`. Deliberately not brace-counting: a brace
  // inside a string literal would miscount, and the dangerous direction is silent —
  // an unbalanced count never re-enables scanning, disabling the guard for the whole
  // REST of the file. A column-0 close is guaranteed by prettier for a top-level fn.
  let inSelfTest = false;
  for (const raw of text.split('\n')) {
    if (inSelfTest) {
      if (/^\}/.test(raw)) inSelfTest = false;
      continue;
    }
    if (/^\s*(?:async\s+)?function\s+selfTest\s*\(/.test(raw)) {
      inSelfTest = true;
      continue;
    }
    // `const X = '/abs/path'` / let / var, single or double quoted.
    const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"](\/[^'"]*)['"]/.exec(raw);
    if (!m) continue;
    const [, ident, path] = m;
    if (!ROOT_ISH.test(ident!)) continue;
    if (SYSTEM_PREFIXES.some((p) => path === p || path!.startsWith(`${p}/`))) continue;
    out.push(`${ident} = ${path}`);
  }
  return out;
}

/**
 * Guard/hook scripts: the executable surface where fail-open costs the fleet.
 *
 * `includeTestFixtures` exists ONLY so the exclusion below can be measured against
 * the same walker rather than a second hand-rolled one — a filter you cannot
 * measure is a filter that can silently start excluding everything.
 */
function guardScripts({ includeTestFixtures = false } = {}): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a directory that does not exist is not a failure of this guard
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (e !== 'node_modules' && e !== '__tests__') walk(p);
      } else if (e.endsWith('.mjs') && (includeTestFixtures || !e.endsWith('.test.mjs'))) {
        // A `*.test.mjs` sibling is FIXTURE code, not a guard: it never runs as a
        // hook, so it cannot fail open, and its roots are synthetic trees handed to
        // pure helpers (`verificationScopeForNpmArgs({ repoRoot: '/repo', ... })`).
        // This completes the carve-out the `__tests__` DIRECTORY exclusion above
        // already began — the same false-positive class as the `selfTest()` skip in
        // findHardcodedRootAssignments, one level up in the POPULATION rather than
        // inside one file. WI-37593 fixed the inner case by dodging the offending
        // file instead of the detector, and the class recurred (WI-42119, 2026-08-26):
        // a new node:test case in scripts/npm-install-safe.test.mjs red-pinned
        // @papercusp/web fleet-wide for every agent running test:affected.
        found.push(p);
      }
    }
  };
  walk(resolve(ROOT, 'apps/operator/scripts/hooks'));
  walk(resolve(ROOT, 'scripts'));
  return found;
}

describe('guard scripts derive their repo root (WI-10811)', () => {
  it('flags a hardcoded absolute root — the positive control the ratchet depends on', () => {
    // Deliberately wrong, held only in memory. This is what the WI-10811 bug
    // looked like; if this ever stops being flagged the ratchet below is inert
    // and every "no offenders" result underneath it means nothing.
    expect(findHardcodedRootAssignments(`const REPO_ROOT = '/some/absolute/tree';`)).toHaveLength(1);
    expect(findHardcodedRootAssignments(`let workspaceRoot = "/another/abs/path";`)).toHaveLength(1);
  });

  it('does NOT flag the correct derived forms, nor legitimate system paths', () => {
    // Both real shapes in this repo today: the fixed hook, and its dependency
    // scripts/check-no-control-bytes.mjs, which always did it correctly.
    expect(
      findHardcodedRootAssignments(
        `const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');`,
      ),
    ).toEqual([]);
    expect(
      findHardcodedRootAssignments(`const ROOT = fileURLToPath(new URL('..', import.meta.url));`),
    ).toEqual([]);
    // A machine-global path makes no claim about the repo's location.
    expect(findHardcodedRootAssignments(`const DEFAULT_PROC_ROOT = '/proc';`)).toEqual([]);
    // A non-root-ish identifier is out of scope — this guard is deliberately narrow.
    expect(findHardcodedRootAssignments(`const LOGFILE = '/some/abs/log';`)).toEqual([]);
  });

  it('skips a selfTest fixture root — but RESUMES scanning after the block', () => {
    // One assertion, three properties. The third is the one that matters: if the
    // block-end detection ever breaks, the guard silently stops scanning the REST of
    // the file and every later offender goes unreported — a green that means "it
    // stopped checking". LATE_ROOT is the canary for exactly that.
    const src = [
      `const EARLY_ROOT = '/hardcoded/before';`,
      `function selfTest() {`,
      `  const root = '/repo';`,
      `  check('scans', isCandidateFile(root, '/repo/a.css'));`,
      `}`,
      `const LATE_ROOT = '/hardcoded/after';`,
    ].join('\n');
    expect(findHardcodedRootAssignments(src)).toEqual([
      'EARLY_ROOT = /hardcoded/before',
      'LATE_ROOT = /hardcoded/after',
    ]);
  });

  it('calibration: the real 8th nudge script is clean — the false positive is gone', () => {
    // The concrete file that regressed the ratchet (WI-37593): its selfTest binds
    // `const root = '/repo'`, which is fixture data, not the root it operates on.
    const nudge = resolve(
      ROOT,
      'apps/operator/scripts/hooks/cc/posttooluse-css-design-primitives-nudge.mjs',
    );
    expect(findHardcodedRootAssignments(readFileSync(nudge, 'utf8'))).toEqual([]);
  });

  it('calibration: the file WI-10811 fixed is clean, so a pass here is meaningful', () => {
    const fixed = resolve(ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-control-bytes-content-guard.mjs');
    expect(findHardcodedRootAssignments(readFileSync(fixed, 'utf8'))).toEqual([]);
  });

  it('the *.test.mjs exclusion is narrow, non-vacuous, and not how the ratchet goes quiet (WI-42119)', () => {
    const scanned = guardScripts();
    const withFixtures = guardScripts({ includeTestFixtures: true });

    // 1. It excludes exactly what it claims to.
    expect(scanned.filter((f) => f.endsWith('.test.mjs'))).toEqual([]);

    // 2. It is NOT vacuous: there really are `*.test.mjs` files under the scanned
    //    roots today, so a regression that drops the filter re-reds immediately
    //    rather than sitting dormant until someone adds the next fixture.
    expect(
      withFixtures.length,
      'no *.test.mjs under the scanned roots — this exclusion now protects nothing and its removal would be undetectable',
    ).toBeGreaterThan(scanned.length);

    // 3. It did not hollow out the population. This is the failure direction that
    //    LOOKS like success: a filter that over-matches leaves the ratchet green
    //    forever. Both files the calibration cases above assert about must survive.
    expect(scanned.length).toBeGreaterThan(10);
    for (const required of [
      'apps/operator/scripts/hooks/cc/pretooluse-control-bytes-content-guard.mjs',
      'apps/operator/scripts/hooks/cc/posttooluse-css-design-primitives-nudge.mjs',
    ]) {
      expect(
        scanned.some((f) => f.endsWith(required)),
        `${required} fell out of the scanned population — the ratchet is no longer watching it`,
      ).toBe(true);
    }
  });

  it('THE RATCHET: no guard script hardcodes its repo root', () => {
    const scripts = guardScripts();
    // If the scan finds nothing, the ratchet is vacuous and would "pass" forever.
    expect(scripts.length, 'the scan found no guard scripts — the ratchet is inert').toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of scripts) {
      for (const hit of findHardcodedRootAssignments(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.slice(ROOT.length + 1)}: ${hit}`);
      }
    }
    expect(
      offenders,
      'a guard script hardcodes its repo root — it will FAIL OPEN (silently allow everything) in any other worktree, including the one the green gate runs in. Derive it: resolve(dirname(fileURLToPath(import.meta.url)), ...)',
    ).toEqual([]);
  });
});
