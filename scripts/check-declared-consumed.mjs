#!/usr/bin/env node
/**
 * check-declared-consumed.mjs — THE DECLARED-VS-CONSUMED SWEEP
 * (agent-state-plane-verification-2026-07-27 P-002, generalising WI-6444 / D-100).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * P-001's producer census asks a RUNTIME question: is anything writing this
 * column in production data? This gate asks the STATIC twin, which catches the
 * same defect class one step earlier and without needing a populated database:
 *
 *     For every field/column this plane DECLARED — does the tree contain both a
 *     non-test WRITER and a non-test READER of it?
 *
 * WI-6444 is the canonical instance. `unknownHoist` was declared on `CellSpec`,
 * enforced by `validateCellSpec`, and set by six cell registrations — and read
 * by NOTHING that emitted it. Every half was individually correct and fully
 * unit-tested. Three lines of grep separated 6 declaration sites + 1 validator
 * from 0 consumers; this file makes that grep a standing check.
 *
 * ── ⚠ THE FOUR VACUOUS PASSES THIS GATE IS BUILT TO AVOID ────────────────────
 *
 * The naive implementation greps the identifier name and passes when it finds
 * hits. That gate is green on WI-6444 for FOUR independent reasons, and each one
 * had to be closed separately:
 *
 *  (1) A DECLARATION IS NOT A USE. `unknownHoist?: string` in an interface is a
 *      hit. So is `ordered?: { stages: string[] }`. A name-only grep counts the
 *      very declaration whose consumption is in question as evidence that it is
 *      consumed. Closed by {@link interfaceRanges}: a property inside an
 *      `interface`/`type` body is a DECLARATION, one outside it is a WRITE, and
 *      the two are told apart structurally rather than by guessing at the RHS.
 *
 *  (2) A COMMENT IS NOT A USE. `cell-read.ts` mentions "`spec.unknownHoist`"
 *      inside a docblock, and `cell-registry.ts` names `materiality` in nine
 *      rejection MESSAGES. Both read as property accesses to a grep. Closed by
 *      {@link stripComments} — and this is not a nicety: the single densest
 *      concentration of a field's name in this codebase is the prose explaining
 *      it, so an un-stripped sweep is *most* confident exactly where a field is
 *      best documented and least used.
 *
 *  (3) THE DECLARING MODULE IS NOT A CONSUMER. `validateCellSpec` reads
 *      `spec.unknownHoist` twice — in the same file that declares it. Counting
 *      that, the sweep stays green after deleting the real emission in
 *      `cell-read.ts`, i.e. it does not re-derive WI-6444, which is the one
 *      thing it must do. A type validating its own field proves the field is
 *      well-formed, never that anyone wants it. Closed by `declaredIn`.
 *
 *  (4) RETIRED CODE IS NOT A CONSUMER. A read from `_retired/` is a read by
 *      something deliberately not deployed. Closed by {@link SKIP_DIRS}.
 *
 * ── AND THE FIFTH: A ROW THAT NO LONGER MATCHES ANYTHING ─────────────────────
 *
 * If a field is renamed, its row here matches zero declarations. "No reader and
 * no writer" is then not a defect report, it is the gate describing a target
 * that has ceased to exist — the static analogue of P-001's `no-data`, where a
 * count of zero means "we looked at nothing" rather than "nothing is there".
 * Reporting it as a defect sends someone hunting a consumer for a field that is
 * gone; reporting it as a pass is a green tick over an unwatched surface. So
 * `not-declared` is its own verdict with its own message, and it fails as a GATE
 * MAINTENANCE error rather than as a missing consumer.
 *
 * ── HEURISTIC, AND WHICH WAY IT LEANS ────────────────────────────────────────
 *
 * This is regex-and-brace-depth over stripped source, not a typechecker, and it
 * is worth being precise about what that costs. A property is recognised only at
 * the START of a line, so a mid-line `{ ordered: 1 }` or a write spread across
 * lines is MISSED. Every such miss removes a writer or a reader, which moves a
 * row toward `write-only`/`read-only`/`inert`/`not-declared` — all of which FAIL.
 * There is no formatting that converts a miss into a green tick, which is the one
 * property a heuristic gate has to have: it can waste your time, it cannot lie to
 * you. The report prints file:line for every site counted, so a verdict you
 * doubt is audited by looking rather than by trusting.
 *
 * The honest limitation is the opposite direction: a false POSITIVE read hides a
 * defect, and vacuous passes (5) and (6) below were both exactly that. Both were
 * caught only because a field already proven dead by hand kept coming back green
 * — which is why the sweep's acceptance test is "does it re-derive a KNOWN
 * defect", never "does it pass".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Directories a live consumer cannot live in. `_retired` is vacuous-pass (4). */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target', 'coverage',
  '_retired', '.turbo', 'out', '.venv', 'venv', '__pycache__',
  // Vacuous pass (5) — see `looksGenerated`. Storybook's published bundle is the
  // instance that actually fired here.
  'storybook-static',
]);

