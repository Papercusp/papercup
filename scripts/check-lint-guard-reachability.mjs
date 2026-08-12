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
 * `decide` / `findMockCastEscapesInText` (and, until the 2026-08-10 AST rewrite,
 * `maskStringsAndComments`) and asserts against string literals. Every one of those
 * tests passed, continuously, across the entire window in which the guard's real-tree
 * count drifted +45 past its baseline — and across a later window in which the
 * detector was silently blind to 13 real escapes (EI-20059456952698638).
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

  // `lint:mock-cast-escape` USED TO SIT HERE and is now GONE from this set — burned down
  // 1121 → 1061 (under its 1076 baseline) and wired as a green-checkpoint leg on 2026-08-03.
  // Left as a comment rather than silently deleted because it is this set's first GRADUATION,
  // and the graduation is the point: entries here are debts to pay, not a parking lot.
  // The watermark dropped 15 → 14 with it, which is the only direction it may ever move.

  // MEASURED GREEN 2026-08-03, but enforced by nothing. Each needs a deliberate
  // wire-or-retire call (EI-19452618085391226 correct-state #2). Listed individually
  // rather than as a pattern so that retiring one is a visible one-line deletion.
  ['lint:constant-conditional', 'green (9342 files parsed); pending wire-or-retire decision'],
  ['lint:no-workspace-default', 'green; pending wire-or-retire decision'],
  ['lint:scope-defaults', 'advisory by design, but its :strict sibling exits 1; pending decision'],
  ['lint:knip', 'unused-export sweep; run by nothing — pending wire-or-retire decision'],
  // `lint:no-retired` USED TO SIT HERE — "DOC-ASSERTED but unenforced". It is now
  // WIRED (REPO_WIDE_INVARIANT_GUARDS in scripts/affected-tests.mjs, appliesTo the
  // TS/JS family it scans), so CLAUDE.md's long-standing claim that it guards
  // retired-surface re-imports is finally TRUE rather than aspirational.
  // EI-19971915610840229. Shrink-only ✓ — an entry left, none arrived.

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

  // ── Seeded 2026-08-12 when the census was WIDENED to the `gen:*:check` family. ──
  // These 8 are not new debt. They are debt that was always there and structurally
  // invisible, because `selectGuardScripts` scanned `lint:*` only (see GEN_CHECK_RE).
  // Seeded at their MEASURED size for exactly the reason the 2026-08-03 block above
  // was: wiring 8 rotted guards in one commit is the fleet-reddening move this
  // script's own header warns against. The ratchet is what this buys immediately —
  // a NEWLY orphaned gen:*:check now fails the build on the commit that orphans it.
  [
    'gen:authored-docs:check',
    'drift gate for the 873-doc PG-canonical corpus (plan claude-md-projection-from-pg-2026-08-10). ' +
      'MEASURED CONSEQUENCE 2026-08-12: 4 projected docs were hand-edited and sat drifted ~20h with ' +
      'nothing reporting it. Needs PG, so GitHub CI cannot run it meaningfully (it exits 1 when the ' +
      'DB is unreachable rather than degrading like gen:doc-plans-index:check) — the wire-or-retire ' +
      'call is WHERE, not whether. Do not gate it on green-checkpoint without deciding whether doc ' +
      'drift should block code deploys for the whole fleet.',
  ],
  ['gen:claude-md-manifest:check', 'logic-test only; deepen to a real-tree assertion'],
  ['gen:compaction:check', 'pending wire-or-retire decision'],
  ['gen:doc-projections:check', 'pending wire-or-retire decision; sibling per-page gen:doc-*:check are CI-wired'],
  ['gen:fleet-lessons:check', 'pending wire-or-retire decision'],
  ['gen:knowledge-packs:check', 'pending wire-or-retire decision'],
  ['gen:openapi:check', 'pending wire-or-retire decision'],
  ['gen:tool-catalog:check', 'heavy full-registry import, fleet-fragile (same reason its doc sibling is CI-informational); pending decision'],
]);

/**
 * Ceiling on the acknowledged set. SHRINK-ONLY: wire or retire a guard instead of
 * appending. Raising it needs owner sign-off and a stated reason, exactly like
 * `DARK_FLAGS_HIGH_WATERMARK` — and for the same reason, since an allowlist that
 * grows freely reproduces the invisible rot this script exists to detect.
 *
 * ── 14 → 22 on 2026-08-12. STATED REASON: the POPULATION grew, not the debt. ──
 * [owner 2026-08-12] directed an audit of plan claude-md-projection-from-pg-2026-08-10
 * ("compare every plan item to the code... fix any gaps"), which found that this census
 * scanned `lint:*` only and had never seen the `gen:*:check` family at all. Widening it
 * (GEN_CHECK_RE) made 8 already-orphaned guards VISIBLE in one step; not one of them was
 * orphaned by this commit, and the `lint:*` portion of the set is UNCHANGED at 14.
 *
 * This is the one move that legitimately raises a shrink-only ceiling: measuring more of
 * the world. It is NOT a licence to append — every rule above still holds, the set is
 * still shrink-only from this new baseline, and a guard orphaned from here on fails the
 * build rather than landing here. Raising it again to park a newly-rotted guard would be
 * precisely the abuse the sibling `KNOWN_DARK_FLAGS` rule exists to stop.
 */
