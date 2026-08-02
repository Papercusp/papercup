#!/usr/bin/env node
/**
 * Shared PER-FILE tsc baseline gate (extracted from scripts/lint-tsc.mjs, EI-847).
 *
 * `scripts/lint-tsc.mjs` pioneered this for operator-core (P-010/WI-4535 — see that file's
 * header for the full "why per-file, not a global count" rationale + the two hard rules
 * that carry to EVERY consumer of this module:
 *
 *   1. RATCHET-ONLY-DOWN, on an EXPLICIT `--update` only.
 *   2. SYNTAX HARD-FAIL: any TS1xxx parse error fails regardless of the counts.
 *
 * This module is the reusable core so a SECOND project (or a third, a fourth, …) gets the
 * same baseline-gated, `--mine`-scoped, ratchet-only-down typecheck WITHOUT forking the
 * policy logic — only `tscCommand` / `baselineFile` / `label` differ per project. See
 * `scripts/lint-tsc.mjs` (operator-core) and `scripts/lint-tsc-operator-vite.mjs`
 * (operator-vite) for the two thin per-project CLIs built on this.
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One diagnostic parsed out of tsc's output.
 *
 * @typedef {object} TscErrorEntry
 * @property {string | null} file - null when the diagnostic carries no file (unattributable).
 * @property {string} code - The `TSnnnn` code.
 */

/**
 * One file's standing against its baseline.
 *
 * @typedef {object} PerFileGateEntry
 * @property {string} file
 * @property {number} baseline
 * @property {number} current
 * @property {number} delta - `current - baseline`; positive is a regression.
 * @property {boolean} [dirty] - Set only on `newFiles`, and only when the dirty set could be read:
 *   the file is uncommitted in the shared working tree, i.e. a peer is very likely mid-edit
 *   (EI-19278299775574199). `undefined` means UNKNOWN, never "clean" — see
 *   `partitionNewFilesByLiveEdit`.
 */

/**
 * A baseline owned by ANOTHER package, whose recorded counts this gate inherits for
 * files under `prefix` rather than assuming an implicit 0 (EI-18649014117371738).
 *
 * @typedef {object} ForeignBaselineSource
 * @property {string} prefix - Repo-relative path prefix of the files the other package owns.
 * @property {Record<string, number>} files - That package's own per-file baseline map.
 * @property {string} [label]
 */

/**
 * The verdict vocabulary. `fail-new-file` is split out of `peerDrift` so `--mine` can
 * never greenwash a brand-new file: absence from the git-status changed set does not
 * prove a new file isn't yours, because git-sync auto-commits this shared tree every few
 * minutes (EI-18766822535373909).
 *
 * @typedef {'fail-syntax' | 'fail-regressed' | 'fail-attributed' | 'fail-new-file' | 'ok-peer-drift' | 'ok-ratchet' | 'ok-below' | 'ok'} PerFileGateVerdict
 */

/**
 * A cross-package baseline named by PATH, for `runTscBaselineGate`'s options. Distinct
 * from `ForeignBaselineSource`, which carries the already-LOADED `files` map — this is
 * what a CLI passes in before the gate reads it off disk.
 *
 * @typedef {object} ForeignBaselineRef
 * @property {string} prefix - Repo-relative path prefix the owning package covers.
 * @property {string} baselineFile - Absolute path to that package's `.tsc-baseline.json`.
 * @property {string} [label]
 */

/**
 * Options for the shared CLI entry point.
 *
 * ⚠ Written as a `@typedef` with `@property` tags, NOT as an inline `@param {{ … }}`
 * object type. TypeScript's JSDoc TYPE parser does not accept `//` comments inside a type
 * expression: this options bag was previously documented inline with a `//` gloss per
 * field, and everything from the first comment-only continuation line onward — including
 * `foreignBaselines` — was silently dropped from the emitted type while still reading as
 * fully documented. `@property` descriptions are prose by design, so the annotation and
 * the explanation can coexist without one eating the other.
 *
 * @typedef {object} RunTscBaselineGateOptions
 * @property {string} root - cwd the tscCommand runs from (repo root).
 * @property {string} tscCommand - e.g. 'npx tsc -p apps/foo/tsconfig.json --noEmit --incremental false'.
 * @property {string} baselineFile - Absolute path to this project's `.tsc-baseline.json`.
 * @property {string} label - Human label for console output, e.g. 'operator-core'.
 * @property {string[]} argv - `process.argv.slice(2)`.
 * @property {string} [countField] - Baseline JSON field the derived total is written to on
 *   `--update` (default 'errorCount'; operator-core keeps its legacy 'operatorCoreErrorCount'
 *   name for back-compat with existing tooling).
 * @property {ForeignBaselineRef[]} [foreignBaselines] - Cross-package files this gate
 *   MEASURES but does not OWN: a file under `prefix` that is absent from this gate's
 *   baseline inherits the owning package's recorded count instead of an implicit 0. See
 *   `effectiveBaselineByFile` (EI-18649014117371738).
 */

/**
 * The full decision for one run.
 *
 * @typedef {object} PerFileGateResult
 * @property {PerFileGateVerdict} verdict
 * @property {PerFileGateEntry[]} regressions
 * @property {PerFileGateEntry[]} improvements
 * @property {PerFileGateEntry[]} [attributed]
 * @property {PerFileGateEntry[]} [typeAttributed] - Subset of `attributed` NOT in the caller's
 *   changed-file set, attributed instead because the file references an exported type/interface
 *   one of the changed files also exports (EI-18756182128903253's cause-aware widening).
 * @property {PerFileGateEntry[]} [peerDrift]
 * @property {PerFileGateEntry[]} [newFiles] - Regressions in files ABSENT from the baseline.
 * @property {number} total
 * @property {number} baselineTotal
 * @property {Record<string, number>} [newBaselineByFile]
 * @property {string[]} [brokenFiles]
 * @property {string[]} [unattributedBrokenFiles] - TS1xxx-broken files OUTSIDE the caller's
 *   `changedFiles` set (EI-19321179234197157). Never gates the verdict — reported so the caller
 *   knows tsc's counts for other files may be under/over-reported while these stay broken — but a
 *   parse error in a file the caller did not name must not fail a `--mine`/`--files`-scoped run,
 *   mirroring how an unattributed TYPE-error regression is `peerDrift`, not a gate failure.
 */

/**
 * `path/to/file.ts(12,5): error TS2322:` — a diagnostic tsc pinned to a location.
 *
 * Shared by `parseTscErrors` (which counts) and `diagnosticLinesForFiles` (which quotes) so the
 * two can never disagree about what counts as an attributed error: a file that shows `+1` in the
 * summary must be able to produce the line behind it.
 */
const LOCATED_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

/**
 * Parse tsc output into { file, code } entries (file null when unattributable).
 *
 * @param {string} tscOutput
 * @returns {TscErrorEntry[]}
 */