/**
 * A minified/bundled artifact is not a consumer — vacuous pass (5).
 *
 * This one was found the hard way, and it is the most dangerous of the set
 * because it produces confident, plausible-looking numbers. The first green run
 * of this sweep reported `CellSpec.ordered` as CONSUMED with 46 readers. All 46
 * were `.ordered` inside `storybook-static/**` webpack bundles — minified
 * third-party code where two-letter property names collide with anything. The
 * field is in fact read by nothing, which is the defect the gate exists to find,
 * and a build artifact checked into the tree had hidden it perfectly.
 *
 * Detection is by line SHAPE rather than by path, because the next bundle will
 * live somewhere this list does not name: source is written in lines, generated
 * code is not.
 *
 * ⚠ The test is DOMINANCE, not presence — "has one long line" is NOT "is
 * minified", and conflating the two red-pinned the fleet gate for hours
 * (EI-19409948281572150). The original form returned true on the FIRST line over
 * 2000 chars, which silently dropped six hand-written source files whose only sin
 * was one long prose string: `cell-registrations.ts` (2657-char `why:`, 6.9% of
 * the file), `libs/flags/src/types.ts` (1.1%), `converse-prompt.ts` (10.9%) and
 * `work_items/get.ts` (13.9%). Dropping `cell-registrations.ts` removed the ONLY
 * writer of `CellSpec.unknownHoist` and `CellSpec.materiality`, so the sweep
 * reported both as 0-writer "read-only" and failed the build on fields that are
 * in fact written seven and one times respectively.
 *
 * That is the worst failure mode this file has, because a skipped file is
 * indistinguishable from an absent one: the sweep under-scans SILENTLY and every
 * row's verdict quietly loses confidence, not just the rows that go red.
 *
 * Measured separation is wide for MINIFIED output: real minified bundles
 * (`_astro/*.js`, `pagefind-*.js`, and the base64 asset blobs
 * `release-bg.ts` / `release-video.ts`) carry 93–100% of their bytes in
 * over-long lines; genuine source with a long literal carries 1.1–13.9%.
 *
 * ⚠⚠ BUT SHAPE ALONE IS NOT SUFFICIENT, and believing it was is what made the
 * first attempt at this fix WORSE than the bug. A bundle that is BUNDLED BUT NOT
 * MINIFIED defeats every line-shape test: `apps/operator/dist-host/hono-host.mjs`
 * is 62.9 MB over 1,219,924 lines with only 14.4% of its bytes in long lines —
 * shaped exactly like source. Admitting it contributed 412 writes and 1,802 reads
 * of `summary` by itself, flipping every column row to a confident "consumed".
 * That is the ORIGINAL storybook defect at 40x the scale: it does not merely
 * report a wrong number, it GREENS the gate by manufacturing consumers for
 * fields nothing reads.
 *
 * Nor can size stand in for it: the largest file both rules already scan is a
 * genuine 394 KB source script (`apps/operator/scripts/psu-launcher.mjs`), while
 * generated files occur at every size down to 4 KB. The populations overlap on
 * every intrinsic axis measured.
 *
 * So detection is now TWO tests, and the path one is load-bearing rather than a
 * convenience: build output is EXCLUDED BY LOCATION, and the long-line dominance
 * test remains as the shape backstop that still catches a bundle checked in
 * somewhere this list does not name — which is the case the original comment was
 * right to worry about.
 */
export function looksGenerated(src) {
  if (src.length === 0) return false;
  let start = 0;
  let longBytes = 0;
  // `i === src.length` closes the final line when the file has no trailing \n.
  for (let i = 0; i <= src.length; i++) {
    if (i < src.length && src[i] !== '\n') continue;
    const len = i - start;
    if (len > 2000) longBytes += len;
    start = i + 1;
  }
  return longBytes * 2 > src.length;
}

/**
 * Build output, excluded by LOCATION — the half of the test that shape cannot do.
 *
 * Every directory here is a build artifact committed into the tree, and each one
 * was observed contributing bogus matches: `dist-host/` (the 62.9 MB Hono
 * bundle), `operator-vite/dist/`, the docs `dist/` trees, `storybook-static/`
 * (the ORIGINAL 46 fake `.ordered` readers), and `public/` (pagefind, monaco,
 * vditor, wake-runtime, `_astro`).
 *
 * Matching is on a PATH SEGMENT so `dist` never matches `distributed-lock.ts`.
 * A generated file OUTSIDE these directories is still caught by
 * `looksGenerated`, so this list being incomplete degrades to the old behaviour
 * rather than to a false green.
 */
