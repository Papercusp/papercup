/**
 * pure-lane-unbounded-sync-spawn.test.ts — WI-41180.
 *
 * THE DEFECT THIS RATCHETS DOWN. A synchronous child-process call blocks the worker's event
 * loop inside libuv's `uv_spawn_sync`, which polls the child's stdout/stderr pipes. While that
 * loop is blocked NO JS TIMER CAN FIRE — so vitest's `testTimeout` and `hookTimeout` cannot
 * interrupt it, because both are implemented as timers. It is the one shape of test hang the
 * test framework is structurally unable to bound.
 *
 * WHY THE PURE LANE SPECIFICALLY. The pure lane runs `isolate: false` — ~2,740 operator-core
 * files SHARE a fork (libs/test-config/src/vitest-config.ts). A block in one file therefore
 * stalls every co-resident file in that fork, not just itself. MEASURED 2026-08-24 on run
 * `3882365-cd0504e1`: `lib/js-syntax-guard.test.ts` ran the full-tree `check-js-syntax` guard
 * through an unbounded sync spawn; captured output froze at 522,385 bytes between elapsed 120s
 * and 180s and never moved again, and `@papercusp/operator-core :: test:lane-pure` was SIGKILLed
 * by the batch watchdog at its 2700s floor with 2,731 of 2,740 files done. 45 minutes per
 * whole-radius affected run, with lane-pure coverage silently unmeasured. Nothing in the stack
 * could report it: the runner's own heartbeat rose identically for "working" and "wedged".
 *
 * WHAT THIS GUARD DOES, AND DELIBERATELY DOES NOT DO. It is a SHRINK-ONLY RATCHET, not a
 * clean-tree assertion. 91 pure-lane files carried an unbounded sync spawn when this was written
 * (AST-measured: ~208 real call sites), and bounding all of them at once is a change nobody could
 * review. So the baseline below grandfathers the ones that already existed and the guard fails on:
 *   (a) any NEW pure-lane file that introduces an unbounded sync spawn, and
 *   (b) any baseline entry that has since been FIXED but not removed from the list —
 *       without (b) the list rots into a permanent allowlist and the ratchet stops turning.
 *
 * THE BOUND IS A `timeout` OPTION on the call. That is the only thing that makes a sync spawn
 * interruptible; a `try/catch`, an `AbortSignal`, or a wrapper's own timer cannot help, because
 * none of them get to run while the loop is blocked.
 *
 * SHORTHAND IS A REAL BOUND (WI-41223). `spawnSync(bin, argv, { encoding: 'utf8', timeout, env })`
 * — where `timeout` is a parameter with a default — is fully bounded, and the first cut's
 * `timeout:`-only text match read it as an offender. Exactly one baselined file used that form
 * (desktop-sandbox-live.test.ts, bounded at 30s) and it was consequently unclearable. The AST
 * reader below treats a ShorthandPropertyAssignment as the bound it is.
 *
 * KNOWN LIMIT (documented, not defended). The scan reads each call's LAST argument, so a bound it
 * cannot see through — `spawnSync(bin, argv, opts)`, or `{ ...opts }` — is reported as an
 * offender. That is the deliberate direction to err in, and unlike the quoted-mention false
 * positives this replaced, it is ACTIONABLE: inline an explicit `timeout` and the report clears.
 * A false positive is only cheap when the developer can DO something about it.
 *
 * If a legitimate call ever trips it, bound the call — do NOT add the file to BASELINE.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLaneInclude } from '@papercusp/test-config/lane-split';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Built with `new RegExp` from a source string in which each name is followed by `|` or `)`,
 * never by an open paren, so this file's own detector source cannot match itself. The scan
 * additionally skips this file by path (see SELF) — belt and braces, since a future edit could
 * easily reintroduce the literal call shape in a comment.
 */
const SYNC_SPAWN = String.raw`\b(execFileSync|spawnSync|execSync)\s*\(`;

const SELF = 'lib/__tests__/pure-lane-unbounded-sync-spawn.test.ts';

const SYNC_SPAWN_NAMES = new Set(['execFileSync', 'spawnSync', 'execSync']);