export function parseTscErrors(tscOutput) {
  const errors = [];
  for (const line of String(tscOutput).split('\n')) {
    const m = line.match(LOCATED_DIAGNOSTIC);
    if (m) {
      errors.push({ file: m[1], code: m[4] });
      continue;
    }
    const bare = line.match(/error (TS\d+):/);
    if (bare) errors.push({ file: null, code: bare[1] });
  }
  return errors;
}

/**
 * Files carrying parse-level (TS1xxx) errors — they fail to compile at all.
 *
 * @param {TscErrorEntry[]} errors
 * @returns {string[]}
 */
export function syntaxBrokenFiles(errors) {
  /** @type {Set<string>} */
  const files = new Set();
  for (const e of errors) {
    if (/^TS1\d{3}$/.test(e.code)) files.add(e.file ?? '(unattributed)');
  }
  return [...files].sort();
}

/**
 * Aggregate parsed errors into a { file: count } map. Unattributable errors bucket under '(unattributed)'.
 *
 * @param {TscErrorEntry[]} errors
 * @returns {Record<string, number>}
 */
export function countByFile(errors) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const e of errors) {
    const key = e.file ?? '(unattributed)';
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

/**
 * @param {Record<string, number>} map
 * @returns {number}
 */
export function sumValues(map) {
  let total = 0;
  for (const v of Object.values(map)) total += v;
  return total;
}

/**
 * The set of repo-relative paths the caller has changed (staged, unstaged, or untracked), for
 * `--mine` scoping. Fail-SOFT: a git failure (packaged install, detached state) returns an empty
 * set, which under `--mine` means "attribute nothing to me" — never a crash, never a false pass on
 * a real CI gate (CI runs bare, without `--mine`).
 *
 * @param {string} [root] - Repo root to run git in.
 * @returns {Set<string>}
 */
export function gitChangedFiles(root) {
  try {
    const out = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const files = new Set();
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      // "XY <path>" or "XY <old> -> <new>" for renames — take the destination path.
      const rest = line.slice(3).trim();
      const path = rest.includes(' -> ') ? rest.split(' -> ').pop().trim() : rest;
      if (path) files.add(path.replace(/^"|"$/g, ''));
    }
    return files;
  } catch {
    return new Set();
  }
}

/**
 * EI-18731016038876755 — parse an EXPLICIT `--files=a.ts,b.ts` CLI flag naming exactly the
 * files the caller changed THIS session, as an alternative to `--mine`'s implicit
 * git-status-derived scoping.
 *
 * WHY: `gitChangedFiles` (above) attributes "mine" from working-tree dirt (`git status`), which
 * on this concurrently-edited shared checkout includes every PEER's uncommitted edits too — not
 * just the caller's own. Observed live: `--mine` reported a regression in a file the calling
 * agent had never opened, because a peer had it mid-edit at that exact moment; re-running the
 * gate a minute later (once the peer's edit settled) gave the opposite verdict on the identical
 * command against the identical tree. `git status` cannot distinguish WHICH agent dirtied a
 * file on a shared checkout — there is no session-scoped signal to read there.
 *
 * `--files=` sidesteps the ambiguity entirely: the caller states which files are theirs
 * (e.g. from their own edit history / Edit-tool log this turn), and that explicit set is used
 * VERBATIM instead of the git-status guess — no heuristic, no false attribution. Passing
 * `--files=` also implies `--mine`-style scoping (a caller naming exact files obviously wants
 * the check scoped to them), so `--mine` need not be passed alongside it.
 *
 * Returns `null` when the flag is absent (falls through to the existing `--mine`/bare behavior
 * unchanged) — never an empty Set for "flag absent", so callers can tell "not scoped" apart from
 * "scoped to zero files" (a malformed `--files=` with no content, which is now the caller's own
 * bug to fix, not a silent no-op).
 *
 * @param {string[]} argv
 * @returns {Set<string> | null} null when the flag is absent; an EMPTY set means "scoped to zero files".
 */
export function parseExplicitFiles(argv) {
  const flag = argv.find((a) => a.startsWith('--files='));
  if (flag === undefined) return null;
  const list = flag
    .slice('--files='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(list);
}

/**
 * EI-18756182128903253 — the cause-aware widening (fix option 1 of the filed bug): `--mine` /
 * `--files` scope attribution to the literal set of files the caller changed, which is
 * structurally BLIND to the single most common gate-redding change shape — adding a REQUIRED
 * field to a shared exported interface. By definition, the new type errors that causes land in
 * OTHER files (the fixtures/constructors that build that type and were never updated), not in
 * the file the caller edited. So the caller's own `--mine` reads clean, and the break first
 * surfaces hours later at green-checkpoint, redding the gate for the whole fleet.
 *
 * The fix: when a changed file exports a type/interface/class/enum, treat every OTHER file that
 * textually references that name as ALSO attributed to the caller if it regresses — not just the
 * changed file itself. This is a coarse, name-based proxy (it does not diff which specific
 * declaration line changed, and cannot tell a real reference from an unrelated identifier of the
 * same name) — deliberately so: for a lint GATE, the dangerous failure direction is a false
 * negative (silently missing the real cause), not a false positive (a name collision needlessly
 * widening attribution by one entry). Widening is always safe; missing is what cost the fleet a
 * gate cycle four times in 24 hours.
 *
 * Exported top-level type/interface/class/enum names declared in the given files' CURRENT
 * on-disk content.
 *
 * @param {string} root
 * @param {Iterable<string>} files
 * @returns {Set<string>}
 */
export function exportedTypeNames(root, files) {
  const names = new Set();
  const re = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const file of files) {
    let content;
    try {
      content = readFileSync(resolve(root, file), 'utf-8');
    } catch {
      continue; // unreadable (deleted, renamed, outside cwd) — skip, never crash the gate over it
    }
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1]);
  }
  return names;
}

/**
 * Which of `candidateFiles` reference any of `typeNames` as a standalone identifier — the other
 * half of `exportedTypeNames` above (EI-18756182128903253): cross-reference a changed file's
 * exported type names against every OTHER file, so a fixture that never added the new required
 * field gets attributed to the change that added it, instead of reported as unrelated peer drift.
 *
 * @param {string} root
 * @param {Iterable<string>} candidateFiles
 * @param {Set<string>} typeNames
 * @returns {Set<string>}
 */