const BUILD_OUTPUT_SEGMENTS = new Set([
  'dist',
  'dist-host',
  'dist-electron',
  'build',
  'out',
  'storybook-static',
  'public',
  'coverage',
  '.astro',
  '.next',
]);

/**
 * Generated artifacts that do NOT live under a build directory, so neither the
 * path segments above nor the shape test can reach them.
 *
 * The drizzle mirror (regenerated by `libs/papercusp/libs/db/scripts/pull-schema.mjs`
 * after every migration) is the whole list today, and it is excluded for a reason
 * that is semantic as well as practical: a schema file DECLARES tables, it does
 * not read or write rows, so it can never be the "live consumer" this sweep is
 * looking for — it is vacuous pass (3), the declaring module, one level up.
 *
 * Practically it is also the single most corrupting file the sweep can admit,
 * because column scoping is FILE-level (`src.includes(target.table)`): one file
 * that names every table lets every column in that file count as consumed.
 * Measured, admitting it alone reported `agent_plane_measurements.workspace_id`
 * as 123W/2566R against a true 1W/12R.
 */
const GENERATED_SOURCE_FILES = new Set([
  'libs/papercusp/libs/db/src/schema/generated.ts',
  'libs/papercusp/libs/db/src/schema/schema.ts',
]);

export function isBuildOutput(rel) {
  if (GENERATED_SOURCE_FILES.has(rel)) return true;
  return rel.split('/').some((seg) => BUILD_OUTPUT_SEGMENTS.has(seg));
}

const SCAN_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js']);

/** A test file proves a field is reachable, never that anything ships using it. */
export function isTestFile(rel) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)(e2e|__tests__|__mocks__|test-fixtures)\//.test(rel);
}

// ── THE TARGETS ─────────────────────────────────────────────────────────────

/**
 * Every OPTIONAL field on `CellSpec`. Optional is the whole risk surface: a
 * required field cannot be silently unwritten, because omitting it fails to
 * compile. An optional one is exactly the field that can be declared, validated,
 * documented and never touched — which is what WI-6444 was.
 */
export const DECLARED_FIELDS = [
  {
    id: 'CellSpec.assessment',
    name: 'assessment',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration declaring `assessment: { path, codes, evidence }`',
    consumer:
      'cell-read.ts resolving that path + its evidence into the result `assessment` (+ state:read hoisting an UNAVAILABLE one into `summary` and listing `assessmentCodes` in the directory)',
    why: 'D-008. This field is the whole decision-ready half of a cell: the closed enum saying what the raw value MEANS and what is SAFE to do under it. Unconsumed, a caller is handed a bare number with its semantics silently dropped and falls back to inventing an interpretation — which is the precise failure the assessment replaced the falsifier to fix, since a falsifier could only ever say what NOT to conclude. Worse here than for most rows: the read contract can also report `status:"unavailable"`, so a DROPPED declaration is indistinguishable from a cell that honestly could not assess itself. It fails silently and in the confident direction.',
  },
  {
    id: 'CellSpec.unknownHoist',
    name: 'unknownHoist',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration setting `unknownHoist: <resultField>`',
    consumer: 'cell-read.ts emitting the hoisted field into the result',
    why: 'WI-6444 ITSELF. Declared on 6 cells and enforced at registration, but emitted by nothing — every nullable cell read as a bare `value: null` with the reason dropped. This row is the regression test for that fix: revert the cell-read.ts emission and this row MUST go red.',
  },
  {
    id: 'CellSpec.materiality',
    name: 'materiality',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration declaring `materiality: { path, why }`',
    consumer: 'cell-read.ts resolving `spec.materiality.path` against the resolver result',
    why: 'P-021. Materiality SUPPRESSES change notifications, so an unconsumed declaration is the worst kind: the author believes noise is being filtered and the subscriber is told nothing was filtered. It fails silently and in the confident direction.',
  },
  {
    id: 'CellSpec.doorProjections',
    name: 'doorProjections',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration declaring `doorProjections: [{ tool, path }]`',
    consumer: 'state-plane-stamp.ts projecting each alternate door into a re-read handle for the existing payload',
    why: 'P-017. An alternate door is a delivery alias, not a second resolver: if its declaration is never consumed, callers reaching the same value through release:deploy or another existing payload lose the registry-derived re-read handle and may transcribe a stale snapshot. It fails silently in the confident direction.',
  },
  {
    id: 'CellSpec.headlineSource',
    name: 'headlineSource',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration declaring `headlineSource: { path, authoritative, why }`',
    consumer: 'cell-read.ts resolving that path into the result `source` (+ state:read hoisting a non-authoritative reading into `summary`)',
    why: 'WI-36259. This field says whether the value in your hand was OBSERVED or INFERRED, so an unconsumed declaration hands the caller an inference wearing an observation\'s clothes — the exact misread that made the gate candidate cell report the ABANDONED sha for six days while CLAUDE.md swore it was marker-backed. It fails silently and in the confident direction.',
  },
  {
    id: 'CellSpec.ordered',
    name: 'ordered',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration declaring `ordered: { stages: [...] }`',
    consumer: 'cell-read.ts projecting the declared stage order into each value result',
    why: 'Axis 6. The stage order exists so a reader can say which of two positions is FURTHER ALONG. `readCell` now carries the declared order to callers as a value-result lens, so callers can rank or compare without importing the registry or hardcoding the sequence.',
  },
  {
    id: 'CellSpec.pointers',
    name: 'pointers',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: 'a cell registration declaring `pointers: [{ cell, when, answers }]`',
    consumer: 'cell-read.ts resolving each declared pointer into `pointers` on the read result (+ state:read rendering them via formatCellPointers)',
    why: 'P-006. A pointer is how one cell tells a reader "the value you want next lives THERE, and here is the call that re-answers it". Unconsumed, the reader is handed a volatile number with no handle attached and transcribes it instead of re-reading — which is the single most expensive misread class on this pipeline: a candidate sha or deploy position that is correct when copied and confidently wrong an hour later. It fails silently and in the confident direction.',
  },
  {
    id: 'CellSpec.registeredOn',
    name: 'registeredOn',
    declaredIn: 'packages/operator-core/lib/cell-registry.ts',
    producer: "a cell registration declaring `registeredOn: 'YYYY-MM-DD'` (cell-registrations.ts)",
    consumer: 'cell-tenure.ts deriving the tenure verdict from it (absent ⇒ `tenure-unknown`), plus agent-plane-measurement-sweep.ts projecting `{ cell, registeredOn }`',
    why: 'Tenure. Youth and dormancy produce an IDENTICAL zero in telemetry — a cell that was never read leaves no first-seen row to date it from — so without a declared registration date a cut rule cannot tell a three-day-old cell from an abandoned one. Measured: P-008 names `testing.census.population` and `testing.coverage.floor` as its first subjects; both were registered 2026-08-18, so on a 14-day window 11 of those days PREDATE THEIR EXISTENCE and the rule\'s first act would be to recommend cutting two three-day-old cells. Unconsumed, every cell silently degrades to `tenure-unknown` and the rule suppresses every cut while still reporting healthy — fail-closed, so it can only ever hide a cut rather than cause one, which is exactly what makes the breakage quiet.',
  },
];

