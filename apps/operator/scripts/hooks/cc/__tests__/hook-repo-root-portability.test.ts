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
  for (const raw of text.split('\n')) {
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

/** Guard/hook scripts: the executable surface where fail-open costs the fleet. */
function guardScripts(): string[] {
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
      } else if (e.endsWith('.mjs')) {
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

  it('calibration: the file WI-10811 fixed is clean, so a pass here is meaningful', () => {
    const fixed = resolve(ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-control-bytes-content-guard.mjs');
    expect(findHardcodedRootAssignments(readFileSync(fixed, 'utf8'))).toEqual([]);
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