export function filesReferencingTypeNames(root, candidateFiles, typeNames) {
  const referencing = new Set();
  if (typeNames.size === 0) return referencing;
  const escaped = [...typeNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(?:${escaped.join('|')})\\b`);
  for (const file of candidateFiles) {
    let content;
    try {
      content = readFileSync(resolve(root, file), 'utf-8');
    } catch {
      continue;
    }
    if (re.test(content)) referencing.add(file);
  }
  return referencing;
}

/**
 * Resolve the EFFECTIVE per-file baseline, inheriting cross-package files from their OWNING
 * package's baseline (EI-18649014117371738).
 *
 * ## Why this exists
 *
 * `decidePerFile` treats a file ABSENT from the baseline as an implicit 0 — correct for a file this
 * gate OWNS (a fresh file that arrives with errors IS a named regression). It is WRONG for a file in
 * ANOTHER package that has its own baseline gate: this gate's baseline was captured at some other
 * moment, under a DIFFERENT tsconfig, so "absent" there means "this gate never recorded it", NOT
 * "it was clean". Absent ⇒ 0 turns that gap into a phantom regression.
 *
 * That is not hypothetical: operator-core's baseline records e.g.
 * `packages/operator-core/lib/agent-tools/memory/search.ts: 1` (a KNOWN, TOLERATED error), while
 * apps/operator-vite's baseline — seeded four days later — never listed it. So `lint:tsc` PASSED and
 * `lint:tsc:operator-vite` FAILED on the SAME source file, and 12 operator-core files read as
 * regressions to an agent who had opened none of them. Two gates over one tree giving opposite
 * verdicts makes neither number trustworthy — exactly the false-signal problem the per-file gate was
 * built to kill (EI-847), reintroduced at the cross-package seam.
 *
 * ## The rule
 *
 * For a file this gate MEASURED but did not record, that lives under a `prefix` owned by a package
 * with its own baseline, inherit that package's recorded count instead of defaulting to 0.
 *
 *   - Own baseline ALWAYS wins when present — an explicit entry is this gate's own measured truth
 *     under its own tsconfig, and ratchet-only-down must never be loosened by a foreign number.
 *   - Inheritance is scoped to files actually in `currentByFile`, so a foreign baseline can never
 *     inject files this gate does not measure (that would fabricate phantom "improvements" and
 *     inflate the reported total).
 *   - Absent from BOTH is still an implicit 0 — a genuinely NEW error in a foreign file still gates.
 *
 * @param {{
 *   baselineByFile: Record<string, number>,
 *   currentByFile: Record<string, number>,
 *   foreignBaselines?: {prefix:string, files:Record<string,number>, label?:string}[],
 * }} args
 * @returns {{ effective: Record<string, number>, inherited: {file:string,baseline:number,from:string}[] }}
 */
export function effectiveBaselineByFile({ baselineByFile, currentByFile, foreignBaselines = [] }) {
  if (!foreignBaselines.length) return { effective: baselineByFile, inherited: [] };

  const effective = { ...baselineByFile };
  const inherited = [];
  for (const file of Object.keys(currentByFile)) {
    if (effective[file] !== undefined) continue; // this gate's OWN recorded count wins, always
    for (const source of foreignBaselines) {
      if (!file.startsWith(source.prefix)) continue;
      const count = source.files?.[file];
      if (typeof count === 'number' && count > 0) {
        effective[file] = count;
        inherited.push({ file, baseline: count, from: source.label ?? source.prefix });
      }
      break; // first matching prefix OWNS the file — a second source never overrides it
    }
  }
  inherited.sort((a, b) => a.file.localeCompare(b.file));
  return { effective, inherited };
}

/**
 * Pure per-file gate decision — the ONE place the policy lives, so it is unit-testable (EI-104).
 * A file is a REGRESSION when its current error count exceeds its baseline (a file absent from the
 * baseline has an implicit baseline of 0, so any new error in a fresh file is a named regression).
 * Regressions always win over improvements, preserving ratchet-only-down.
 *
 * @param {{
 *   currentByFile: Record<string, number>,
 *   baselineByFile: Record<string, number>,
 *   brokenFiles: string[],
 *   updateFlag?: boolean,
 *   changedFiles?: Set<string> | null,
 *   typeReferencedFiles?: Set<string> | null,
 *   dirtyFiles?: Set<string> | null,
 *   attributionDeclared?: boolean,
 * }} args
 * @returns {PerFileGateResult}
 */
export function decidePerFile({
  currentByFile,
  baselineByFile,
  brokenFiles,
  updateFlag = false,
  changedFiles = null,
  typeReferencedFiles = null,
  dirtyFiles = null,
  attributionDeclared = false,
}) {
  const total = sumValues(currentByFile);
  const baselineTotal = sumValues(baselineByFile);

  // EI-19321179234197157: SCOPE the syntax hard-fail the same way a type-error regression is
  // scoped. Bare/unscoped (changedFiles === null) keeps the original behaviour — ANY broken file
  // fails, because there is no "yours vs a peer's" distinction to make. Under `--mine`/`--files`,
  // a TS1xxx parse error OUTSIDE the caller's own changed-file set is a peer's in-flight edit on
  // this shared checkout (the same population `peerDrift`/`newFiles` already cover for type
  // errors) — it must not fail a run that named a specific, unrelated file set. A broken file the
  // caller DID name still hard-fails unconditionally, same as before.
  const attributedBroken = changedFiles ? brokenFiles.filter((f) => changedFiles.has(f)) : brokenFiles;
  const unattributedBroken = changedFiles ? brokenFiles.filter((f) => !changedFiles.has(f)) : [];
  if (attributedBroken.length > 0) {
    return {
      verdict: 'fail-syntax',
      brokenFiles: attributedBroken,
      unattributedBrokenFiles: unattributedBroken,
      regressions: [],
      improvements: [],
      total,
      baselineTotal,
    };
  }

  const allFiles = new Set([...Object.keys(currentByFile), ...Object.keys(baselineByFile)]);
  const regressions = [];
  const improvements = [];
  for (const file of allFiles) {
    const current = currentByFile[file] ?? 0;
    const baseline = baselineByFile[file] ?? 0;
    if (current > baseline) regressions.push({ file, baseline, current, delta: current - baseline });
    else if (current < baseline) improvements.push({ file, baseline, current, delta: current - baseline });
  }
  regressions.sort((a, b) => b.delta - a.delta || a.file.localeCompare(b.file));
  improvements.sort((a, b) => a.delta - b.delta || a.file.localeCompare(b.file));

  const base = { regressions, improvements, total, baselineTotal, unattributedBrokenFiles: unattributedBroken };

  if (regressions.length > 0) {
    if (changedFiles) {
      // EI-18756182128903253 — cause-aware widening: a regression outside `changedFiles` is STILL
      // attributed (not peer drift) when the file references an exported type/interface one of the
      // changed files also exports — the shape of "I added a required field, the fixture that
      // constructs it broke, and the fixture is not in my diff". `typeAttributed` is kept separate
      // from the directly-changed subset so callers/reporting can say WHY a file outside the diff
      // still gates.
      const isTypeAttributed = (file) =>
        !changedFiles.has(file) && !!typeReferencedFiles && typeReferencedFiles.has(file);
      const attributed = regressions.filter((r) => changedFiles.has(r.file) || isTypeAttributed(r.file));
      const typeAttributed = regressions.filter((r) => isTypeAttributed(r.file));
      const unattributed = regressions.filter((r) => !changedFiles.has(r.file) && !isTypeAttributed(r.file));
      // EI-18766822535373909 — a regression in a file with NO baseline entry is a BRAND-NEW file,
      // and it must never be dismissed as peer drift. Two independent reasons:
      //
      //  1. It is not "drift" in the only sense the peer-drift affordance is safe for. That
      //     affordance (EI-1984) exists to let pre-existing shared-tree debt flap without redding
      //     an unrelated agent — debt the baseline already KNOWS about. A file absent from the
      //     baseline has no known-good state to drift from; every error in it is NEW, which is
      //     precisely what this ratchet exists to catch. Bare mode already fails it
      //     ('fail-regressed'); only --mine was letting it through, so this closes an
      //     inconsistency between the two modes rather than adding a new policy.
      //  2. `changedFiles` CANNOT prove the file is not yours on this checkout. It is derived from
      //     `git status`, and git-sync auto-commits the whole tree every few minutes — so your own
      //     brand-new file stops being dirty, drops out of the "mine" set, and lands here. That is
      //     exactly how this was found: a new file's real TS2352 was reported under a leading ✓ as
      //     "peer drift — not your regression", and it would have red the green-checkpoint for the
      //     whole fleet hours later.
      //
      // '(unattributed)' (errors tsc did not pin to a file) is deliberately LEFT in peerDrift: it
      // is not a new file, and it is genuinely unattributable, so gating on it would red callers
      // for something they cannot act on.
      // EI-19278299775574199 — ANNOTATE (never re-classify) each new file with whether it is
      // uncommitted in the shared tree right now. Under `--files` the caller enumerated their own
      // files, so a new file outside that set which is ALSO dirty is a peer's live buffer: transient,
      // not yet pushed, and not yet a fleet-gate red. It still fails (the verdict below is
      // untouched) — but the reporter must not invite the caller to edit a file another agent is
      // actively writing. `dirty` is left UNDEFINED when the dirty set is unavailable, so an
      // unreadable git state can never be mistaken for "clean" (see partitionNewFilesByLiveEdit).
      const newFiles = unattributed
        .filter((r) => r.file !== '(unattributed)' && !(r.file in baselineByFile))
        .map((r) => (dirtyFiles ? { ...r, dirty: dirtyFiles.has(r.file) } : r));
      const peerDrift = unattributed.filter((r) => r.file === '(unattributed)' || r.file in baselineByFile);
      // Under --mine the gate fails when a regression lands in a file you changed, OR in a file so
      // new the baseline has never seen it. Drift in KNOWN files you did not touch stays reported
      // but not gated — that is the "verify MY change is clean" affordance (EI-1984), and it is why
      // --mine is opt-in and never the CI default.
      if (attributed.length > 0) return { verdict: 'fail-attributed', ...base, attributed, typeAttributed, peerDrift, newFiles };
      // EI-19305736771912430 — whether an unscoped NEW file may set the EXIT CODE turns on how the
      // changed-set was obtained, because that is what decides whether "not in the set" is evidence.
      //
      //  · `--mine` INFERS the set from `git status`. EI-18766822535373909's argument holds in full
      //    there: absence cannot clear you, because git-sync commits the tree every few minutes and
      //    your own new file is dirty for only a short window. So --mine still fails. Unchanged.
      //  · `--files` DECLARES the set: the caller enumerated their own files by hand. A new file
      //    outside that enumeration is one they asserted is not theirs — the very evidence git
      //    status cannot supply. Failing on it makes a SCOPED run non-deterministic (it reds or not
      //    depending on what peers happen to have dirty), and `--files` exists precisely to remove
      //    that (EI-18731016038876755, which fixed the REPORTING and left the exit code).
      //
      // The unscoped findings are NOT dropped — they ride the ok verdict and are still printed with
      // the same live-edit/standing split and fleet-gate warning. Silencing them would trade one
      // failure for another; the point is that a red must mean "something YOU must fix", or the
      // fleet learns to ignore reds — and the next one, which IS theirs, reads identically.
      if (newFiles.length > 0 && !attributionDeclared) {
        return { verdict: 'fail-new-file', ...base, attributed: [], peerDrift, newFiles };
      }
      return { verdict: 'ok-peer-drift', ...base, attributed: [], peerDrift, newFiles };
    }
    return { verdict: 'fail-regressed', ...base };
  }

  if (improvements.length > 0) {
    return updateFlag
      ? { verdict: 'ok-ratchet', ...base, newBaselineByFile: { ...currentByFile } }
      : { verdict: 'ok-below', ...base };
  }
  return { verdict: 'ok', ...base };
}

function formatRow(r) {
  return `   ${r.file}: ${r.baseline} → ${r.current}  (${r.delta > 0 ? '+' : ''}${r.delta})`;
}

/**
 * The headline for an ATTRIBUTED failure, worded per how the changed-set was derived.
 *
 * This is a pure function purely so the wording is TESTABLE, because the wording is where
 * the bug was. `--files` means the caller NAMED the files, so "you changed" is a fact.
 * `--mine` infers them from `git status` — and this repo has ONE working tree shared by the
 * whole fleet, with every agent's edits unstaged until the next git-sync tick, so that set is
 * "dirty right now": yours AND every peer's. Claiming "YOU changed" over it is false, and it
 * is expensively false in BOTH directions — you chase a peer's error believing it is yours,
 * or your own genuine regression arrives amid peer noise under the same label and you dismiss
 * the lot as fleet drift. Filed four separate times before the wording was fixed
 * (EI-18731016038876755, which added `--files`, plus three later duplicates).
 *
 * @param {{count: number, explicit: boolean}} opts
 * @returns {string}
 */
export function formatAttributionHeadline({ count, explicit }) {
  if (explicit) {
    return `❌ ${count} file(s) YOU NAMED added type errors above their baseline:`;
  }
  return (
    `❌ ${count} file(s) DIRTY IN THE WORKING TREE added type errors above their baseline — ` +
    `on this shared checkout that set is yours AND every peer's, so a file here may not be yours ` +
    `(re-run with --files=<the files you edited> to scope it to your own):`
  );
}