/**
 * Every column added by the three migrations this plane shipped.
 *
 * `table` is not decoration — it is the scan filter. A file that never names the
 * table cannot be reading or writing its columns in SQL, and without that scope
 * a column called `summary` or `metrics` matches half the tree and the sweep
 * reports a confident pass built entirely from unrelated identifiers.
 */
export const DECLARED_COLUMNS = [
  // ── 689 — agent_facts append-versioning.
  { id: 'agent_facts.superseded_at', table: 'agent_facts', name: 'superseded_at', migration: '689-agent-facts-append-versioning.sql',
    why: 'P-008 (a). The append-version tombstone: every current-fact read filters on it. Unwritten, superseded facts stay live and a fold returns two contradictory versions of the same fact.' },
  { id: 'agent_facts.supersedes_id', table: 'agent_facts', name: 'supersedes_id', migration: '689-agent-facts-append-versioning.sql',
    why: 'The back-pointer that makes the version chain walkable. Without it a superseded fact is merely hidden, and "what did this fact say before" is unanswerable.' },

  // ── 694 — tool_invocations agent-state stamp.
  { id: 'tool_invocations.intent_event_id', table: 'tool_invocations', name: 'intent_event_id', migration: '694-tool-invocations-agent-state-stamp.sql',
    why: "P-010's divergence detector buckets calls by this id. No stamp, no buckets, and the detector reports the same clean zero a perfectly-disciplined fleet would." },
  { id: 'tool_invocations.assumption_set_id', table: 'tool_invocations', name: 'assumption_set_id', migration: '694-tool-invocations-agent-state-stamp.sql',
    why: 'WI-6465. P-024 cannot resolve the assumption set behind a historical call without it.' },
  { id: 'tool_invocations.goal_ref', table: 'tool_invocations', name: 'goal_ref', migration: '694-tool-invocations-agent-state-stamp.sql',
    why: '"What did this agent do while holding goal X" filters on it; unstamped calls are invisible to every postmortem.' },

  // ── 697 — agent_plane_measurements (P-015's own instrument).
  { id: 'agent_plane_measurements.workspace_id', table: 'agent_plane_measurements', name: 'workspace_id', migration: '697-agent-plane-measurements.sql',
    why: 'Tenant scope. An unfiltered read mixes workspaces into one meaningless series.' },
  { id: 'agent_plane_measurements.harness_slug', table: 'agent_plane_measurements', name: 'harness_slug', migration: '697-agent-plane-measurements.sql',
    why: 'The second half of the tenant key. Unread, one harness’s measurements are silently folded into another’s series, and the trend a reader draws is of two different planes averaged together.' },
  { id: 'agent_plane_measurements.measured_at', table: 'agent_plane_measurements', name: 'measured_at', migration: '697-agent-plane-measurements.sql',
    why: 'When the measurement was taken — the series order.' },
  { id: 'agent_plane_measurements.window_start', table: 'agent_plane_measurements', name: 'window_start', migration: '697-agent-plane-measurements.sql',
    why: 'The window described, as opposed to when it was taken. Both exist precisely so a reader comparing a lagging sweep\'s rows does not silently compare wall-clock instead.' },
  { id: 'agent_plane_measurements.window_end', table: 'agent_plane_measurements', name: 'window_end', migration: '697-agent-plane-measurements.sql',
    why: 'The other end of that window; unread, the guarantee above is not actually delivered.' },
  { id: 'agent_plane_measurements.metrics', table: 'agent_plane_measurements', name: 'metrics', migration: '697-agent-plane-measurements.sql',
    why: 'The composed PlaneMeasurement — the full funnel per metric. The row\'s entire payload.' },
  { id: 'agent_plane_measurements.interpretable_count', table: 'agent_plane_measurements', name: 'interpretable_count', migration: '697-agent-plane-measurements.sql',
    why: 'P-003 ratchets on this. It is the denormalised answer to "is the plane measurable yet?", and if nothing reads it the ratchet has nothing to ratchet on.' },
  { id: 'agent_plane_measurements.metric_count', table: 'agent_plane_measurements', name: 'metric_count', migration: '697-agent-plane-measurements.sql',
    why: 'The denominator of that ratio. A count of interpretable metrics without a total is not a measurement.' },
  { id: 'agent_plane_measurements.summary', table: 'agent_plane_measurements', name: 'summary', migration: '697-agent-plane-measurements.sql',
    why: 'The human-readable headline stored alongside the numbers.' },
  { id: 'agent_plane_measurements.producer_version', table: 'agent_plane_measurements', name: 'producer_version', migration: '697-agent-plane-measurements.sql',
    why: 'Bumped when a derivation changes, so a trend is never drawn across a definition change without the reader being able to see it happened. Unread, that is exactly what happens.' },
];