/**
 * Count sync-spawn calls in `source` that carry no `timeout` option.
 *
 * TWO STAGES, and the split is load-bearing for cost. `SYNC_SPAWN` is a cheap prefilter run over
 * the WHOLE ~2,740-file lane roster; only the handful of files it hits are parsed. Parsing the
 * whole roster with the TypeScript scanner would turn a ~2s guard into a slow one, and a guard
 * nobody wants to run is a guard that stops running.
 *
 * WHY THE AST AND NOT A REGEX (WI-41223). The regex version counted any TEXT that looked like a
 * call, and MEASURED on the real tree that was 37 of 179 reported sites — 21% noise. The noise is
 * not evenly spread: it lands hardest on the files whose JOB is to quote these calls. A test for a
 * detector-of-guard-invocations (`check-lint-guard-reachability.test.ts`) held 9 quoted mentions
 * and executes ZERO sync spawns; `git-log-utc-timestamp.test.ts` held 6. SEVEN baselined files had
 * no real call at all.
 *
 * That is not the harmless direction the first cut assumed. A phantom cannot be BOUNDED — you
 * cannot add a `timeout` to a string that a test asserts on without changing what the test
 * measures — so a phantom entry can never leave BASELINE. The ratchet jams on it permanently, and
 * the list rots into exactly the allowlist that assertion (b) exists to prevent. A false positive
 * is only cheap when it is ACTIONABLE; these were not.
 *
 * WHAT STILL COUNTS AS UNBOUNDED, deliberately. An options object this cannot read through —
 * `spawnSync(bin, argv, opts)` or `{ ...opts }` — is reported. That case IS actionable (inline an
 * explicit `timeout`), so it never jams the ratchet, and treating an unreadable bound as absent
 * keeps the error on the safe side.
 */