/**
 * The explanation printed under a `fail-new-file` verdict, worded per how the changed-set was
 * DERIVED. The verdict itself never moves (EI-18766822535373909): a file the baseline has never
 * seen has no known-good state to drift from, so NO scoping can exonerate it. Only the remedy
 * differs.
 *
 * WHY IT BRANCHES (EI-18802204276510164). The single closing line used to read "re-run with
 * --files=<paths>" unconditionally — including for a caller who had just passed `--files`, in a
 * run that echoes `[--files]` in its own header two lines above. Prescribing the action already
 * taken reads as "I invoked it wrong", so the reader goes to this script hunting their own
 * mistake instead of to the actual next step, and it lands on precisely the agents doing the
 * right thing: scoping their check exactly, at the moment they are deciding whether their change
 * is safe to leave in the shared tree.
 *
 * @param {{explicit: boolean, liveEditCount?: number, standingCount?: number}} opts `explicit` —
 *   the changed-set came from `--files` (named by the caller) rather than `--mine` (inferred from
 *   `git status`). `liveEditCount`/`standingCount` split the new files into a peer's uncommitted
 *   live edits vs committed standing reds (EI-19278299775574199); omitting BOTH yields the full
 *   standing text, so a caller that does not supply the split is never quietly exonerated.
 * @returns {string[]} console lines, already indented.
 */