// ── SOURCE NORMALISATION ────────────────────────────────────────────────────

/**
 * Blank every comment, preserving byte offsets and line numbers so reported
 * line:col still points at real source. Closes vacuous pass (2).
 *
 * String and template literals are LEFT INTACT: SQL lives in template literals,
 * so blanking them would blank the very column references this gate counts.
 */
export function stripComments(src) {
  const out = new Array(src.length);
  let i = 0;
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') out[i] = ' ', i++;
      continue;
    }
    if (c === '/' && d === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) out[i] = blank(src[i]), i++;
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out[i] = c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out[i] = src[i]; i++; if (i < src.length) { out[i] = src[i]; i++; } continue; }
        out[i] = src[i]; i++;
      }
      if (i < src.length) { out[i] = c; i++; }
      continue;
    }
    out[i] = c; i++;
  }
  return out.join('');
}

/**
 * Blank the CONTENTS of single/double-quoted strings, keeping the quotes and the
 * length. Template literals survive untouched — they carry the SQL.
 *
 * Used only for the TS-field pass: a rejection message reading "`materiality`
 * must name a `path`" is prose that happens to live in a string, and counting it
 * is vacuous pass (2) wearing a different hat.
 */
export function blankQuotedStrings(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out[i] = ' '; i++; if (i < src.length) out[i] = ' '; i++; continue; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Line ranges (1-based, inclusive) covered by an `interface X { … }` or
 * `type X = { … }` body. A property inside one is a DECLARATION; the same text
 * outside one is an object-literal WRITE. Closes vacuous pass (1).
 *
 * Brace depth is counted on comment-stripped source, so a `{` in a docblock
 * cannot desynchronise the range.
 */
export function interfaceRanges(src) {
  const lines = src.split('\n');
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+\w|type\s+\w[\w<>,\s]*=)/.test(lines[i])) continue;
    // Only a BRACED body declares properties; `type X = 'a' | 'b';` declares none.
    let depth = 0;
    let opened = false;
    let j = i;
    for (; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') depth--;
      }
      if (opened && depth <= 0) break;
      // An unbraced type alias terminates at its `;` without ever opening.
      if (!opened && /;\s*$/.test(lines[j])) break;
    }
    if (opened) {
      ranges.push({ start: i + 1, end: Math.min(j, lines.length - 1) + 1 });
      i = j;
    }
  }
  return ranges;
}

