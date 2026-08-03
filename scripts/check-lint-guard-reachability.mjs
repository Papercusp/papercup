#!/usr/bin/env node
/**
 * check-lint-guard-reachability.mjs — the META-guard: fails when a declared `lint:*`
 * script is reachable from NO blocking path (EI-19452618085391226).
 *
 * WHY THIS EXISTS. WI-6683 ruled that "a guard on no blocking path is not a guard."
 * The stronger, measured form of that rule is what makes this a gate rather than a
 * tidiness note:
 *
 *   An unwired guard does not merely fail to catch things. It ROTS — silently
 *   accruing false positives and baseline drift — so it fails CLOSED on innocent
 *   files the moment someone finally wires it up.
 *
 * Two instances were measured on 2026-08-03, both silently red, neither noticed:
 *   • `lint:no-sql-comment-backtick` — 7 hits, 7 FALSE POSITIVES, 0 true positives.
 *     Wiring it unchanged would have quarantined a file containing no SQL at all.
 *   • `lint:mock-cast-escape` — a RATCHET that had drifted +45 over its baseline,
 *     i.e. 45 new type-escapes landed past a guard built specifically to ratchet
 *     them down, in ~27h. Nobody saw it because nothing ran it.
 *
 * The natural remediation for an unwired guard ("just wire it up") is therefore the
 * dangerous one: it lands a RED gate on the whole fleet, caused by defects that
 * accrued invisibly while it ran nowhere. This check makes the rot detectable at the
 * moment a guard becomes unreachable, instead of at the moment someone needs it.
 *
 * ── WHAT COUNTS AS REACHABLE ─────────────────────────────────────────────────
 * Every root set below is DERIVED BY SCANNING, never hand-listed, so a guard that is
 * added, renamed, or dropped from a runner re-classifies itself with no edit here.
 * That is the same anti-drift property `enforcement-tier-census.ts` relies on: the
 * population comes from the scan, so nothing vanishes by being forgotten.
 *
 *   gate      — run by the green-checkpoint release gate  → BLOCKING
 *   ci        — run by a .github/workflows/* job          → BLOCKING
 *   test      — EXECUTED over the real tree by a *.test.ts (which the gate's own
 *               affected-suite leg runs)                  → BLOCKING
 *   chained   — run via `npm run <it>` by another script that is itself reachable
 *                                                         → inherits that tier
 *   hook      — invoked only from a Claude PreToolUse/PostToolUse hook → ADVISORY.
 *               Deliberately NOT blocking: a hook nudges the one agent who tripped
 *               it and blocks nothing, so a hook-only guard still rots.
 *   logic-test— a *.test.ts imports its PURE HELPERS and feeds them fixtures, but
 *               never runs the guard over the tree → ADVISORY, see below.
 *   (none)    — UNREACHABLE. The defect this script exists to catch.
 *
 * ── WHY `logic-test` IS NOT ENFORCEMENT (the subtle case, measured) ───────────
 * A unit test of a guard's helpers proves the DETECTOR works. It does not run the
 * detector over anything, so it catches no violation and blocks no commit — while
 * making the guard look thoroughly covered, which is worse than no test at all.
 *
 * `lint:mock-cast-escape` is the proof: `check-mock-cast-escape.test.ts` imports
 * `decide` / `findMockCastEscapesInText` / `maskStringsAndComments` and asserts
 * against string literals. Every one of those tests passed, continuously, across the
 * entire window in which the guard's real-tree count drifted +45 past its baseline.
 * A green logic test and a rotting guard are perfectly compatible states.
 *
 * The discriminator is therefore whether the test EXECUTES the guard against real
 * repository files (`ENFORCING_TEST_RE`) — spawning it, or driving its scan over a
 * repo-root path — not merely whether a test mentions it.
 *
 * ── KNOWN LIMITATION: the `ci` tier is credited GENEROUSLY ───────────────────
 * `ci` counts as blocking here, and on this box that is arguably too kind.
 * `green-checkpoint.ts`'s own `lint:no-control-bytes` comment records the precedent:
 * that guard "was already wired into .github/workflows/test.yml, but that workflow
 * does not gate this box's main-advance, and it had been failing for other reasons,
 * so the guard's own three-day red went unread" — i.e. a CI-tier guard rotted exactly
 * like an unwired one, and the fix was to gate it in green-checkpoint instead.
 *
 * It is left as blocking DELIBERATELY, not by oversight. Demoting it would move ~38
 * guards into the unenforced set in one step, and an allowlist that large is the
 * parking lot this script exists to prevent — the same shape as raising a watermark
 * to absorb debt rather than paying it. Tightening it is real work with a real
 * measurement behind it (does THIS box's main-advance consult CI?), so it is tracked
 * separately rather than smuggled in here. Read a `ci` classification as "a red would
 * be visible somewhere", not as "a red stops the release."
 *
 * ── KNOWN LIMITATION: this census models ENFORCEMENT EXISTENCE, never TIMING ──
 * `classifyGuard` asks only WHICH CORPUS mentions a guard, and returns the strongest
 * tier in BLOCKING_TIERS. That answers "would a red ever be SEEN?" It does NOT answer
 * "would the red arrive before the damage?" — the census has no notion of when a guard
 * fires, and none of who CONSUMES the artifact it guards. Those are different questions,
 * and a guard can score `gate` here while being structurally incapable of protecting a
 * given consumer.
 *
 * The case that proves it (raised by su-b9269, 2026-08-03, and demonstrated the same day):
 * `apps/operator/bin/bundle-host.sh` esbuild-bundles operator-core as `ExecStartPre` for
 * `papercup-staging-api` / `papercup-bg-host` — i.e. those consumers read the WORKING
 * TREE, before any commit exists. So every commit-time-or-later guard is unreachable for
 * them BY CONSTRUCTION, however well wired. On 2026-08-03 a saved-but-uncommitted backtick
 * inside a `sql` template literal (watchdog.ts:1836) crash-looped :3170 fleet-wide for 17
 * minutes while every relevant guard was, by this script's measure, fully enforced.
 *
 * So: "enforced" is NOT "prevents". Read a BLOCKING classification as "a red would stop
 * something downstream", never as "this artifact's consumers are protected."
 *
 * Deliberately NOT modelled rather than modelled badly: doing it properly needs a map from
 * each guarded artifact to its consumers and the stage at which each reads it (working tree
 * / commit / candidate / release). A hand-maintained `timing:` label per guard would rot
 * exactly the way this script's derive-from-the-runners design exists to prevent. Tracked
 * separately — see EI-19457231269012320 (edit-time parse check, the only tier that can
 * protect a working-tree consumer) and EI-19457273276133433.
 *
 * ── THE UNDER-CLAIM THIS AVOIDS ──────────────────────────────────────────────
 * The filing that prompted this deliberately under-claimed its own headline number:
 * "not referenced by npm-script NAME" is NOT the same as "runs nowhere", because
 * several guards are invoked by direct script PATH rather than by npm name (e.g.
 * `check-migration-fixture-drift.mjs` runs from a PostToolUse hook). So this script
 * resolves each guard to its IMPLEMENTATION FILE and searches for that path too —
 * never for the npm name alone. Erring toward "reachable" is deliberate: a false
 * UNREACHABLE would send someone to wire a guard that is already enforced, which is
 * exactly the wasteful direction.
 *
 * Usage:
 *   node scripts/check-lint-guard-reachability.mjs            # gate
 *   node scripts/check-lint-guard-reachability.mjs --json     # machine-readable census
 *   node scripts/check-lint-guard-reachability.mjs --census   # human table, always exit 0
 *
 * Exit codes:
 *   0 — every declared guard is reachable, or allow-listed with a reason
 *   1 — an unreachable guard is not allow-listed, or an allowlist entry is STALE
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Guards whose unreachability is ACKNOWLEDGED, each with the decision that makes it
 * acceptable for now. This is an allowlist of *pending decisions*, not a parking lot:
 * every entry states what has to happen and which work-item owns it.
 *
 * ⚠ SHRINK-ONLY. `UNREACHABLE_HIGH_WATERMARK` below fails the build if this set grows.
 * The correct way to add a guard is to WIRE it (or retire it), not to append here —
 * the same rule `KNOWN_DARK_FLAGS` carries, for the same reason: an allowlist that
 * grows freely reproduces exactly the invisible rot this script exists to detect.
 */