export function formatNewFileGuidance({ explicit, liveEditCount = 0, standingCount = 0 }) {
  const NO_BASELINE =
    `   These files are new, so every error in them is new — the baseline has no known-good state to drift from.`;
  const TELL_THE_AUTHOR =
    `   If a file here really isn't yours, its author needs to know — a bare run of this gate reds the fleet on it.`;

  if (explicit) {
    // EI-19278299775574199 — when every new file is a peer's uncommitted live edit, the old closing
    // line ("If one is yours, fix it") prescribed exactly the wrong action: it invited the caller to
    // hand-edit a file another agent had open. Say what is actually true instead.
    const lines = [NO_BASELINE];
    if (liveEditCount > 0) {
      lines.push(
        `   ${liveEditCount} of them is/are UNCOMMITTED in this shared tree — a peer is very likely mid-edit right now.`,
        `   Those are NOT attributed to you and are NOT yours to fix: do not edit them, or you stomp a live peer.`,
        `   They are transient (nothing has reached origin yet) and usually clear on their own within a few minutes —`,
        `   re-run this check shortly, or confirm with: git status --porcelain <path>`,
      );
    }
    // `standingCount === 0 && liveEditCount === 0` is a caller that did not supply the split at
    // all. Fall back to the full standing text — the same "unknown is never an exoneration" rule
    // partitionNewFilesByLiveEdit applies, and it keeps this function's no-arg behaviour identical
    // to before the split existed.
    if (standingCount > 0 || liveEditCount === 0) {
      lines.push(
        `   ${standingCount} of them is/are COMMITTED — a standing red that WILL red the fleet at the next bare run.`,
        `   They are OUTSIDE the --files set you named and reported anyway BECAUSE they are new:`,
        `   scoping only exonerates a file the baseline already knows, and these have no baseline at all.`,
        `   So this is not a bad invocation — naming them would not clear them either. If one is yours, fix it.`,
        TELL_THE_AUTHOR,
      );
    }
    return lines;
  }
  return [
    NO_BASELINE,
    `   They are not in your git-status changed set, but that does NOT establish they aren't yours: git-sync`,
    `   auto-commits this shared tree every few minutes, which silently drops your own recent work out of that set.`,
    TELL_THE_AUTHOR,
    `   To scope this check to exactly the files you touched, re-run with --files=<comma-separated paths>.`,
  ];
}

/**
 * Split `newFiles` into a peer's LIVE EDITS and STANDING reds — the two populations the
 * `fail-new-file` report used to conflate (EI-19278299775574199).
 *
 * The asymmetry that makes this safe. EI-18766822535373909 established that the verdict can never
 * move, because `changedFiles` cannot prove a file is not yours: git-sync commits this tree every
 * few minutes, so your own new file stops being dirty and drops out of the changed set. That
 * argument is about a file being CLEAN — and it is exactly right. It says nothing about a file that
 * is DIRTY *right now*, which is the opposite evidence: under `--files` the caller enumerated their
 * own files, so a dirty file they did not name has a live editor who is not them.
 *
 * `dirty === undefined` (dirty set unreadable, or `--mine`, where a dirty file is already
 * `attributed` and can never reach here) is deliberately treated as STANDING. Unknown must never
 * buy an exoneration — that would be the fail-open shape this gate's whole design avoids.
 *
 * @param {PerFileGateEntry[]} newFiles
 * @returns {{liveEdits: PerFileGateEntry[], standing: PerFileGateEntry[]}}
 */
export function partitionNewFilesByLiveEdit(newFiles) {
  return {
    liveEdits: newFiles.filter((r) => r.dirty === true),
    standing: newFiles.filter((r) => r.dirty !== true),
  };
}

/**
 * The COMPILER LINES behind a new file's `+N` — the WHAT the count alone withholds (WI-6767).
 *
 * The gate holds the full tsc output and, until now, reported only `file: 0 → 1 (+1)`. Recovering
 * the message from that costs a fresh full-project compile, which on this box is ~100s under
 * contention and is exactly what the two agents who hit this could not afford: the WI-6764 filer
 * recorded that a full `tsc -p packages/operator-core` blew their shell budget TWICE, so they filed
 * a major bug without ever seeing the error; the next agent then spent ~20 minutes re-deriving it.
 * The line was sitting in a string the gate already had.
 *
 * It matters far beyond convenience, because the message is frequently the whole diagnosis. The
 * WI-6764 error read `TS2322: Type '"memory-recall-scale"' is not assignable to type
 * 'WatchdogSource'` — naming a type in a DIFFERENT file, which is the signature of a multi-file
 * change still landing (see `formatLandingRaceCaveat`). A bare `+1` cannot suggest that; the
 * message says it outright.
 *
 * Deliberately a separate projection rather than a widening of `parseTscErrors`: that function's
 * `{file, code}` shape is asserted with strict equality by `lint-tsc.test.ts` and its narrowness is
 * a documented decision (`packages/operator-core/lib/tsc-diagnostics.ts` explains why the gate
 * counts rather than carries messages). This is display-only and feeds nothing that decides a
 * verdict.
 *
 * @param {string} tscOutput - Raw compiler output.
 * @param {Iterable<string>} files - Repo-relative paths to quote lines for.
 * @param {{maxPerFile?: number}} [opts] - `maxPerFile` bounds the quote so a file with 40 errors
 *   cannot bury the guidance underneath it (the report stays readable; the count already told you
 *   the true total).
 * @returns {Map<string, string[]>} file → its diagnostic lines, in compiler order, capped.
 */
export function diagnosticLinesForFiles(tscOutput, files, { maxPerFile = 3 } = {}) {
  const wanted = new Set(files);
  /** @type {Map<string, string[]>} */
  const byFile = new Map();
  if (wanted.size === 0) return byFile;
  for (const line of String(tscOutput).split('\n')) {
    const m = line.match(LOCATED_DIAGNOSTIC);
    if (m === null || !wanted.has(m[1])) continue;
    const acc = byFile.get(m[1]) ?? [];
    if (acc.length < maxPerFile) acc.push(line.trim());
    byFile.set(m[1], acc);
  }
  return byFile;
}