const inRanges = (line, ranges) => ranges.some((r) => line >= r.start && line <= r.end);

/**
 * Normalise one file ONCE for every target.
 *
 * Not merely an optimisation: stripping and brace-scanning per (file × target)
 * is what made the first version of this sweep exceed two minutes on this tree.
 * Interface ranges are derived from the STRING-BLANKED text on purpose — a brace
 * inside a string literal (`'{ positions, stages[] }'` appears verbatim in
 * `cell-registrations.ts`) would otherwise desynchronise the depth count and
 * silently move every subsequent range.
 */
export function prepareSource(source) {
  const stripped = stripComments(source);
  const blanked = blankQuotedStrings(stripped);
  const lineStarts = [0];
  for (let i = 0; i < stripped.length; i++) if (stripped[i] === '\n') lineStarts.push(i + 1);
  return { stripped, blanked, ranges: interfaceRanges(blanked), lineStarts };
}

const prep = (s) => (typeof s === 'string' ? prepareSource(s) : s);

// ── CLASSIFIERS ─────────────────────────────────────────────────────────────

/**
 * Classify every occurrence of a TS property `name` in one file's source.
 * Returns `{ declarations, writes, reads }` of 1-based line numbers.
 *
 * The rules, in the order they are tried:
 *   · `name:` / `name?:` at the start of a line INSIDE an interface body  → declaration
 *   · `name:` at the start of a line outside one (object-literal property) → write
 *   · `.name =` with a single `=`                                          → write
 *   · `.name` anywhere else                                                → read
 *   · `const { … name … } =`                                               → read
 */
export function classifyTsField(source, name) {
  const { blanked: src, ranges } = prep(source);
  const lines = src.split('\n');
  const declarations = [];
  const writes = [];
  const reads = [];

  const propAtLineStart = new RegExp(`^\\s*(?:readonly\\s+)?${name}\\s*\\??\\s*:`);
  // `.name` NOT followed by `=` (but `==`/`===`/`=>` are comparisons, not writes).
  //
  // The `(?<!\.)` is load-bearing: without it the third dot of a SPREAD matches,
  // so `[...ordered.map(f)]` — a local array in an unrelated codegen script —
  // registered as a read of `CellSpec.ordered` and single-handedly turned the
  // field's verdict from write-only to consumed. A generic English word used as
  // a field name has no shortage of such collisions, which is why every rule
  // here has to be about SYNTAX rather than about text.
  const assign = new RegExp(`(?<!\\.)\\.\\s*${name}\\s*=(?!=|>)`);
  const access = new RegExp(`(?<!\\.)\\.\\s*${name}\\b`);
  const destructure = new RegExp(`\\{[^{}]*\\b${name}\\b[^{}]*\\}\\s*=[^=]`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (propAtLineStart.test(line)) {
      (inRanges(ln, ranges) ? declarations : writes).push(ln);
    }
    if (assign.test(line)) writes.push(ln);
    else if (access.test(line)) reads.push(ln);
    else if (destructure.test(line)) reads.push(ln);
  }
  return { declarations, writes, reads };
}

/** SQL clauses that put a column on the WRITE side of a statement. */
const SQL_WRITE_KEYWORDS = new Set(['insert into', 'set', 'do update set']);
const SQL_CLAUSE_RE = /\b(insert\s+into|do\s+update\s+set|set|select|where|and|or|from|join|on|returning|values|order\s+by|group\s+by|having|coalesce)\b/gi;

/**
 * Classify occurrences of a SQL `column` by the nearest preceding SQL clause
 * keyword — the cheapest thing that is actually *about* SQL rather than about
 * text. `SET col =` and an `INSERT INTO t (…col…)` column list are writes;
 * everything else naming the column (a `WHERE` predicate, a select list, a
 * `RETURNING`, a `.col` on a result row) is a read.
 *
 * Occurrences inside an interface body are skipped: `superseded_at: string | null`
 * in a row type mirrors the column, it does not touch it — vacuous pass (1)
 * again, in its SQL costume.
 */