export const UNREACHABLE_HIGH_WATERMARK = 22;

/**
 * Guards that ARE enforced, but only over PART of what they scan (EI-19461064447747454).
 *
 * Seeded 2026-08-03 at its MEASURED size, for the same reason the unreachable set was:
 * both entries below were already partially covered before this axis existed, and the
 * remedy — registering a guard in `REPO_WIDE_INVARIANT_GUARDS` — makes it run on every
 * matching changed path, which is a real (if small) cost added to every affected-test
 * run. Failing outright on day one would red-pin the fleet on debt that accrued
 * invisibly, which is precisely the move this script's header warns against.
 *
 * ⚠ SHRINK-ONLY, like its sibling above. A NEW partially-covered guard fails the build
 * on the commit that creates it; paying one down means REGISTERING it, not appending here.
 */
export const ACKNOWLEDGED_PARTIAL_COVERAGE = new Map([
  [
    'lint:full-replacement-mocks',
    'scans every *.test.ts in the tree; enforced only when packages/operator-core is affected',
  ],
  [
    'lint:migration-fixture-drift',
    'scans every *.integration.test.ts in the tree; enforced only when apps/operator is affected',
  ],
]);

/** Ceiling on the partial-coverage set. SHRINK-ONLY — register a guard instead of appending. */
export const PARTIAL_COVERAGE_HIGH_WATERMARK = 2;

/**
 * Tiers that actually STOP a bad change. `hook` and `logic-test` are deliberately
 * excluded — see the header: both are real coverage of a kind, and neither blocks.
 *
 * `repo-wide` = registered in REPO_WIDE_INVARIANT_GUARDS (scripts/affected-tests.mjs) AND
 * declared by the workspace it names. That pair makes affected-tests.mjs push the guard as
 * a real task (`tasks.push({ ws, script: guard.script })`) whenever a changed path matches
 * its own `appliesTo` predicate — inside `test:affected`, which green-checkpoint runs as a
 * blocking leg. So it stops a bad change exactly like the other four.
 *
 * ⚠ WHY THIS TIER HAD TO EXIST (WI-37627, the ed2c4f36 gate red). `classifyGuard` read only
 * the gate/ci/test/hook/logic-test corpora, so a guard whose ONLY wiring was a registration
 * scored `tier: null` — reported verbatim as "nothing runs it at all" while it was in fact
 * running on every matching changed path. It went unnoticed because all 11 registered guards
 * that pre-dated it ALSO carried a corpus mention (a CI job, or a *.test.ts that names them),
 * so the blind spot needed a registration-ONLY guard to become visible;
 * `lint:no-ungated-mug-kettle` was the first, and it red-pinned `main` for the whole fleet.
 *
 * Note the script was already INTERNALLY INCONSISTENT about this: `computeCoverage` credits a
 * registered guard `verdict: 'full'` (line ~440), but that branch is unreachable for a
 * registration-only guard because the same function early-returns `not-enforced` whenever
 * `!row.blocking`. One axis called registration sufficient; the other had never heard of it.
 */
export const BLOCKING_TIERS = new Set(['gate', 'ci', 'test', 'chained', 'repo-wide']);

/**
 * A test EXECUTES a guard over the real tree (rather than unit-testing its helpers)
 * when it spawns the script or drives a scan rooted at the repository. Kept
 * deliberately generous: over-crediting a test yields a missed report, while
 * under-crediting sends someone to wire an already-enforced guard — and of those two
 * wrong answers, only the second wastes a fleet-wide gate run.
 *
 * `scanTree` was added 2026-08-04 (WI-10589) after the second wrong answer happened
 * exactly as this comment predicts. A guard test that imports the guard's OWN exported
 * tree-scanner and calls it with no arguments drives a scan rooted at the repository —
 * it just never shells out, so it matched none of the process-spawn markers and none of
 * the ROOT-name markers either. Measured on lint:no-hand-rolled-module-pin: its test
 * asserts scanTree().violations is empty REPO-WIDE, yet this regex scored the file 0 and
 * the leg reported the guard as running "over nothing", which would have red-pinned the
 * fleet minutes after an 8h26m gate freeze had just cleared.
 *
 * Note the direction of the bias this preserves: delegating the walk to the guard's own
 * export is the REUSE-THE-DETECTOR pattern this repo mandates everywhere (a re-derived
 * copy drifts), so the old regex penalised precisely the tests written correctly. Prefer
 * adding the scanner name a guard actually exports over inventing speculative ones.
 */
export const ENFORCING_TEST_RE = /execFileSync|spawnSync|execSync|listTrackedFiles|REPO_ROOT|repoRoot|process\.cwd\(\)|scanTree/;

/**
 * Companion INVOCATIONS of a guard rather than guards in their own right: a different
 * strictness or a write mode over the SAME implementation. Counting them separately
 * double-counts the debt — enforcement is a property of the implementation, not of how
 * many npm aliases point at it — so a base guard that IS wired makes its `:strict`
 * sibling enforced too, and a base guard that is not shows up once, not twice.
 */