export const ACKNOWLEDGED_UNREACHABLE = new Map([
  // ── Seeded 2026-08-03 from the first census run (EI-19452618085391226). ──────
  // Every entry below was ALREADY unenforced before this check existed. The seed
  // pins the debt at its MEASURED size so it can only shrink, and blesses none of
  // it: the point of seeding rather than failing outright is that wiring 13 rotted
  // guards at once is precisely the fleet-reddening move this script warns against.
  // What the check buys immediately is the ratchet — a NEW unenforced guard fails
  // the build on the commit that orphans it.

  // MEASURED RED. Ratchet drifted +45 past its baseline in ~27h (1121 vs 1076) while
  // its green unit test made it look covered. Burn-down + wiring owned by the filing.
  ['lint:mock-cast-escape', 'RED — burn-down in progress, EI-19452618085391226; wire once at baseline'],

  // MEASURED GREEN 2026-08-03, but enforced by nothing. Each needs a deliberate
  // wire-or-retire call (EI-19452618085391226 correct-state #2). Listed individually
  // rather than as a pattern so that retiring one is a visible one-line deletion.
  ['lint:constant-conditional', 'green (9342 files parsed); pending wire-or-retire decision'],
  ['lint:no-workspace-default', 'green; pending wire-or-retire decision'],
  ['lint:scope-defaults', 'advisory by design, but its :strict sibling exits 1; pending decision'],
  ['lint:knip', 'unused-export sweep; run by nothing — pending wire-or-retire decision'],
  // ⚠ CLAUDE.md states "lint:no-retired guards re-imports" of retired surfaces. Nothing
  // runs it, so that documented guarantee is currently unenforced — a doc asserting a
  // guard that does not run is the quotable-green this whole check exists to stop.
  ['lint:no-retired', 'DOC-ASSERTED but unenforced — CLAUDE.md claims it guards retired-surface re-imports'],

  // Coverage is a UNIT TEST of the detector's helpers only — the guard itself runs
  // over nothing. Remedy is to deepen the existing test into a real-tree assertion,
  // which is cheaper than wiring a gate leg; that is why these are grouped apart.
  ['lint:as-committed', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:explicit-presence', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:generic-independence', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:no-raw-spawn', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:no-retired-style', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:no-unenrolled-mjs-imports', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:optional-seam-strands', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:typeless-reexport', 'logic-test only; deepen to a real-tree assertion'],
  ['lint:vitest-mock-paths', 'logic-test only; deepen to a real-tree assertion'],
]);

/**
 * Ceiling on the acknowledged set. SHRINK-ONLY: wire or retire a guard instead of
 * appending. Raising it needs owner sign-off and a stated reason, exactly like
 * `DARK_FLAGS_HIGH_WATERMARK` — and for the same reason, since an allowlist that
 * grows freely reproduces the invisible rot this script exists to detect.
 */
export const UNREACHABLE_HIGH_WATERMARK = 15;

/**
 * Tiers that actually STOP a bad change. `hook` and `logic-test` are deliberately
 * excluded — see the header: both are real coverage of a kind, and neither blocks.
 */
export const BLOCKING_TIERS = new Set(['gate', 'ci', 'test', 'chained']);

/**
 * A test EXECUTES a guard over the real tree (rather than unit-testing its helpers)
 * when it spawns the script or drives a scan rooted at the repository. Kept
 * deliberately generous: over-crediting a test yields a missed report, while
 * under-crediting sends someone to wire an already-enforced guard — and of those two
 * wrong answers, only the second wastes a fleet-wide gate run.
 */
export const ENFORCING_TEST_RE = /execFileSync|spawnSync|execSync|listTrackedFiles|REPO_ROOT|repoRoot|process\.cwd\(\)/;

/**
 * Companion INVOCATIONS of a guard rather than guards in their own right: a different
 * strictness or a write mode over the SAME implementation. Counting them separately
 * double-counts the debt — enforcement is a property of the implementation, not of how
 * many npm aliases point at it — so a base guard that IS wired makes its `:strict`
 * sibling enforced too, and a base guard that is not shows up once, not twice.
 */
const COMPANION_SUFFIX_RE = /:(fix|report|census|strict|all|fail|update)$/;

/**
 * Blank out COMMENTS before matching. A runner file that merely *discusses* a guard in
 * prose must not count as running it.
 *
 * This is not hypothetical tidiness — it fired on this very script. The
 * `green-checkpoint.ts` leg added for THIS check carries a comment naming
 * `lint:mock-cast-escape` as the motivating example; that one sentence reclassified the
 * rotting guard from `logic-test` to `gate`, i.e. the checker declared its own
 * motivating case fully enforced. It is also precisely the failure that produced
 * instance 1 in the filing, where a doc comment *about* a SQL bug pulled a file
 * containing no SQL into a SQL linter's scope: prose describing a rule reads exactly
 * like the rule being applied.
 *
 * String literals are deliberately KEPT — `exec('npm', ['run', 'lint:x'])` is a real
 * invocation living in a string, so masking those would blind the gate tier entirely.
 *
 * ⚠ LINE-BASED on purpose. The obvious implementation — `text.replace(/\/\*[\s\S]*?\*\//g)`
 * plus a `//` rule — is what this function had first, and it silently ate REAL CODE:
 * `lint:plane-adoption` is wired at green-checkpoint.ts:5094 as a plain array entry, and
 * that regex removed the line, reporting a properly-gated guard as unenforced. In a file
 * this size an unbalanced `/*` inside a string or regex literal lets a non-greedy block
 * match run for thousands of lines, so the damage is unbounded and invisible.
 *
 * Dropping only lines that are ENTIRELY comment cannot do that, and it still removes the
 * whole prose case, because narrative about a guard always lives in a comment block —
 * never trailing a line of code that invokes something else.
 */
export function stripComments(text, { yaml = false } = {}) {
  const commentLine = yaml ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
  return String(text)
    .split('\n')
    .map((line) => (commentLine.test(line) ? '' : line))
    .join('\n');
}

/** `lint:foo` guards, minus the companion invocations described above. */
export function selectGuardScripts(scripts) {
  return Object.keys(scripts)
    .filter((name) => name.startsWith('lint:') && !COMPANION_SUFFIX_RE.test(name))
    .sort();
}

/**
 * The implementation file(s) a script command runs — `node scripts/x.mjs`,
 * `tsx scripts/x.mjs`, `npx tsx path/to/x.ts`, … Returns repo-relative paths.
 * A guard with no resolvable implementation (a bare `knip`, a shell pipeline) yields
 * an empty list and is then matched by npm NAME only.
 */
export function resolveImplementationPaths(command) {
  const out = new Set();
  for (const m of String(command).matchAll(/(?:^|\s)((?:scripts|apps|packages|libs)\/[\w./-]+\.(?:mjs|cjs|js|ts))/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/** Every `npm run <name>` referenced by a command. */
export function referencedScripts(command) {
  return [...String(command).matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]);
}

/**
 * Classify one guard against the pre-built runner corpora.
 * Returns the STRONGEST tier found, plus every tier for reporting.
 */
export function classifyGuard({ name, command, corpora }) {
  const impls = resolveImplementationPaths(command);
  const tiers = [];
  const mentions = (text) => text.includes(name) || impls.some((p) => p && text.includes(p));
  for (const [tier, text] of Object.entries(corpora)) {
    if (mentions(text)) tiers.push(tier);
  }
  const blocking = tiers.filter((t) => BLOCKING_TIERS.has(t));
  return {
    name,
    impls,
    tiers,
    tier: blocking[0] ?? tiers[0] ?? null,
    blocking: blocking.length > 0,
  };
}

/**
 * The whole census. `corpora` maps tier → concatenated source text of every runner in
 * that tier. Pure so it is unit-testable without a repo.
 */
export function buildReachabilityCensus({ scripts, corpora, acknowledged = new Map() }) {
  const rows = selectGuardScripts(scripts).map((name) =>
    classifyGuard({ name, command: scripts[name], corpora }),
  );

  // A `chained` guard inherits reachability from whatever reachable script runs it.
  const blockingNames = new Set(rows.filter((r) => r.blocking).map((r) => r.name));
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (!blockingNames.has(scriptName)) continue;
    for (const ref of referencedScripts(command)) {
      const row = rows.find((r) => r.name === ref);
      if (row && !row.blocking) {
        row.blocking = true;
        row.tier = 'chained';
        row.tiers = [...row.tiers, 'chained'];
      }
    }
  }

  // NOT ENFORCED = no blocking path runs it, whether that is because NOTHING runs it
  // (`tier: null`) or because its only coverage is advisory (`hook` / `logic-test`).
  //
  // ⚠ Both count. An earlier draft of this check failed only on `tier: null`, and that
  // draft would NOT have caught `lint:mock-cast-escape` — the very guard whose +45
  // baseline drift prompted this script — because it has a green logic test and so
  // looked covered. A check that misses its own motivating instance is not a check.
  // The `tier` is retained per row so the remedy is still distinguishable: deepen an
  // existing test vs. wire one from scratch.
  const notEnforced = rows.filter((r) => !r.blocking);
  const unreachable = notEnforced.filter((r) => r.tier === null);
  const advisoryOnly = notEnforced.filter((r) => r.tier !== null);
  const unacknowledged = notEnforced.filter((r) => !acknowledged.has(r.name));
  // An allowlist entry for a guard that no longer exists keeps asserting a decision
  // about nothing — the same staleness `findStaleDeclarations` catches for tiers.
  const declaredNames = new Set(rows.map((r) => r.name));
  const staleAcknowledgements = [...acknowledged.keys()].filter((n) => !declaredNames.has(n));

  return { rows, notEnforced, unreachable, advisoryOnly, unacknowledged, staleAcknowledgements };
}

/* ── repo I/O (impure; the logic above stays pure) ───────────────────────────── */

function readIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

function buildCorpora() {
  const { files } = listTrackedFiles(ROOT);

  const gate = stripComments(readIfExists(resolve(ROOT, 'apps/operator/lib/release/green-checkpoint.ts')));

  const wfDir = resolve(ROOT, '.github/workflows');
  const ci = existsSync(wfDir)
    ? readdirSync(wfDir)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => stripComments(readIfExists(resolve(wfDir, f)), { yaml: true }))
        .join('\n')
    : '';

  // Split the test corpus: only a test that RUNS the guard over real files enforces
  // anything. One that imports its pure helpers and asserts against fixtures goes to
  // the advisory `logic-test` pile — see the header for why that distinction is the
  // whole point of this check.
  const testTexts = files
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
    .map((f) => stripComments(readIfExists(resolve(ROOT, f))));
  const test = testTexts.filter((t) => ENFORCING_TEST_RE.test(t)).join('\n');
  const logicTest = testTexts.filter((t) => !ENFORCING_TEST_RE.test(t)).join('\n');

  const hook = [
    ...files.filter((f) => f.includes('/hooks/') && !f.endsWith('.test.ts')),
    '.claude/settings.json',
  ]
    .map((f) => stripComments(stripComments(readIfExists(resolve(ROOT, f))), { yaml: true }))
    .join('\n');

  // Key order matters: `classifyGuard` reports the first matching tier for a guard
  // with no blocking tier, so the advisory tiers come last.
  return { gate, ci, test, hook, 'logic-test': logicTest };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const censusOnly = argv.includes('--census');

  // Subject path is overridable so falsifiability can be proven against a COPY,
  // never by mutating this shared tree (CLAUDE.md § "Proving a guard is falsifiable":
  // git-sync sweeps the whole tree every few minutes, so a probe that edits
  // package.json in place can have its mutant committed by a passing sweep).
  const pkgPath = process.env.LINT_GUARD_REACHABILITY_PACKAGE_JSON || resolve(ROOT, 'package.json');
  const scripts = JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts ?? {};
  const census = buildReachabilityCensus({
    scripts,
    corpora: buildCorpora(),
    acknowledged: ACKNOWLEDGED_UNREACHABLE,
  });

  if (json) {
    console.log(JSON.stringify(census, null, 2));
    if (censusOnly) process.exit(0);
  }

  const byTier = {};
  for (const r of census.rows) byTier[r.tier ?? 'UNREACHABLE'] = (byTier[r.tier ?? 'UNREACHABLE'] ?? 0) + 1;

  if (!json) {
    console.log(`lint-guard reachability — ${census.rows.length} declared guards`);
    for (const [tier, n] of Object.entries(byTier).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${tier}${tier === 'hook' ? '  (advisory — nudges, blocks nothing)' : ''}`);
    }
  }

  if (censusOnly) {
    if (!json && census.notEnforced.length) {
      console.log(`\nNOT ENFORCED (${census.notEnforced.length}) — no blocking path runs these:`);
      for (const r of census.notEnforced) {
        console.log(`  [${r.tier ?? 'nothing-runs-it'}] ${r.name}  ${r.impls.join(' ') || '(no resolvable implementation)'}`);
      }
    }
    process.exit(0);
  }

  let failed = false;

  if (census.staleAcknowledgements.length) {
    failed = true;
    console.error(`\n❌ ${census.staleAcknowledgements.length} STALE allowlist entr(ies) — the guard no longer exists:`);
    for (const n of census.staleAcknowledgements) console.error(`     ${n}`);
    console.error('   Remove them: they assert a pending decision about a script that is gone.');
  }

  if (census.unacknowledged.length) {
    failed = true;
    console.error(`\n❌ ${census.unacknowledged.length} lint guard(s) run on NO blocking path:`);
    for (const r of census.unacknowledged) {
      const why =
        r.tier === 'logic-test'
          ? 'only a UNIT TEST of its helpers — proves the detector works, runs it over nothing'
          : r.tier === 'hook'
            ? 'only a Claude hook — nudges one agent, blocks nothing'
            : 'nothing runs it at all';
      console.error(`     ${r.name}  →  ${r.impls.join(' ') || '(no resolvable implementation)'}`);
      console.error(`        ${why}`);
    }
    console.error('');
    console.error('   A guard that is neither wired nor retired is WORSE than no guard: it rots');
    console.error('   (false positives + baseline drift accrue invisibly) and its green gets quoted');
    console.error('   as evidence. Pick one, deliberately:');
    console.error('     • WIRE it — add it to a green-checkpoint leg, a CI job, or exercise it from a');
    console.error('       *.test.ts. FIRST measure its false-positive rate against the whole real tree');
    console.error('       and prove it still catches its historical incidents; porting an unwired guard');
    console.error('       unchanged is how you red-pin the fleet on defects that accrued while it slept.');
    console.error('     • RETIRE it — delete the script and its implementation.');
  }

  if (ACKNOWLEDGED_UNREACHABLE.size > UNREACHABLE_HIGH_WATERMARK) {
    failed = true;
    console.error(
      `\n❌ acknowledged-unreachable set exceeds its watermark: ${ACKNOWLEDGED_UNREACHABLE.size} > ${UNREACHABLE_HIGH_WATERMARK}.`,
    );
    console.error('   This set is SHRINK-ONLY. Wire or retire a guard instead of appending here.');
  }

  if (failed) process.exit(1);
  // State the acknowledged debt in the PASS line. A green that reads "everything is
  // enforced" while 13 guards are not is the same quotable-green this script exists to
  // stop — the number has to be visible in the ordinary output, not only on failure.
  const enforced = census.rows.length - census.notEnforced.length;
  console.log(
    `\n✓ no NEW unenforced lint guard. ${enforced}/${census.rows.length} enforced; ` +
      `${census.notEnforced.length} acknowledged-unenforced (ceiling ${UNREACHABLE_HIGH_WATERMARK}, shrink-only).`,
  );
  if (census.notEnforced.length) {
    console.log('  Burn it down: `node scripts/check-lint-guard-reachability.mjs --census` lists each one and why.');
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