export function classifySqlColumn(source, column) {
  const prepared = prep(source);
  const src = prepared.stripped;
  const writes = [];
  const reads = [];

  // Find the occurrences FIRST: the clause scan below is the expensive part, and
  // most files in a monorepo mention neither.
  const occ = new RegExp(`\\b${column}\\b`, 'g');
  const hits = [];
  for (let m; (m = occ.exec(src)); ) hits.push(m.index);
  if (hits.length === 0) return { writes, reads };

  const { ranges, lineStarts } = prepared;
  const clauses = [];
  SQL_CLAUSE_RE.lastIndex = 0;
  for (let m; (m = SQL_CLAUSE_RE.exec(src)); ) {
    clauses.push({ index: m.index, kw: m[1].toLowerCase().replace(/\s+/g, ' ') });
  }

  // Line lookup by binary search over precomputed starts: slicing the prefix per
  // occurrence is quadratic, and on this tree that alone cost minutes.
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  for (const index of hits) {
    const m = { index };
    const ln = lineOf(m.index);
    if (inRanges(ln, ranges)) continue;
    let lo = 0;
    let hi = clauses.length - 1;
    let nearest = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (clauses[mid].index < m.index) { nearest = clauses[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    (nearest && SQL_WRITE_KEYWORDS.has(nearest.kw) ? writes : reads).push(ln);
  }
  return { writes, reads };
}

// ── VERDICTS ────────────────────────────────────────────────────────────────

export const CONSUMPTION_VERDICTS = ['consumed', 'write-only', 'read-only', 'inert', 'not-declared'];

/**
 * Judge one target. Pure, so every distinction this gate exists to make is
 * unit-testable against literal source strings with no filesystem.
 *
 * ⚠ `not-declared` is neither pass nor fail-for-the-usual-reason — see the
 * header. It means the ROW is stale, not that the field lost its consumers.
 */
export function judgeConsumption({ declarations, writes, reads }) {
  if (!declarations || declarations <= 0) return 'not-declared';
  if (writes > 0 && reads > 0) return 'consumed';
  if (writes > 0) return 'write-only';
  if (reads > 0) return 'read-only';
  return 'inert';
}

/**
 * Roll judged rows up into an exit decision.
 *
 * A row carrying `knownUnbuilt` is REPORTED but does not fail the build: the gap
 * is already filed and owned, and re-failing for a known-open bug is how a gate
 * becomes noise the fleet routes around (WI-6464 nearly died that way). Deleting
 * the row to green the gate is the one response that is never acceptable — the
 * field stops being watched at exactly the moment it is known to be broken.
 */
export function rollupSweep(rows) {
  const bad = rows.filter((r) => r.verdict !== 'consumed' && r.verdict !== 'not-declared');
  return {
    consumed: rows.filter((r) => r.verdict === 'consumed').length,
    knownUnbuilt: bad.filter((r) => r.knownUnbuilt).length,
    stale: rows.filter((r) => r.verdict === 'not-declared'),
    failures: bad.filter((r) => !r.knownUnbuilt),
  };
}

// ── TREE WALK ───────────────────────────────────────────────────────────────

export function* walkSource(dir, rel = '') {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkSource(abs, r);
    } else if (e.isFile() && SCAN_EXT.has(path.extname(e.name))) {
      if (isTestFile(r)) continue;
      yield { abs, rel: r };
    }
  }
}

const ROOTS = ['packages', 'libs', 'apps', 'scripts', 'bin'];

/** Every identifier any target cares about — the cheap pre-filter in `main`. */
const TARGET_NAMES = [
  ...DECLARED_FIELDS.map((t) => t.name),
  ...DECLARED_COLUMNS.map((t) => t.name),
];