export function countUnboundedSyncSpawns(source: string): number {
  if (!new RegExp(SYNC_SPAWN).test(source)) return 0;
  const sf = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  let unbounded = 0;

  const isBound = (node: ts.Node | undefined): boolean => {
    if (!node || !ts.isObjectLiteralExpression(node)) return false;
    return node.properties.some((p) => {
      // `timeout: 5_000` and `timeout` (ES6 shorthand — a real bound the regex version missed)
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const n = p.name;
        return (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === 'timeout';
      }
      return false; // a spread is unreadable, so not a proof of boundedness
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name && SYNC_SPAWN_NAMES.has(name) && !isBound(node.arguments.at(-1))) unbounded++;
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return unbounded;
}

/** Pure-lane files (workspace-relative, no leading `./`) that currently have >=1 unbounded call. */
function scanPureLane(): { roster: string[]; offenders: string[] } {
  // `.include` is `string[] | null` — null means the lane resolved to nothing. Coerce to [] rather
  // than throwing, so that case surfaces as the DENOMINATOR test failing (a scan of nothing is not
  // a pass) instead of as an opaque TypeError from a helper.
  const selected = resolveLaneInclude(WORKSPACE_ROOT, 'pure').include ?? [];
  const roster = selected.map((f) => f.replace(/^\.\//, ''));
  const offenders: string[] = [];
  for (const rel of roster) {
    if (rel === SELF) continue;
    let src: string;
    try {
      src = readFileSync(path.join(WORKSPACE_ROOT, rel), 'utf8');
    } catch {
      continue; // raced with a concurrent edit on this shared tree; not this guard's subject
    }
    if (countUnboundedSyncSpawns(src) > 0) offenders.push(rel);
  }
  return { roster, offenders };
}

/**
 * Grandfathered offenders, measured 2026-08-24 (WI-41180). SHRINK-ONLY: never add an entry to
 * make a new test pass — bound the call instead. Removing one is always correct.
 */
const BASELINE: readonly string[] = [
];

describe('pure lane — unbounded synchronous spawns (WI-41180 ratchet)', () => {
  it('CALIBRATION: the detector flags an unbounded call and stays silent on a bounded one', () => {
    // Inline fixtures, never a tree mutation: git-sync sweeps this shared checkout every few
    // minutes, so a probe holding a tracked file mutated can have the mutant COMMITTED with
    // nothing going wrong (CLAUDE.md, "Proving a guard is falsifiable").
    const unbounded = `execFileSync(process.execPath, [X], { encoding: 'utf8', cwd: ROOT })`;
    const bounded = `execFileSync(process.execPath, [X], { encoding: 'utf8', timeout: 120_000 })`;
    expect(countUnboundedSyncSpawns(unbounded)).toBe(1);
    expect(countUnboundedSyncSpawns(bounded)).toBe(0);

    // A `timeout:` on a LATER call must not launder an EARLIER unbounded one.
    expect(countUnboundedSyncSpawns(`${unbounded};\n${bounded};`)).toBe(1);

    // And a file with no sync spawn at all is silent — otherwise every negative below is vacuous.
    expect(countUnboundedSyncSpawns(`await execFile('git', ['status']);`)).toBe(0);
  });

  it('counts CODE only: a quoted or commented mention is not a call (WI-41223)', () => {
    // The regression these pin cost 37 of 179 reported sites, and produced SEVEN baselined files
    // with no real call at all. A phantom cannot be bounded — adding `timeout:` inside a string a
    // test asserts on changes what the test measures — so it can never leave BASELINE and the
    // ratchet jams on it forever. Files whose JOB is to quote these calls (a test for a
    // detector-of-guard-invocations) are hit hardest, which is exactly where the noise is worst.
    expect(countUnboundedSyncSpawns(`const fixture = "spawnSync('node', ['x.mjs'])";`)).toBe(0);
    expect(countUnboundedSyncSpawns(`const fixture = 'execSync("ls")';`)).toBe(0);
    expect(countUnboundedSyncSpawns('const fixture = `spawnSync(BIN, [])`;')).toBe(0);
    expect(countUnboundedSyncSpawns(`// execFileSync('node', [SCRIPT])`)).toBe(0);
    expect(countUnboundedSyncSpawns(`/* spawnSync('sh', ['-c', 'x']) */`)).toBe(0);

    // A regex literal containing a quote is what breaks a hand-rolled string-stripper: its state
    // machine desyncs on the quote and blanks out the REAL code that follows, silently
    // under-reporting. The AST cannot desync, and this pins that it does not.
    expect(countUnboundedSyncSpawns(`const q = /['"]/g;\nspawnSync('sh', ['-c', 'x']);`)).toBe(1);

    // But a real call INSIDE a template interpolation is still code, and still counts.
    expect(countUnboundedSyncSpawns('const s = `${spawnSync(BIN, [])}`;')).toBe(1);
  });

  it('reads a bound the regex version could not, and refuses one it cannot verify', () => {
    // ES6 shorthand IS a bound. Missing it is what kept desktop-sandbox-live.test.ts — bounded at
    // 30s via `function run(bin, argv, timeout = 30_000)` — permanently unclearable in BASELINE.
    expect(countUnboundedSyncSpawns(`spawnSync(bin, argv, { encoding: 'utf8', timeout, env });`)).toBe(0);
    expect(countUnboundedSyncSpawns(`spawnSync(bin, argv, { timeout });`)).toBe(0);

    // A member-access callee is the same call.
    expect(countUnboundedSyncSpawns(`cp.execFileSync('git', ['status']);`)).toBe(1);

    // Unreadable options are reported, on purpose: unlike a quoted mention this is ACTIONABLE
    // (inline an explicit timeout), so it never jams the ratchet.
    expect(countUnboundedSyncSpawns(`spawnSync(bin, argv, opts);`)).toBe(1);
    expect(countUnboundedSyncSpawns(`spawnSync(bin, argv, { ...opts });`)).toBe(1);
  });

  it('DENOMINATOR: the pure-lane roster actually resolved (a scan of nothing is not a pass)', () => {
    const { roster } = scanPureLane();
    // The whole class this guard belongs to fails silently toward "clean": a roster that
    // resolves to nothing prints a green that is indistinguishable from a real one.
    expect(roster.length).toBeGreaterThan(1000);
  });

  it('no NEW pure-lane file introduces an unbounded synchronous spawn', () => {
    const { offenders } = scanPureLane();
    const added = offenders.filter((f) => !BASELINE.includes(f));
    expect(
      added,
      `\nThese pure-lane test files make a synchronous child-process call with no \`timeout:\`.\n` +
        `A sync spawn blocks the worker's event loop, so vitest CANNOT time it out, and the pure\n` +
        `lane shares one fork across ~2,740 files — a block here wedges all of them until the\n` +
        `batch watchdog kills the task 45 minutes later (WI-41180).\n\n` +
        `FIX: pass \`timeout:\` (and \`killSignal: 'SIGKILL'\`) to the call.\n` +
        `Do NOT add the file to BASELINE — that list only ever shrinks.\n`,
    ).toEqual([]);
  });

  it('BASELINE is shrink-only: every grandfathered entry still has an unbounded call', () => {
    const { roster, offenders } = scanPureLane();
    const inRoster = new Set(roster);
    const stale = BASELINE.filter((f) => inRoster.has(f) && !offenders.includes(f));
    expect(
      stale,
      `\nThese files were fixed (or their calls bounded) but are still listed in BASELINE.\n` +
        `Delete them from the list so the ratchet keeps turning — a baseline that outlives its\n` +
        `offenders decays into a permanent allowlist.\n`,
    ).toEqual([]);
  });
});