const COMPANION_SUFFIX_RE = /:(fix|report|census|strict|all|fail|update|check|typecheck)$/;

/**
 * The OTHER guard family in this repo: `gen:<artifact>:check`, the drift check for a
 * GENERATED artifact. It asserts the committed file still matches what its generator
 * would produce — the same job a `lint:*` guard does, expressed in the generator's
 * namespace rather than the linter's.
 *
 * ── WHY THIS HAD TO BE ADDED (measured 2026-08-12, plan claude-md-projection-from-pg) ──
 * The census scanned `lint:*` ONLY, so this entire family was invisible to it — including
 * `gen:authored-docs:check`, the drift gate protecting the 873-doc PG-canonical corpus,
 * which `scripts/project-authored-docs.ts` calls "a GATE" in its own comments while
 * nothing invoked it. The consequence was exactly what this script's header predicts an
 * unwired guard produces: four projected docs were hand-edited and sat drifted for ~20h
 * with nothing reporting it, and the drift surfaced only because an agent ran the command
 * by hand. A meta-guard blind to half the guard namespace cannot detect that, and its
 * green gets quoted as evidence that every guard is wired.
 *
 * ⚠ COMPANION COLLAPSE MUST NOT APPLY HERE, and the reason is not cosmetic.
 * `COMPANION_SUFFIX_RE` includes `check`, so the ordinary rule would collapse
 * `gen:foo:check` onto `gen:foo` whenever the base is declared — which it always is.
 * But the two are NOT a guard and its variant: `gen:foo` WRITES the artifact (it is the
 * generator, and mutates the tree), while `gen:foo:check` is the only half that ASSERTS
 * anything. Collapsing would credit enforcement to a script that can never fail on drift
 * because its job is to overwrite it — silently emptying this family from the census
 * again, in the one direction the header calls the wasteful answer to get wrong. So the
 * `:check` variant is selected as a guard in its own right and its writer base is never
 * treated as covering it.
 */
const GEN_CHECK_RE = /^gen:.+:check$/;

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

/**
 * `lint:foo` guards, minus the companion invocations described above.
 *
 * A suffix match alone is NOT sufficient to collapse a name: `lint:foo:strict` is a
 * companion of `lint:foo`, but a guard that merely ENDS in one of those words with no
 * base guard behind it is a guard in its own right, and dropping it would hide it from
 * the census entirely — the exact invisibility this script exists to detect. So the
 * base guard must actually exist for the collapse to apply. (Measured 2026-08-03: no
 * such orphan exists today, so this is a safety property, not a behaviour change.)
 */