async function main() {
  const files = [];
  for (const root of ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
    for (const f of walkSource(abs, root)) files.push(f);
  }

  const rows = [];
  let generated = 0;
  const fieldAcc = new Map(DECLARED_FIELDS.map((t) => [t.id, { declarations: [], writes: [], reads: [] }]));
  const columnAcc = new Map(DECLARED_COLUMNS.map((t) => [t.id, { writes: [], reads: [] }]));

  // ONE pass over the tree: each file is read once and offered to every target.
  for (const f of files) {
    let src;
    try { src = readFileSync(f.abs, 'utf8'); } catch { continue; }
    // Cheap gate before the expensive normalisation: most files name no target.
    if (!TARGET_NAMES.some((n) => src.includes(n))) continue;
    if (isBuildOutput(f.rel) || looksGenerated(src)) { generated++; continue; }
    const prepared = prepareSource(src);

    for (const target of DECLARED_FIELDS) {
      if (!src.includes(target.name)) continue;
      const acc = fieldAcc.get(target.id);
      const c = classifyTsField(prepared, target.name);
      for (const ln of c.declarations) acc.declarations.push(`${f.rel}:${ln}`);
      // Vacuous pass (3): the declaring module never counts as its own consumer.
      if (f.rel === target.declaredIn) continue;
      for (const ln of c.writes) acc.writes.push(`${f.rel}:${ln}`);
      for (const ln of c.reads) acc.reads.push(`${f.rel}:${ln}`);
    }

    for (const target of DECLARED_COLUMNS) {
      // Scope: only a file that names the TABLE can be touching its columns.
      if (!src.includes(target.table) || !src.includes(target.name)) continue;
      const acc = columnAcc.get(target.id);
      const c = classifySqlColumn(prepared, target.name);
      for (const ln of c.writes) acc.writes.push(`${f.rel}:${ln}`);
      for (const ln of c.reads) acc.reads.push(`${f.rel}:${ln}`);
    }
  }

  for (const target of DECLARED_FIELDS) {
    const acc = fieldAcc.get(target.id);
    rows.push({
      ...target,
      kind: 'field',
      sites: acc,
      verdict: judgeConsumption({ declarations: acc.declarations.length, writes: acc.writes.length, reads: acc.reads.length }),
    });
  }

  for (const target of DECLARED_COLUMNS) {
    const acc = columnAcc.get(target.id);
    // A column's DECLARATION is its migration — the static analogue of `no-data`.
    let declared = 0;
    try {
      const mig = readFileSync(path.join(REPO_ROOT, 'libs/papercusp/libs/db/sql', target.migration), 'utf8');
      declared = new RegExp(`\\b${target.name}\\b`).test(mig) ? 1 : 0;
    } catch { declared = 0; }
    rows.push({
      ...target,
      kind: 'column',
      sites: { declarations: declared ? [target.migration] : [], ...acc },
      verdict: judgeConsumption({ declarations: declared, writes: acc.writes.length, reads: acc.reads.length }),
    });
  }

  const roll = rollupSweep(rows);
  const mark = { consumed: '✓', 'write-only': '✗', 'read-only': '✗', inert: '✗', 'not-declared': '?' };

  console.log('\nDECLARED-VS-CONSUMED SWEEP — agent-state plane (P-002)\n');
  console.log(`  scanned ${files.length} non-test source files under ${ROOTS.join(', ')} (${generated} generated/minified skipped)\n`);
  for (const r of rows) {
    const w = r.sites.writes.length;
    const rd = r.sites.reads.length;
    console.log(`  ${mark[r.verdict]} ${r.id.padEnd(44)} ${String(w).padStart(3)}W ${String(rd).padStart(4)}R   ${r.verdict}`);
    if (r.verdict === 'consumed') continue;
    if (r.verdict === 'not-declared') {
      console.log(`      NOT DECLARED — this row matches no declaration site. The field was renamed or`);
      console.log(`      removed, so this gate has been watching nothing. Fix the ROW, not the code.`);
      continue;
    }
    console.log(`      writer:  ${r.producer ?? 'an INSERT/UPDATE naming the column'}${w ? ` — ${r.sites.writes.slice(0, 3).join(', ')}` : ' — NONE FOUND'}`);
    console.log(`      reader:  ${r.consumer ?? 'a SELECT/WHERE naming the column'}${rd ? ` — ${r.sites.reads.slice(0, 3).join(', ')}` : ' — NONE FOUND'}`);
    console.log(`      breaks:  ${r.why}`);
    if (r.knownUnbuilt) console.log(`      KNOWN:   ${r.knownUnbuilt} — reported, not failing the build`);
  }

  console.log(
    `\n  ${roll.consumed} consumed · ${roll.failures.length} UNCONSUMED · ${roll.knownUnbuilt} known-unbuilt · ${roll.stale.length} stale-row\n`,
  );

  if (roll.stale.length > 0) {
    console.error('✗ declared-vs-consumed: a row in this gate matches no declaration — it is watching nothing.\n');
    for (const f of roll.stale) console.error(`    ${f.id}`);
    process.exitCode = 1;
    return;
  }
  if (roll.failures.length > 0) {
    console.error('✗ declared-vs-consumed: a declared field/column is missing a live reader or writer.\n');
    for (const f of roll.failures) console.error(`    ${f.id} — ${f.verdict}`);
    console.error(
      '\n  This is the WI-6444 defect class: a field that is declared, validated and\n' +
        '  documented, with one end of the wire never connected. Either wire the missing\n' +
        '  end, or file the gap and add its ref as `knownUnbuilt` so the sweep reports it\n' +
        '  instead of failing — but do NOT delete the row to green the gate.\n',
    );
    process.exitCode = 1;
    return;
  }
  // Say exactly what was established. With a knownUnbuilt row in the report,
  // "everything has a reader and a writer" is FALSE — and a gate that overstates
  // its own result on the happy path is the same defect, one level up, as the
  // fields it is here to police.
  if (roll.knownUnbuilt > 0) {
    console.log(
      `✓ no NEW unconsumed declaration — but ${roll.knownUnbuilt} filed gap${roll.knownUnbuilt === 1 ? '' : 's'} above ` +
        `${roll.knownUnbuilt === 1 ? 'is' : 'are'} still unconsumed and reported, not fixed.\n`,
    );
    return;
  }
  console.log('✓ every declared field/column of this plane has both a live writer and a live reader.\n');
}

// Only run when invoked directly — the predicates above are imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('declared-vs-consumed sweep failed to run:', err?.message ?? err);
    process.exitCode = 1;
  });
}