/**
 * How recently a file must have been committed for its red to be treated as possibly still landing.
 *
 * 20 minutes, sized from the mechanism rather than taste: git-sync commits this tree on a schedule
 * of a few minutes, and the observed WI-6764 split was 7m49s between the two halves of one logical
 * change. 20min covers that with margin while staying far below the hours a genuine standing red
 * survives. It only ever adds a caveat — never removes one — so erring long is the safe direction.
 */
export const LANDING_RACE_WINDOW_SEC = 20 * 60;

/**
 * Last commit time (epoch seconds) per path. Fail-SOFT per file: anything unreadable maps to
 * `null`, which `partitionStandingByCommitRecency` treats as NOT recent — i.e. the loud, standing
 * reading. An unreadable git state must never manufacture a "probably fine, ignore it" caveat.
 *
 * Uses `execFileSync` (argv, no shell) so a path with a space or a shell metacharacter is passed
 * verbatim instead of being re-split or interpreted.
 *
 * @param {string} root - Repo root to run git in.
 * @param {Iterable<string>} files
 * @returns {Map<string, number | null>}
 */
export function lastCommitTimes(root, files) {
  /** @type {Map<string, number | null>} */
  const times = new Map();
  for (const file of files) {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', file], {
        cwd: root,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      const parsed = Number.parseInt(out.trim(), 10);
      times.set(file, Number.isFinite(parsed) ? parsed : null);
    } catch {
      times.set(file, null);
    }
  }
  return times;
}

/**
 * Split committed new files into ones committed so recently they may be a LANDING RACE, and ones
 * settled long enough that the red is really standing (WI-6767).
 *
 * `null`/missing/future timestamps fall to `settled` — the same "unknown is never an exoneration"
 * rule `partitionNewFilesByLiveEdit` applies, and for the same reason: this caveat tells a reader
 * it is safe to wait rather than act, so it must be earned by positive evidence, never by an
 * absence of evidence.
 *
 * @param {PerFileGateEntry[]} standing - The COMMITTED subset (never a peer's live buffer).
 * @param {Map<string, number | null>} commitTimes
 * @param {number} nowSec - Current time, epoch seconds (injected so this stays pure/testable).
 * @param {number} [windowSec]
 * @returns {{recent: PerFileGateEntry[], settled: PerFileGateEntry[]}}
 */
export function partitionStandingByCommitRecency(
  standing,
  commitTimes,
  nowSec,
  windowSec = LANDING_RACE_WINDOW_SEC,
) {
  const recent = [];
  const settled = [];
  for (const r of standing) {
    const t = commitTimes.get(r.file);
    const age = typeof t === 'number' ? nowSec - t : null;
    if (age !== null && age >= 0 && age <= windowSec) recent.push(r);
    else settled.push(r);
  }
  return { recent, settled };
}

/**
 * The LANDING-RACE caveat — the third population the committed/uncommitted split cannot express.
 *
 * EI-19278299775574199 taught this report to separate a peer's UNCOMMITTED live edit ("don't touch
 * it") from a COMMITTED standing red ("fix it now"). That split is right and stays. But it assumes
 * `committed` means `settled`, and on this repo it does not: git-sync commits the WHOLE shared tree
 * on a schedule, so ONE logical multi-file change routinely lands across TWO ticks. Between them
 * the committed tree holds a half-landed change that typechecks as a genuine error belonging to
 * nobody.
 *
 * Measured, not hypothesised (WI-6764): commit 133317acd0 @20:25:57 landed a file emitting
 * `source: 'memory-recall-scale'`; the union that accepts that value arrived in watchdog.ts at
 * 82a0d03bef @20:33:46. For 7m49s the tree carried exactly one real type error. An agent ran this
 * gate inside that window, checked `git status` (clean), correctly concluded "committed ⇒ standing
 * red" — and filed a major bug for something that had healed itself ~1 minute earlier. Their
 * reasoning was sound; the report simply had no way to say "wait a moment first".
 *
 * Note what this does NOT do: it never moves the verdict, never suppresses a row, and never
 * downgrades the exit code. A landing race and a standing red are indistinguishable at this
 * instant, so the honest report is "still failing — and here is the one cheap check that tells you
 * which".
 *
 * @param {{recentCount: number, windowMin?: number}} opts
 * @returns {string[]} console lines, already indented; empty when nothing is recent.
 */
export function formatLandingRaceCaveat({ recentCount, windowMin = LANDING_RACE_WINDOW_SEC / 60 }) {
  if (recentCount <= 0) return [];
  return [
    `   ⚠ ${recentCount} of them was/were COMMITTED IN THE LAST ${windowMin} MINUTES — this may be a LANDING`,
    `   RACE rather than a standing red. git-sync commits this whole shared tree on a schedule, so ONE`,
    `   logical multi-file change routinely lands across TWO ticks; in between, the tree holds a`,
    `   half-landed change that fails to typecheck and belongs to nobody.`,
    `   BEFORE FILING A BUG: re-run this check in a few minutes and see if it clears itself.`,
    `   If the message above names a symbol defined in ANOTHER file, that is the signature — check when`,
    `   that file landed:  git log -1 --format=%ci -- <the file defining that symbol>`,
  ];
}

/**
 * Run the full CLI gate for one project and `process.exit(...)` with its verdict — the shared
 * `main()` every per-project CLI (lint-tsc.mjs, lint-tsc-operator-vite.mjs, …) delegates to.
 *
 * @param {RunTscBaselineGateOptions} options
 */