export function selectGuardScripts(scripts) {
  const all = Object.keys(scripts);
  const lintNames = all.filter((name) => name.startsWith('lint:'));
  const declared = new Set(lintNames);
  const lintGuards = lintNames.filter((name) => {
    const m = name.match(COMPANION_SUFFIX_RE);
    return !m || !declared.has(name.slice(0, -m[0].length));
  });
  return [...lintGuards, ...all.filter((name) => GEN_CHECK_RE.test(name))].sort();
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
export function classifyGuard({ name, command, corpora, repoWideRegistered = new Set() }) {
  const impls = resolveImplementationPaths(command);
  const tiers = [];
  const mentions = (text) => text.includes(name) || impls.some((p) => p && text.includes(p));
  for (const [tier, text] of Object.entries(corpora)) {
    if (mentions(text)) tiers.push(tier);
  }
  // Appended AFTER the corpora so `blocking[0]` keeps reporting the more specific tier for a
  // guard that is both registered and named by a CI job / gate leg / enforcing test — all 11
  // registrations that pre-dated this tier are in that state, so their reported tier is
  // unchanged and only a registration-ONLY guard newly reads `repo-wide`.
  //
  // Membership is an exact Set lookup, deliberately NOT the substring `mentions()` used above:
  // guard names nest (`lint:no-retired` is a prefix of `lint:no-retired-resurrection`, and both
  // are registered), so a text-corpus spelling of this would credit the shorter name off the
  // longer one's registration. The caller passes the EFFECTIVE set — registrations whose named
  // workspace actually declares the script — so an INERT registration confers nothing here
  // either, and still falls through to be reported as the unwired guard it really is.
  if (repoWideRegistered.has(name)) tiers.push('repo-wide');
  const blocking = tiers.filter((t) => BLOCKING_TIERS.has(t));
  return {
    name,
    impls,
    tiers,
    tier: blocking[0] ?? tiers[0] ?? null,
    blocking: blocking.length > 0,
  };
}

/* ── COVERAGE: the THIRD axis (EI-19461064447747454) ─────────────────────────
 *
 * `classifyGuard` above answers "does a blocking path run this guard?" — a per-GUARD
 * boolean. It does NOT answer "would a violation ANYWHERE be seen?", and those come
 * apart for exactly one tier.
 *
 * `gate` and `ci` legs run UNCONDITIONALLY, so their scope is the whole tree. But the
 * `test` tier is enforced by a *.test.ts, and the gate runs tests via `test:affected`,
 * which selects suites BY WORKSPACE. So a `test`-tier guard runs only when its own
 * test file's workspace is independently affected — while the guard itself may scan
 * far wider. A violation introduced outside that workspace gets NO local signal and
 * first surfaces as a red FLEET gate hours later.
 *
 * MEASURED (WI-9434): `lint:partial-index-alignment` scans 4 roots but its ratchet is
 * a vitest file in `@papercusp/operator-core`, so `--changed-paths
 * apps/operator/lib/release/green-checkpoint.ts --print-affected` → `@papercusp/web`
 * only. 3 of its 4 scanned roots escaped. The census called it ENFORCED, truthfully,
 * and that read as "this guard is doing its job".
 *
 * The remedy already exists and is what makes this modellable rather than advisory:
 * `REPO_WIDE_INVARIANT_GUARDS` in `scripts/affected-tests.mjs` registers a guard to
 * run whenever any changed path matches its own predicate, independent of workspace
 * selection. A registered guard is therefore FULLY covered.
 *
 * ⚠ WHY MOST GUARDS REPORT `undetermined` RATHER THAN A NUMBER. Only two scan shapes
 * are comparable to workspace-scoped enforcement: a bounded root array, and a
 * repo-wide file enumeration. The others are not merely harder — a roots model is the
 * WRONG model for them, and forcing one would manufacture false precision:
 *   • `lint:cell-matrix` queries a LIVE DATABASE over a port; it has no file scope.
 *   • `lint:required-field-strands` is DIFF-driven (`--files=` / `--base`).
 *   • `lint:boundary-check` walks an import graph from an ENTRY POINT.
 * `undetermined` is a real answer here: it says the census has not measured coverage,
 * which is precisely the claim it was previously making silently and wrongly.
 */

/** Workspace directory owning a repo-relative path (longest prefix wins), or null. */
export function workspaceOfPath(file, workspaceDirs) {
  let best = null;
  for (const dir of workspaceDirs) {
    if (file === dir || file.startsWith(`${dir}/`)) {
      if (!best || dir.length > best.length) best = dir;
    }
  }
  return best;
}

/**
 * What a guard's implementation ENUMERATES. Derived by scanning the implementation, never
 * hand-declared — the same anti-drift property the tier classification relies on.
 *
 * Order is significant: a guard that declares bounded roots AND calls `ls-files` uses the
 * roots to FILTER that enumeration, so `bounded` is the truthful answer, not `repo-wide`.
 */
export function deriveScanScope(source) {
  const text = String(source);
  const rootsMatch = text.match(/(?:export\s+)?const\s+\w*(?:SCAN|SOURCE)_ROOTS\s*=\s*\[([\s\S]*?)\]/);
  if (rootsMatch) {
    const roots = [...rootsMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    if (roots.length) return { kind: 'bounded', roots };
  }
  // `listTrackedFiles(...)`, or a `git ls-files` spawn — the argv form means the literal
  // is `'ls-files'`, NOT the string `git ls-files`. Matching the latter is why an earlier
  // measurement pass reported two repo-wide guards as having no detectable scan at all.
  if (/listTrackedFiles\s*\(|['"]ls-files['"]/.test(text)) return { kind: 'repo-wide', roots: null };
  if (/--files=|--changed-paths|--base\b/.test(text)) return { kind: 'diff-driven', roots: null };
  return { kind: 'undetermined', roots: null };
}

/**
 * Coverage verdict for one classified row.
 *
 * Returns `{ verdict, reason, roots?, coveredRoots? }` where verdict is one of
 * `full` | `partial` | `undetermined` | `not-enforced`.
 */
export function computeCoverage({
  row,
  enforcingTestPaths = [],
  workspaceDirs = [],
  implSource = '',
  repoWideRegistered = new Set(),
}) {
  if (!row.blocking) return { verdict: 'not-enforced', reason: 'no blocking path runs it' };
  if (row.tier === 'gate' || row.tier === 'ci') {
    return { verdict: 'full', reason: `${row.tier} legs run unconditionally, not by affected-workspace selection` };
  }
  // `chained` inherits its runner's reachability, and that runner's own coverage is not
  // resolved here. Claiming `full` for it would re-create this very bug one hop down, so
  // it is reported as unmeasured rather than assumed good.
  if (row.tier === 'chained') {
    return { verdict: 'undetermined', reason: "inherits an unmeasured runner's coverage" };
  }
  if (repoWideRegistered.has(row.name)) {
    return { verdict: 'full', reason: 'registered in REPO_WIDE_INVARIANT_GUARDS — runs on its own predicate' };
  }

  const enforcementWorkspaces = [
    ...new Set(enforcingTestPaths.map((p) => workspaceOfPath(p, workspaceDirs)).filter(Boolean)),
  ];
  if (!enforcementWorkspaces.length) {
    return { verdict: 'undetermined', reason: 'could not resolve the workspace of its enforcing test' };
  }

  const scope = deriveScanScope(implSource);
  if (scope.kind === 'bounded') {
    const covered = scope.roots.filter((r) => {
      const ws = workspaceOfPath(r, workspaceDirs);
      return ws && enforcementWorkspaces.includes(ws);
    });
    if (covered.length === scope.roots.length) {
      return { verdict: 'full', reason: 'every scanned root lies inside its enforcing workspace', roots: scope.roots };
    }
    return {
      verdict: 'partial',
      reason: `scans ${scope.roots.length} roots; only ${covered.length} lie inside ${enforcementWorkspaces.join(', ')}`,
      roots: scope.roots,
      coveredRoots: covered,
    };
  }
  if (scope.kind === 'repo-wide') {
    return {
      verdict: 'partial',
      reason: `enumerates the WHOLE tree but only runs when ${enforcementWorkspaces.join(', ')} is affected`,
    };
  }
  return {
    verdict: 'undetermined',
    reason: `${scope.kind} scan is not comparable to workspace-scoped enforcement; coverage NOT measured`,
  };
}

/**
 * The whole census. `corpora` maps tier → concatenated source text of every runner in
 * that tier. Pure so it is unit-testable without a repo.
 *
 * `coverage` is OPTIONAL: omit it and no coverage is computed (rows simply carry no
 * `coverage` field). Supplying it adds the third axis described above.
 */
export function buildReachabilityCensus({
  scripts,
  corpora,
  acknowledged = new Map(),
  coverage = null,
  // Defaults to the coverage axis's own set so an existing caller that passes registrations
  // only under `coverage` keeps the same behaviour on BOTH axes. Accepted at the top level
  // too because enforcement is measurable without the coverage inputs, and conflating them
  // is what let the two axes disagree about registration in the first place (see BLOCKING_TIERS).
  repoWideRegistered = coverage?.repoWideRegistered ?? new Set(),
} = {}) {
  const rows = selectGuardScripts(scripts).map((name) =>
    classifyGuard({ name, command: scripts[name], corpora, repoWideRegistered }),
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
  // Coverage is computed AFTER the chained-inheritance pass above, so every row's tier
  // is final. Rows carry no `coverage` field at all when the caller supplies no coverage
  // input — an absent field is honestly "not measured", never a silent `full`.
  if (coverage) {
    const {
      enforcingTests = [],
      workspaceDirs = [],
      implSources = new Map(),
      repoWideRegistered = new Set(),
    } = coverage;
    for (const row of rows) {
      const enforcingTestPaths = enforcingTests
        .filter((t) => t.text.includes(row.name) || row.impls.some((p) => p && t.text.includes(p)))
        .map((t) => t.path);
      row.coverage = computeCoverage({
        row,
        enforcingTestPaths,
        workspaceDirs,
        implSource: row.impls.map((p) => implSources.get(p) ?? '').join('\n'),
        repoWideRegistered,
      });
    }
  }

  const notEnforced = rows.filter((r) => !r.blocking);
  const unreachable = notEnforced.filter((r) => r.tier === null);
  const advisoryOnly = notEnforced.filter((r) => r.tier !== null);
  const unacknowledged = notEnforced.filter((r) => !acknowledged.has(r.name));
  // Enforced, but only over PART of what it scans — the defect this axis exists to name.
  const partiallyCovered = rows.filter((r) => r.coverage?.verdict === 'partial');
  const coverageUnmeasured = rows.filter((r) => r.coverage?.verdict === 'undetermined');
  // An allowlist entry for a guard that no longer exists keeps asserting a decision
  // about nothing — the same staleness `findStaleDeclarations` catches for tiers.
  const declaredNames = new Set(rows.map((r) => r.name));
  const staleAcknowledgements = [...acknowledged.keys()].filter((n) => !declaredNames.has(n));

  return {
    rows,
    notEnforced,
    unreachable,
    advisoryOnly,
    unacknowledged,
    staleAcknowledgements,
    partiallyCovered,
    coverageUnmeasured,
  };
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
  //
  // Per-file identity is RETAINED for the enforcing pile (it used to be concatenated away).
  // Coverage needs to know WHICH test file enforces a guard, because that file's workspace
  // is exactly what `test:affected` selects on — see the COVERAGE section above.
  const testTexts = files
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
    .map((f) => ({ path: f, text: stripComments(readIfExists(resolve(ROOT, f))) }));
  const enforcingTests = testTexts.filter((t) => ENFORCING_TEST_RE.test(t.text));
  const test = enforcingTests.map((t) => t.text).join('\n');
  const logicTest = testTexts.filter((t) => !ENFORCING_TEST_RE.test(t.text)).map((t) => t.text).join('\n');

  const hook = [
    ...files.filter((f) => f.includes('/hooks/') && !f.endsWith('.test.ts')),
    '.claude/settings.json',
  ]
    .map((f) => stripComments(stripComments(readIfExists(resolve(ROOT, f))), { yaml: true }))
    .join('\n');

  // Key order matters: `classifyGuard` reports the first matching tier for a guard
  // with no blocking tier, so the advisory tiers come last.
  return { corpora: { gate, ci, test, hook, 'logic-test': logicTest }, enforcingTests, files };
}

/**
 * Guards registered in `REPO_WIDE_INVARIANT_GUARDS` (scripts/affected-tests.mjs) — the
 * existing mechanism that runs a guard on its OWN predicate instead of by affected
 * workspace. Parsed rather than duplicated, so this cannot drift from the real list.
 *
 * The block is bounded to the array literal: `script:` also appears elsewhere in that
 * file, and reading the whole file would silently over-credit unrelated guards.
 */
export function parseRepoWideRegistrations(affectedTestsSource) {
  const text = String(affectedTestsSource);
  const start = text.indexOf('const REPO_WIDE_INVARIANT_GUARDS');
  if (start < 0) return new Set();
  const block = text.slice(start);
  const end = block.indexOf('\n];');
  return new Set(
    [...block.slice(0, end < 0 ? undefined : end).matchAll(/script:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
}

/**
 * The same registrations as `parseRepoWideRegistrations`, but keeping the `workspace` each
 * one names instead of discarding it — which is what makes the INERT check below possible.
 *
 * Line comments are stripped first: the entries in that registry are heavily commented, and
 * a prose mention of a script name would otherwise be parsed as a registration.
 */
export function parseRepoWideRegistrationPairs(affectedTestsSource) {
  const text = String(affectedTestsSource);
  const start = text.indexOf('const REPO_WIDE_INVARIANT_GUARDS');
  if (start < 0) return [];
  const block = text.slice(start);
  const end = block.indexOf('\n];');
  const body = block.slice(0, end < 0 ? undefined : end).replace(/^\s*\/\/.*$/gm, '');
  const pairs = [];
  for (const chunk of body.split(/\n\s{2}\{/)) {
    const ws = /workspace:\s*['"]([^'"]+)['"]/.exec(chunk);
    const sc = /script:\s*['"]([^'"]+)['"]/.exec(chunk);
    if (ws && sc) pairs.push({ workspace: ws[1], script: sc[1] });
  }
  return pairs;
}

/**
 * Registrations that CANNOT run: the named workspace does not declare the named script.
 *
 * WHY THIS AXIS EXISTS (measured 2026-08-09, WI-37454). `affected-tests.mjs` skips a
 * registered guard whose owning workspace does not declare the script:
 *
 *     if (!ws?.scripts?.[guard.script]) continue;        // affected-tests.mjs:815
 *
 * — silently, by design, because that `continue` also absorbs a workspace that is simply
 * absent. Meanwhile `coverageOf` credited `verdict: 'full'` for anything merely PRESENT in
 * the registry. Those two facts compose into the exact rot this whole script exists to
 * catch, with the reporting surface pointing the wrong way: `lint:drop-database-force` was
 * registered (WI-4311, for the ~88-parked-backends bug) but never declared by
 * `@papercusp/operator-core`, so it ran NOWHERE while being scored fully enforced.
 *
 * A registration is a CLAIM about where a guard runs; declaring the script is what makes it
 * true. Crediting the claim without checking the fact is how a guard's own coverage report
 * becomes the thing that hides its absence.
 *
 * `scriptsByWorkspaceName` maps workspace package name → Set of declared script names. A
 * workspace MISSING from that map is treated as declared (fail OPEN, like the rest of this
 * file): an unreadable package.json must not red-pin the fleet gate on a file it could not
 * read, and this axis is only meaningful when the map was built successfully.
 */
export function findInertRepoWideRegistrations({ pairs = [], scriptsByWorkspaceName = new Map() } = {}) {
  const inert = [];
  for (const pair of pairs) {
    const declared = scriptsByWorkspaceName.get(pair.workspace);
    if (!declared) continue; // fail open — see docstring
    if (!declared.has(pair.script)) inert.push(pair);
  }
  return inert;
}

/** Workspace directories, expanded from package.json `workspaces` globs against the tree. */
function discoverWorkspaceDirs(pkg, files) {
  const dirs = new Set();
  for (const pattern of pkg.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      dirs.add(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    for (const f of files) {
      if (!f.startsWith(`${base}/`)) continue;
      const seg = f.slice(base.length + 1).split('/')[0];
      if (seg) dirs.add(`${base}/${seg}`);
    }
  }
  return [...dirs];
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
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const scripts = pkg.scripts ?? {};
  const { corpora, enforcingTests, files } = buildCorpora();

  // Implementation sources for the coverage scan. Only guards the census actually has a
  // row for are read, so this adds a handful of file reads, not a second tree walk.
  const implSources = new Map();
  for (const name of selectGuardScripts(scripts)) {
    for (const p of resolveImplementationPaths(scripts[name])) {
      if (!implSources.has(p)) implSources.set(p, readIfExists(resolve(ROOT, p)));
    }
  }

  // ⚠ FAIL OPEN. The coverage axis credits a guard as fully covered when it is registered
  // in REPO_WIDE_INVARIANT_GUARDS — so if that source is unreadable, EVERY registered guard
  // would silently reclassify as `partial` and this leg (a blocking green-checkpoint leg)
  // would red-pin the whole fleet on a missing file rather than on a real defect.
  //
  // The rest of this script already errs toward "reachable" for exactly this reason: a false
  // negative costs a missed report, a false positive costs a fleet-wide gate run. Coverage
  // inherits that stance — no registration source means the axis is not measured at all.
  // Overridable for the same reason the package.json subject is: the fail-open branch
  // below can then be PROVEN against a copy outside the tree, instead of by deleting a
  // load-bearing file from a shared checkout that git-sync sweeps every few minutes.
  const affectedTestsSource = readIfExists(
    process.env.LINT_GUARD_REACHABILITY_AFFECTED_TESTS || resolve(ROOT, 'scripts/affected-tests.mjs'),
  );
  const coverageMeasurable = affectedTestsSource.includes('REPO_WIDE_INVARIANT_GUARDS');
  if (!coverageMeasurable) {
    console.warn(
      '⚠ coverage axis SKIPPED: scripts/affected-tests.mjs has no REPO_WIDE_INVARIANT_GUARDS block.\n' +
        '  Reporting enforcement only. (Failing here would red-pin the gate on a missing file.)',
    );
  }

  const workspaceDirs = discoverWorkspaceDirs(JSON.parse(readIfExists(resolve(ROOT, 'package.json')) || '{}'), files);

  // package name -> declared script names, for the INERT-registration axis. A workspace whose
  // package.json is unreadable/unparseable is simply OMITTED, which findInertRepoWideRegistrations
  // treats as declared (fail open) rather than as a violation it cannot substantiate.
  const scriptsByWorkspaceName = new Map();
  for (const dir of workspaceDirs) {
    try {
      const wsPkg = JSON.parse(readIfExists(resolve(ROOT, dir, 'package.json')) || '{}');
      if (wsPkg.name) scriptsByWorkspaceName.set(wsPkg.name, new Set(Object.keys(wsPkg.scripts ?? {})));
    } catch {
      // omitted => fail open for this workspace
    }
  }
  const repoWidePairs = coverageMeasurable ? parseRepoWideRegistrationPairs(affectedTestsSource) : [];
  const inertRegistrations = findInertRepoWideRegistrations({ pairs: repoWidePairs, scriptsByWorkspaceName });
  const inertScripts = new Set(inertRegistrations.map((p) => p.script));

  // EFFECTIVE registrations — registered AND declared by the workspace named. Computed once
  // and used by BOTH axes: enforcement (a `repo-wide` blocking tier) and coverage (`full`).
  // They used to be derived separately, which is how they came to disagree.
  const effectiveRepoWideRegistered = new Set(
    [...parseRepoWideRegistrations(coverageMeasurable ? affectedTestsSource : '')].filter(
      (s) => !inertScripts.has(s),
    ),
  );

  const census = buildReachabilityCensus({
    scripts,
    corpora,
    acknowledged: ACKNOWLEDGED_UNREACHABLE,
    repoWideRegistered: effectiveRepoWideRegistered,
    coverage: coverageMeasurable
      ? {
          enforcingTests,
          workspaceDirs,
          implSources,
          // EFFECTIVE registrations only — an INERT one (workspace does not declare the
          // script) is deliberately NOT credited, so it falls through to the ordinary
          // coverage analysis and is reported as the partial/unenforced guard it really is.
          repoWideRegistered: effectiveRepoWideRegistered,
        }
      : null,
  });

  if (json) {
    console.log(JSON.stringify(census, null, 2));
    if (censusOnly) {
      // NOT process.exit(): this census is the machine-readable output people pipe to
      // jq, and exit() does not drain an async pipe write — a truncated census reads as
      // FEWER unreachable guards. See scripts/check-undrained-stdout-exit.mjs.
      process.exitCode = 0;
      return;
    }
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
    if (!json && census.partiallyCovered.length) {
      console.log(`\nENFORCED BUT PARTIALLY COVERED (${census.partiallyCovered.length}) — a red would be seen, but not from everywhere:`);
      for (const r of census.partiallyCovered) {
        console.log(`  ${r.name}  —  ${r.coverage.reason}`);
      }
    }
    if (!json && census.coverageUnmeasured.length) {
      console.log(`\nCOVERAGE NOT MEASURED (${census.coverageUnmeasured.length}) — enforced; scan shape not comparable:`);
      for (const r of census.coverageUnmeasured) {
        console.log(`  ${r.name}  —  ${r.coverage.reason}`);
      }
    }
    process.exit(0);
  }

  let failed = false;

  // INERT registrations — see findInertRepoWideRegistrations. Reported FIRST because a guard
  // in this state is the most misleading of all the states this script distinguishes: it
  // looks deliberately wired (someone registered it, with a comment explaining why) and it
  // runs nowhere. There is no watermark/allowlist for it on purpose — unlike partial
  // coverage, this is never a considered trade-off, only ever a two-line mismatch.
  if (inertRegistrations.length) {
    failed = true;
    console.error(
      `\n❌ ${inertRegistrations.length} REPO_WIDE_INVARIANT_GUARDS registration(s) are INERT — the workspace does not declare the script:`,
    );
    for (const p of inertRegistrations) console.error(`     ${p.script}  →  ${p.workspace} declares no such script`);
    console.error('   affected-tests.mjs:815 skips these SILENTLY, so the guard runs on no path at all.');
    console.error('   Fix by declaring it in that workspace\'s package.json, e.g.:');
    console.error('     "<script>": "node ../../scripts/<its-checker>.mjs"');
  }

  if (census.staleAcknowledgements.length) {
    failed = true;
    console.error(`\n❌ ${census.staleAcknowledgements.length} STALE allowlist entr(ies) — the guard no longer exists:`);
    for (const n of census.staleAcknowledgements) console.error(`     ${n}`);
    console.error('   Remove them: they assert a pending decision about a script that is gone.');
  }

  // Gated on the registry having actually been READ, for the same reason as the two
  // partial-coverage checks below and with the same fail-OPEN stance as the skip notice above.
  // A registration is now one of the ways a guard is blocking, so with the registry unreadable
  // this axis cannot tell "nothing runs it" from "the thing that runs it is the file I could
  // not open" — and of those two wrong answers only the false POSITIVE red-pins the fleet on a
  // missing file rather than a real defect. Reported as a loud warning so an unmeasured run is
  // never mistaken for a clean one.
  const unacknowledgedUnenforced = coverageMeasurable ? census.unacknowledged : [];
  if (!coverageMeasurable && census.unacknowledged.length) {
    console.warn(
      `\n⚠ enforcement axis DEGRADED: ${census.unacknowledged.length} guard(s) look unenforced, but the\n` +
        '  registration source was unreadable, so a `repo-wide` registration could not be seen.\n' +
        '  NOT failing on them — this run cannot substantiate the finding.',
    );
  }
  if (unacknowledgedUnenforced.length) {
    failed = true;
    console.error(`\n❌ ${unacknowledgedUnenforced.length} lint guard(s) run on NO blocking path:`);
    for (const r of unacknowledgedUnenforced) {
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

  // Both partial-coverage checks are gated on the axis having actually been MEASURED.
  // Without this, an unmeasured run reports every acknowledged entry as "stale" (its
  // guard is absent from an empty partiallyCovered list) and fails the gate — the same
  // fail-closed trap the skip above exists to avoid, one step further down.
  const unacknowledgedPartial = coverageMeasurable
    ? census.partiallyCovered.filter((r) => !ACKNOWLEDGED_PARTIAL_COVERAGE.has(r.name))
    : [];
  if (unacknowledgedPartial.length) {
    failed = true;
    console.error(`\n❌ ${unacknowledgedPartial.length} lint guard(s) are enforced over only PART of what they scan:`);
    for (const r of unacknowledgedPartial) {
      console.error(`     ${r.name}  →  ${r.coverage.reason}`);
    }
    console.error('');
    console.error('   `test:affected` selects suites BY WORKSPACE, so a guard enforced only by a');
    console.error('   *.test.ts runs only when THAT test\'s workspace is independently affected — while');
    console.error('   the guard scans wider. A violation outside that workspace gets no local signal and');
    console.error('   first surfaces as a red FLEET gate. Fix it by registering the guard in');
    console.error('   REPO_WIDE_INVARIANT_GUARDS (scripts/affected-tests.mjs) with an `appliesTo`');
    console.error('   predicate, so it runs on every changed path it actually covers.');
  }

  const stalePartial = coverageMeasurable
    ? [...ACKNOWLEDGED_PARTIAL_COVERAGE.keys()].filter((n) => !census.partiallyCovered.some((r) => r.name === n))
    : [];
  if (stalePartial.length) {
    failed = true;
    console.error(`\n❌ ${stalePartial.length} STALE partial-coverage entr(ies) — no longer partially covered:`);
    for (const n of stalePartial) console.error(`     ${n}`);
    console.error('   Remove them; the ratchet only counts if a paid-down entry leaves the set.');
  }

  if (ACKNOWLEDGED_PARTIAL_COVERAGE.size > PARTIAL_COVERAGE_HIGH_WATERMARK) {
    failed = true;
    console.error(
      `\n❌ acknowledged-partial-coverage set exceeds its watermark: ${ACKNOWLEDGED_PARTIAL_COVERAGE.size} > ${PARTIAL_COVERAGE_HIGH_WATERMARK}.`,
    );
    console.error('   This set is SHRINK-ONLY. Register the guard repo-wide instead of appending here.');
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
  // The KNOWN LIMITATION at the top of this file has to travel WITH the number, not sit in a
  // source comment the reader of the number never opens. "68/82 enforced" invites exactly one
  // wrong conclusion — "the tree is protected" — and that conclusion has already been drawn
  // and already cost an outage: on 2026-08-03 a parse-breaking edit crash-looped :3170 for
  // 17min while every guard that could have caught it was, by THIS measure, fully enforced.
  // The coverage axis has to appear on the SAME line as the enforced count, not below it.
  // "68/82 enforced" was read as "the tree is protected" while a guard covering 1 of its 4
  // scanned roots sat inside that numerator (EI-19461064447747454) — a per-GUARD boolean
  // rendered as if it were a per-SCOPE one. Any reader of the number sees the qualifier now.
  if (census.partiallyCovered.length || census.coverageUnmeasured.length) {
    console.log(
      `  ⚠ of those ${enforced}: ${census.partiallyCovered.length} enforced over only PART of what they scan, ` +
        `${census.coverageUnmeasured.length} with coverage NOT measured.\n` +
        '    ENFORCED is a per-GUARD boolean, never a per-SCOPE one — `--census` breaks it down.',
    );
  }
  console.log(
    '  ⚠ ENFORCED = a blocking path RUNS it, never that it runs BEFORE the damage. Hosts that\n' +
      '    bundle the WORKING TREE (:3170, bg-host) are past every commit-time guard by construction.',
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