export function runTscBaselineGate({
  root,
  tscCommand,
  baselineFile,
  label,
  argv,
  countField = 'errorCount',
  foreignBaselines = [],
}) {
  const updateFlag = argv.includes('--update');
  const explicitFiles = parseExplicitFiles(argv);
  const mineFlag = argv.includes('--mine') || explicitFiles !== null;

  let tscOutput = '';
  let tscThrew = false;
  // WI-7017 — throttle + coalesce the COMPILE, not the whole gate.
  //
  // `--files` is a GATE-scoping flag that never reaches tsc (`tscCommand` is a
  // per-project constant; see lint-tsc.mjs's TSC_COMMAND). But the npm scripts used to
  // wrap the whole CLI in pc-heavy, so `--files=a.ts` and `--files=b.ts` presented
  // DIFFERENT argv and pc-heavy's (cwd, argv, tree-token) coalescing key never matched.
  // N agents each paid for a byte-identical ~104s compile while the semaphore queued 49
  // deep (measured 2026-08-02: load1 186, three concurrent identical compiles).
  //
  // Wrapping only the compile makes argv IDENTICAL across callers, so concurrent runs
  // coalesce onto ONE compile. Each caller still filters the RAW diagnostics by its own
  // `--files` and computes its OWN exit code below, so a caller-specific VERDICT is never
  // shared — that sharing is what made naive coalescing-key widening unsafe (a red for
  // file A is a green for a caller who named only file B).
  //
  // pc-heavy's own stderr is deliberately kept OUT of the captured stream (only tsc's own
  // `2>&1` is captured, inside the wrapped child). If pc-heavy's chatter were captured, a
  // pc-heavy failure BEFORE tsc ever ran would leave `tscOutput` non-empty with zero
  // parseable diagnostics — which reads as "0 errors" and, under `--update`, would ratchet
  // every file's baseline to 0 and mask everything. The `!tscOutput` toolchain-failure
  // guard below is what catches that, and it only works if the stream stays clean.
  //
  // Fail-open (matching pc-heavy's own contract): no wrapper on disk ⇒ run tsc directly.
  // Admission control must never be the reason a legitimate typecheck cannot start.
  const pcHeavyPath = resolve(root, 'scripts', 'pc-heavy.sh');
  try {
    tscOutput = existsSync(pcHeavyPath)
      ? execFileSync('bash', [pcHeavyPath, 'sh', '-c', `${tscCommand} 2>&1`], {
          cwd: root,
          encoding: 'utf-8',
          maxBuffer: 64 * 1024 * 1024,
        })
      : execSync(`${tscCommand} 2>&1`, {
          cwd: root,
          encoding: 'utf-8',
          maxBuffer: 64 * 1024 * 1024,
        });
  } catch (e) {
    tscThrew = true;
    tscOutput = e.stdout || '';
  }
  if (tscThrew && !tscOutput) {
    // tsc itself failed to run (no diagnostics at all) — never treat that as zero errors, it would
    // ratchet every file's baseline to 0 and mask everything.
    console.error('❌ tsc produced no output — toolchain failure, not a clean run.');
    process.exit(1);
  }

  const errors = parseTscErrors(tscOutput);
  const brokenFiles = syntaxBrokenFiles(errors);
  const currentByFile = countByFile(errors);

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
  } catch {
    console.error(`❌ Failed to read baseline file: ${baselineFile}`);
    process.exit(1);
    return;
  }
  const ownBaselineByFile = baseline.files ?? {};

  // Load each owning package's baseline for the cross-package files this gate measures but does not
  // own. Fail-SOFT per source: an unreadable foreign baseline degrades to the old absent⇒0 behaviour
  // (a possible false red we WARN about) rather than crashing the gate or silently passing.
  const loadedForeign = [];
  for (const source of foreignBaselines) {
    try {
      const parsed = JSON.parse(readFileSync(source.baselineFile, 'utf-8'));
      loadedForeign.push({ ...source, files: parsed.files ?? {} });
    } catch {
      console.warn(
        `⚠ Could not read the baseline owning ${source.prefix} (${source.baselineFile}) — ` +
          `files under it fall back to an implicit 0 baseline and may report as false regressions.`,
      );
    }
  }

  const { effective: baselineByFile, inherited } = effectiveBaselineByFile({
    baselineByFile: ownBaselineByFile,
    currentByFile,
    foreignBaselines: loadedForeign,
  });
  // EI-18731016038876755: an explicit --files= list is authoritative — the caller SAID which
  // files are theirs, so never fall back to the git-status guess for the same run.
  const changedFiles = explicitFiles ?? (mineFlag ? gitChangedFiles(root) : null);

  // EI-18756182128903253 — cause-aware widening: when scoped (--mine or --files), also attribute
  // a regression OUTSIDE the changed set when that file references an exported type/interface one
  // of the changed files also exports (the "I added a required field, an unchanged fixture broke"
  // shape --mine was otherwise structurally blind to). Cheap: only reads the changed files plus the
  // files that already have a regression, never a tree-wide scan.
  const typeReferencedFiles = changedFiles
    ? filesReferencingTypeNames(
        root,
        Object.keys(currentByFile).filter((f) => f !== '(unattributed)' && !changedFiles.has(f)),
        exportedTypeNames(root, changedFiles),
      )
    : null;

  // EI-19278299775574199 — only meaningful under `--files`: there `changedFiles` is the caller's
  // OWN enumeration, so the working-tree dirt is a separate, independent signal ("someone has this
  // open"). Under `--mine` the two sets are the same query, so a dirty file is already `attributed`
  // and can never reach `newFiles` — computing it there would cost a git call to learn nothing.
  const dirtyFiles = explicitFiles !== null ? gitChangedFiles(root) : null;

  // EI-19305736771912430 — `--files` DECLARES the caller's own file set; `--mine` only INFERS it
  // from git status. Only the declared form may stop an unscoped new file setting the exit code.
  const result = decidePerFile({
    currentByFile,
    baselineByFile,
    brokenFiles,
    updateFlag,
    changedFiles,
    typeReferencedFiles,
    dirtyFiles,
    attributionDeclared: explicitFiles !== null,
  });
  console.log(
    `TSC ${label}: ${result.total} type errors across ${Object.keys(currentByFile).length} file(s) ` +
      `(baseline total ${result.baselineTotal})${explicitFiles ? ' [--files]' : mineFlag ? ' [--mine]' : ''}`,
  );
  if (inherited.length > 0) {
    console.log(
      `   (${inherited.length} cross-package file(s) inherited their baseline from the package that OWNS them — ` +
        `already-known errors there, not regressions to this gate.)`,
    );
  }

  const writeBaseline = (byFile, why) => {
    baseline.files = Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)));
    baseline[countField] = sumValues(byFile); // derived total, kept for humans/back-compat
    baseline.updatedAt = new Date().toISOString();
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✓ ${why}: baseline → ${sumValues(byFile)} errors across ${Object.keys(byFile).length} file(s)`);
  };

  // EI-19321179234197157: a TS1xxx-broken file OUTSIDE the caller's own --mine/--files set never
  // gates the verdict (see decidePerFile), but it is still surfaced here — unconditionally, ahead
  // of the verdict switch, so it is never lost whichever branch below returns. tsc's diagnostics
  // for OTHER files can be incomplete while a file fails to parse, so this doubles as a caveat on
  // how much to trust an 'ok' verdict alongside it.
  if (result.unattributedBrokenFiles && result.unattributedBrokenFiles.length > 0) {
    console.error(
      `   ⚠ ${result.unattributedBrokenFiles.length} file(s) fail to COMPILE (TS1xxx parse errors) but are NOT in ` +
        `the set you named — not gating this run (a peer is likely mid-edit on this shared checkout), but tsc's ` +
        `counts for other files may be incomplete while these stay broken:`,
    );
    for (const f of result.unattributedBrokenFiles) console.error(`     - ${f}`);
  }

  switch (result.verdict) {
    case 'fail-syntax':
      console.error(`❌ ${result.brokenFiles.length} file(s) fail to COMPILE (TS1xxx parse errors) — hard fail regardless of baseline:`);
      for (const f of result.brokenFiles) console.error(`   - ${f}`);
      process.exit(1);
      break;
    case 'fail-regressed':
      console.error(`❌ ${result.regressions.length} file(s) added type errors above their baseline:`);
      for (const r of result.regressions) console.error(formatRow(r));
      console.error(`   Fix the new errors in the named file(s). The baseline only ratchets DOWN (raising a file is a hand-edit of ${baselineFile} with justification).`);
      process.exit(1);
      break;
    case 'fail-attributed':
      console.error(
        formatAttributionHeadline({ count: result.attributed.length, explicit: explicitFiles !== null }),
      );
      for (const r of result.attributed) console.error(formatRow(r));
      if (result.typeAttributed && result.typeAttributed.length > 0) {
        console.error(
          `   (${result.typeAttributed.length} of the above are NOT in your changed-file set — attributed because ` +
            `they reference an exported type/interface one of your changed files also exports. This is the ` +
            `EI-18756182128903253 fix: a required-field addition breaks a fixture/constructor your diff never ` +
            `touched, and that fixture now gates with your change instead of surfacing hours later at green-checkpoint.)`,
        );
      }
      if (result.newFiles.length > 0) {
        // EI-19278299775574199 — same split as the fail-new-file branch: an uncommitted new file is
        // a peer's live buffer, not part of the caller's regression.
        const { liveEdits } = partitionNewFilesByLiveEdit(result.newFiles);
        console.error(
          `   (also ${result.newFiles.length} NEW file(s) with errors` +
            `${liveEdits.length > 0 ? `, ${liveEdits.length} uncommitted — a peer is likely mid-edit, NOT yours` : ''} — see below)`,
        );
        for (const r of result.newFiles) {
          console.error(r.dirty === true ? `${formatRow(r)}  ← uncommitted, not attributed to you` : formatRow(r));
        }
      }
      if (result.peerDrift.length > 0) {
        console.error(`   (also ${result.peerDrift.length} regressed file(s) not in your changed set — not gated under --mine)`);
      }
      process.exit(1);
      break;
    case 'fail-new-file': {
      // EI-18766822535373909: these are files the baseline has NEVER seen. Absence from the
      // changed set does not clear you — git-sync commits the tree every few minutes, so your own
      // new file is dirty for only a short window. Never greenwash this one.
      //
      // EI-19278299775574199 splits the LISTING (never the verdict) so the two populations that
      // need opposite actions stop looking identical: a peer's uncommitted live buffer must not be
      // edited, a committed standing red must be.
      const { liveEdits, standing } = partitionNewFilesByLiveEdit(result.newFiles);
      // WI-6767 — quote the compiler lines the `+N` stands for. The gate already holds them; the
      // alternative for the reader is a fresh ~100s full-project compile, which is precisely what
      // the WI-6764 filer could not afford and so filed a major bug without ever seeing the error.
      const diagnostics = diagnosticLinesForFiles(
        tscOutput,
        result.newFiles.map((r) => r.file),
      );
      const emitRow = (r, suffix = '') => {
        console.error(`${formatRow(r)}${suffix}`);
        for (const line of diagnostics.get(r.file) ?? []) console.error(`      ${line}`);
      };
      if (liveEdits.length > 0) {
        console.error(
          `❌ ${result.newFiles.length} NEW file(s) (not in the baseline) have type errors — ` +
            `${liveEdits.length} of them uncommitted (a peer is likely mid-edit; NOT yours):`,
        );
        for (const r of liveEdits) emitRow(r, '  ← uncommitted, not attributed to you');
        for (const r of standing) emitRow(r);
      } else {
        console.error(`❌ ${result.newFiles.length} NEW file(s) (not in the baseline) have type errors:`);
        for (const r of result.newFiles) emitRow(r);
      }
      // EI-18802204276510164 — the remedy is worded per how the changed-set was derived, so a
      // caller who already passed --files is never told to pass --files.
      for (const line of formatNewFileGuidance({
        explicit: explicitFiles !== null,
        liveEditCount: liveEdits.length,
        standingCount: standing.length,
      })) {
        console.error(line);
      }
      // WI-6767 — the landing-race caveat, computed over the COMMITTED subset only (a peer's live
      // buffer is already correctly explained above, and git log would say nothing about it).
      // Costs one `git log -1` per committed new file, and nothing at all when there are none.
      const { recent } = partitionStandingByCommitRecency(
        standing,
        lastCommitTimes(
          root,
          standing.map((r) => r.file),
        ),
        Math.floor(Date.now() / 1000),
      );
      for (const line of formatLandingRaceCaveat({ recentCount: recent.length })) {
        console.error(line);
      }
      process.exit(1);
      break;
    }
    case 'ok-peer-drift': {
      console.log(`✓ Your changed files are tsc-clean. ${result.peerDrift.length} file(s) already in the baseline regressed but are not in your changed set:`);
      for (const r of result.peerDrift) console.log(formatRow(r));
      console.log(`   (Not gated under --mine. Note the changed set comes from git status, and git-sync auto-commits this tree`);
      console.log(`    every few minutes — so a file you edited a while ago can appear here. Use --files= to scope precisely.`);
      console.log(`    A bare npm run of this gate will still catch these for whoever owns them.)`);
      // EI-19305736771912430 — under `--files` an unscoped NEW file no longer sets the exit code,
      // but it is emphatically still REPORTED: a committed one is a standing red that WILL red the
      // fleet at the next bare run, and someone has to see it. Not gating it is what stops a SCOPED
      // run crying wolf; not printing it would just move the problem.
      if (result.newFiles.length > 0) {
        const { liveEdits, standing } = partitionNewFilesByLiveEdit(result.newFiles);
        console.log(
          `   ⚠ ${result.newFiles.length} NEW file(s) (absent from the baseline) also have type errors, ` +
            `none of them in the set you named:`,
        );
        for (const r of liveEdits) console.log(`${formatRow(r)}  ← uncommitted, a peer is likely mid-edit`);
        for (const r of standing) console.log(`${formatRow(r)}  ← COMMITTED: a standing red that WILL red the fleet`);
        if (standing.length > 0) {
          console.log(`    Not YOUR gate failure (you did not name them), so this run stays green — but the`);
          console.log(`    committed one(s) above need an owner. A bare npm run of this gate reds the fleet on them.`);
        }
      }
      process.exit(0);
      break;
    }
    case 'ok-ratchet':
      // Reached ONLY on an explicit `--update` with at least one improved file (decidePerFile gates it).
      writeBaseline(result.newBaselineByFile, 'Ratcheted improved file(s) down (--update)');
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    case 'ok-below':
      console.log(`✓ ${result.improvements.length} file(s) below baseline — NOT locked in. Re-run with --update on a quiet tree to lower them deliberately:`);
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    default:
      if (updateFlag) console.log('✓ --update: every file is at its baseline — nothing to lower.');
      console.log(`✓ Every ${label} file is at or under its type-error baseline.`);
      process.exit(0);
  }
}
