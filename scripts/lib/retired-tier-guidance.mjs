/**
 * Pure detector used by `lint:no-ungated-mug-kettle` for CURRENT agentic guidance.
 *
 * Runtime entry points remain a shrink-only ratchet in the parent guard. Guidance is
 * different: an active template or the current su prompt must never prescribe the retired
 * Queen/Mug/Kettle execution model. There is deliberately no baseline for this family.
 * Explicit retirement/history/refusal prose is allowed so the system can explain the
 * cutover without erasing its audit trail.
 */

import fs from "node:fs";
import path from "node:path";
import { stripCommentsOnly } from "./strip-comments-and-strings.mjs";

/**
 * WI-1713506 — in a PROSE file (.md/.yaml) the whole file is guidance. In a CODE
 * file only the emitted STRING LITERALS ever reach an agent; the comments are
 * documentation for engineers, and an engineer's note explaining what the Queen
 * used to do is not a live instruction to anybody.
 *
 * Scanning code files raw makes this guard fire ~40 times across
 * packages/operator-core/lib/scout on historical block comments — which is how a
 * guard earns a baseline and stops being read. `stripCommentsOnly` is
 * LENGTH-PRESERVING (it blanks ranges in place), so reported line numbers stay
 * exact while the comment noise disappears and the actual prompt text remains.
 */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

/**
 * WI-1726926 — EXPORTED so a census can drive the detector faithfully.
 *
 * `findRetiredGuidanceOffenders` is pure but takes ALREADY-NORMALIZED text, so calling
 * it directly on raw source silently re-enables the comment scanning the block above
 * exists to prevent. Measured 2026-08-31: a corpus census that called the detector
 * directly reported 1,325 offenders / 458 files where the real population is a fraction
 * of that — the over-count is entirely historical block comments, exactly the ~40-per-
 * scout-dir noise described above, generalized to the whole tree. The census then reads
 * as "this guard is unwidenable" and the widening gets abandoned for the wrong reason.
 *
 * Re-implementing the normalization in the caller is the other wrong fix: it is a second
 * copy of a truth this module owns, and it drifts the moment CODE_EXTENSIONS changes.
 * Import this instead.
 */
export function guidanceTextFor(relativeFile, source) {
  if (!CODE_EXTENSIONS.has(path.extname(relativeFile).toLowerCase()))
    return source;
  try {
    return stripCommentsOnly(source, relativeFile);
  } catch {
    // Fail OPEN, deliberately: an unparseable file is scanned raw rather than
    // skipped. A guard that silently drops a file it could not parse reports a
    // clean bill for text it never inspected.
    return source;
  }
}

export const ACTIVE_RETIRED_GUIDANCE_ROOTS = [
  "templates/papercusp-app",
  "templates/papercusp-ops-pots",
  // WI-1713506: agent-facing guidance is not only .md. The Scout/Blender rails
  // BUILD prompt text in TypeScript — SCOUT_DRAFT_LOOP_NOTE is stamped into every
  // routed draft's `## Now`, SCOUT_FEEDBACK_LOOP_GUIDANCE is injected into the
  // Blender revision cycle, and the draft-review watchdog composes the nudge an su
  // actually receives. Those strings are read by agents exactly like a prompt file,
  // so they belong in this corpus; leaving them out is why "Mug reviews this
  // proposal" survived the Mug's retirement and stranded a draft for 1d 13h.
  "packages/operator-core/lib/scout",
  // WI-1756049 — the tool CATALOG is agent-facing guidance by the same WI-1713506
  // reasoning: a tool's `description` + `guidance.{when,notWhen,chaining}` are
  // injected into the MCP catalog of every agent that carries it, so they are read
  // exactly like a prompt file. These two directories are the autonomy gate and its
  // decision ledger.
  //
  // Until 2026-08-31 all 8 of their tools attributed themselves to the RETIRED Mug
  // ("Log the Mug's disposition…", `when: "You are the Mug and you've DECIDED…"`),
  // while the live callers are operator/su — measured, not assumed:
  //   autonomy:record_disposition | operator | 29 calls | last 2026-08-29
  //   decision_ledger:list        | operator |  3 calls | last 2026-08-30
  //   (zero calls by role 'mug'; neither dir carries a MUG_KETTLE_SYSTEM gate)
  // So the subsystem OUTLIVED the tier — D-060 says rewrite, not retire — and the
  // su playbook meanwhile directs su to autonomy:record_disposition, i.e. the
  // persona said "record it here" while the tool said "you are not the caller".
  //
  // ⚠ `autonomy/decide.ts` still names `kettle`, and that is CORRECT: OVERWATCH_ROLE
  // === "kettle" (lib/overwatch/liveness.ts:42) is LIVE Overwatch's wire identifier,
  // not tier residue. It reads clean here because the prose says so explicitly.
  // Do not "fix" that comparison to "overwatch" — see the header note in decide.ts.
  //
  // ⚠ Admitted ONLY after measuring at zero AND calibrating the detector against a
  // known-bad positive control in these same files (0 clean / >0 with a mutant
  // injected). A zero from an uncalibrated instrument is not evidence.
  //
  // The WHOLE tool catalog is admitted, minus the directories still listed in
  // ACTIVE_RETIRED_GUIDANCE_PENDING. Measured 2026-08-31: 107 of the 134
  // subdirectories were ALREADY at zero, so naming the 27 dirty ones is both far
  // smaller than naming the clean ones and — the reason it is done this way —
  // makes a NEW tool directory part of the corpus BY DEFAULT.
  //
  // That inversion is the actual fix for this work-item's subject. Under an
  // allow-list, every new agent-facing surface sits outside the corpus until
  // somebody remembers to add it, which is precisely how the routing gate kept
  // offering a retired recipient to every su for the whole retirement.
  "packages/operator-core/lib/agent-tools",
];

export const ACTIVE_RETIRED_GUIDANCE_FILES = [
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
  // WI-1726926 — the same WI-1713506 reasoning as `lib/scout` above, applied to the
  // three highest-blast-radius prompt BUILDERS in the tree. `deriveLaunchPromptText`
  // composes the routing-gate kickoff and is consumed by plans/launch.ts, bootstrap-su
  // AND carry-respawn, so its text reaches essentially every su; the other two compose
  // the launch/respawn context around it.
  //
  // Added because the corpus gap was not hypothetical here: until 2026-08-31 the
  // routing gate offered "(B) hand it to the Mug" — a retired recipient no agent could
  // reach — in BOTH profiles, and it survived the tier's entire retirement because
  // nothing scanned this file (EI-21972876172423322).
  //
  // ⚠ ADDED ONLY AFTER MEASURING EACH AT ZERO OFFENDERS. This family has no baseline
  // by design, so a path admitted while still dirty turns the ~93s gate leg red on
  // arrival and the guard gets waived instead of obeyed — the exact "earns a baseline,
  // stops being read" failure comment-stripping was added to avoid. Measure first,
  // widen second; that ordering is the rule, not a courtesy.
  "packages/operator-core/lib/agent-tools/plans/launch-prompt.ts",
  "packages/operator-core/lib/carry-respawn.ts",
  "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts",
];

/**
 * WI-1713506 — sites where a retired role name is DATA, not an instruction.
 *
 * Deliberately ANCHORED rather than a blanket file pass: an entry suppresses only
 * segments containing its `anchor`, so the same file still fails if it later grows
 * real guidance. A bare filename exemption would have silently covered that too,
 * which is how allowlists rot into blindfolds.
 */
export const ACTIVE_RETIRED_GUIDANCE_EXEMPTIONS = [
  {
    file: "packages/operator-core/lib/scout/router.ts",
    anchor: "WHOLE_SYSTEM_MARKERS",
    reason:
      "A CLASSIFIER keyword list. The router matches incoming idea TEXT against these strings to decide whether an idea is whole-system; 'queen prompt'/'queen persona'/'queen placement' are inputs to be recognized, not work to be assigned. Dropping them would stop classifying the legacy ideas that still use that vocabulary — the retirement did not un-write the corpus.",
  },
];

function isExemptSegment(file, segmentText) {
  return ACTIVE_RETIRED_GUIDANCE_EXEMPTIONS.some(
    (entry) => entry.file === file && segmentText.includes(entry.anchor),
  );
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "_retired",
  "build",
  "coverage",
  "dist",
  ".next",
]);
const TEST_FILE_RE =
  /(?:^|\/)(?:__tests__\/|checks\/.*\.(?:test|spec)\.)|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const ROLE_RE = /\b(?:queen|mug|kettle)\b/i;
const ROLE_RE_GLOBAL = /\b(?:queen|mug|kettle)\b/gi;
const EXECUTION_RE =
  /\b(?:use[sd]?|using|launch(?:es|ed|ing)?|spawn(?:s|ed|ing)?|run(?:s|ning)?|execut(?:e|es|ed|ing)|orchestrat\w*|dispatch(?:es|ed|ing)?|assign(?:s|ed|ing|ment)?|plac(?:e|es|ed|ing)|schedul(?:e|es|ed|ing)|wak(?:e|es|ed|ing)|supervis\w*|survey(?:s|ed|ing)?|triag(?:e|es|ed|ing)|rout(?:e|es|ed|ing)|manag(?:e|es|ed|ing)|steer(?:s|ed|ing)?|decid(?:e|es|ed|ing)|own(?:s|ed|ing)?|watch(?:es|ed|ing)?)\b/i;
const EXECUTOR_NOUN_RE =
  /(?:\b(?:queen|mug|kettle)\b.{0,100}\b(?:executor|orchestrator|dispatcher|supervisor|decider|execution role|placement role|reviewer|approver|greenlighter)\b|\b(?:executor|orchestrator|dispatcher|supervisor|decider|execution role|placement role|reviewer|approver|greenlighter)\b.{0,100}\b(?:queen|mug|kettle)\b)/i;
/**
 * WI-1713506 — the SECOND blind spot, and the one that actually bit.
 *
 * EXECUTION_RE is placement-shaped: launch / spawn / dispatch / place / schedule.
 * It answers "does this text tell someone to RUN work through a retired tier?".
 * It cannot see the other half of a role's power — AUTHORITY: who may review,
 * promote, greenlight, ratify, approve, dispose of, or drain a queue. Assigning
 * *that* to a dead role is just as harmful and fails more quietly: nothing crashes,
 * the work simply waits forever for a reviewer that cannot exist.
 *
 * Measured instance: `SCOUT_DRAFT_LOOP_NOTE` said "Mug reviews this proposal … it
 * promotes it to greenlight (ready)". Zero EXECUTION_RE verbs, so the guard would
 * have passed it even with the corpus above — and a real draft sat unreviewed for
 * 1d 13h while an su read that note and believed a Mug would drain it.
 */
const AUTHORITY_RE =
  /\b(?:review(?:s|ed|ing|er)?|promot(?:e|es|ed|ing|ion)|greenlight(?:s|ed|ing)?|ratif(?:y|ies|ied|ying)|approv(?:e|es|ed|ing|al)|dispos(?:e|es|ed|ing|ition)|drain(?:s|ed|ing)?|consum(?:e|es|ed|ing)|grad(?:e|es|ed|ing)|sign(?:s|ed)?[-\s]off|gatekeep\w*)\b/i;
const EXPLICIT_NON_CURRENT_RE =
  /\b(?:retir(?:e[sd]?|ing|ement)|historical(?:ly)?|legacy|former(?:ly)?|obsolete|deprecated|removed|deleted|no longer|replaced|previous(?:ly)?|once)\b/i;
const EXPLICIT_REFUSAL_RE =
  /\b(?:do not|don't|never|must not|cannot|can't|refus\w*|forbid\w*|unsupported|not supported|not current|not the same|not a fallback)\b/i;
const EXPLICIT_REFUSAL_RE_GLOBAL =
  /\b(?:do not|don't|never|must not|cannot|can't|refus\w*|forbid\w*|unsupported|not supported|not current|not the same|not a fallback)\b/gi;
/**
 * How far after a refusal word we look for the thing it governs. Short on purpose:
 * long enough for "never route work to the Mug", short enough that an unrelated role
 * mention later in the same sentence cannot adopt the negation.
 *
 * A raw character count is NOT sufficient on its own, and the failure is instructive:
 * "...so the Queen was never idle). Review each and either promote it..." puts the
 * unrelated word "Review" 13 characters after `never`, so a pure-distance window let
 * an incidental negation adopt the NEXT sentence's verb and exempt the segment. The
 * window is therefore clause-bounded FIRST — a negation cannot reach past the
 * punctuation that ends its own clause — with the character cap as a backstop.
 */
const REFUSAL_GOVERNS_WINDOW = 30;
const CLAUSE_END_RE = /[.;:)\n]|—/;

/**
 * WI-1723896 — a refusal marker must REFUSE SOMETHING.
 *
 * The bug: EXPLICIT_REFUSAL_RE matched a bare `never` ANYWHERE in the segment and
 * exempted the whole thing. draft-review-watchdog.ts emits, at runtime, "the
 * plan-review idle activity never ran — the hive has been saturated, so the Queen
 * was never idle" — two incidental `never`s, neither of them a refusal, and the
 * guard read them as "this text explains that the role is not current" and stayed
 * silent on a live string naming a retired role as the current actor.
 *
 * The fix: a refusal word only earns marker status when it GOVERNS a role or an
 * execution/authority verb within a short window — "never route to the Mug" counts,
 * "was never idle" does not. Note this only ever makes the guard MORE willing to
 * flag, which is the safe direction: a false positive is an argument, a false
 * negative is a silence.
 *
 * EXPLICIT_NON_CURRENT_RE is deliberately NOT tightened the same way. Those are
 * STATE words about the role ("the Mug is retired"), where the thing being described
 * sits BEFORE the marker, so requiring a governed object after it would break the
 * ordinary, correct phrasing this guard exists to permit.
 */
function qualifyingRefusalIndex(text) {
  EXPLICIT_REFUSAL_RE_GLOBAL.lastIndex = 0;
  for (const match of text.matchAll(EXPLICIT_REFUSAL_RE_GLOBAL)) {
    const start = (match.index ?? 0) + match[0].length;
    const capped = text.slice(start, start + REFUSAL_GOVERNS_WINDOW);
    const clauseEnd = capped.search(CLAUSE_END_RE);
    const governed = clauseEnd >= 0 ? capped.slice(0, clauseEnd) : capped;
    if (
      ROLE_RE.test(governed) ||
      EXECUTION_RE.test(governed) ||
      AUTHORITY_RE.test(governed) ||
      EXECUTOR_NOUN_RE.test(governed)
    )
      return match.index ?? 0;
  }
  return undefined;
}
const ADVERSATIVE_RE = /\b(?:but|however|still|yet|nevertheless|except)\b/gi;

/** Keep a Markdown/YAML list item together while separating neighboring policy statements. */
export function guidanceSegments(source) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  let current = [];
  let startLine = 1;

  const flush = () => {
    if (current.length > 0)
      segments.push({ line: startLine, text: current.join("\n") });
    current = [];
  };
  const startsStatement = (line) =>
    /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|\|)/.test(line);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      flush();
      continue;
    }
    if (current.length > 0 && startsStatement(line)) flush();
    if (current.length === 0) startLine = index + 1;
    current.push(line);
  }
  flush();
  return segments;
}

function positiveCountermandAfterHistory(segment, markerIndex) {
  ADVERSATIVE_RE.lastIndex = 0;
  for (const match of segment.matchAll(ADVERSATIVE_RE)) {
    if ((match.index ?? 0) <= markerIndex) continue;
    const tail = segment.slice((match.index ?? 0) + match[0].length);
    if (
      ROLE_RE.test(tail) &&
      (EXECUTION_RE.test(tail) || EXECUTOR_NOUN_RE.test(tail))
    )
      return true;
  }
  return false;
}

/** Return every current-execution recommendation in one text file. */
export function findRetiredGuidanceOffenders(file, source) {
  const offenders = [];
  for (const segment of guidanceSegments(source)) {
    const roleMatch = ROLE_RE.exec(segment.text);
    if (!roleMatch) continue;
    if (isExemptSegment(file, segment.text)) continue;
    if (
      !EXECUTION_RE.test(segment.text) &&
      !EXECUTOR_NOUN_RE.test(segment.text) &&
      !AUTHORITY_RE.test(segment.text)
    )
      continue;

    const nonCurrentAt = EXPLICIT_NON_CURRENT_RE.exec(segment.text)?.index;
    const refusalAt = qualifyingRefusalIndex(segment.text);
    const markerIndexes = [nonCurrentAt, refusalAt].filter(
      (index) => index !== undefined,
    );
    const markerIndex =
      markerIndexes.length > 0 ? Math.min(...markerIndexes) : -1;
    if (
      markerIndex >= 0 &&
      !positiveCountermandAfterHistory(segment.text, markerIndex)
    )
      continue;

    const roleLine =
      segment.line +
      segment.text.slice(0, roleMatch.index).split("\n").length -
      1;
    const roles = [
      ...new Set(
        [...segment.text.matchAll(ROLE_RE_GLOBAL)].map((match) =>
          match[0].toLowerCase(),
        ),
      ),
    ];
    offenders.push({
      category: "current-guidance",
      file,
      line: roleLine,
      roles,
      detail:
        "active guidance assigns a retired Queen/Mug/Kettle role an execution OR authority (review/promote/greenlight/dispose) responsibility without an explicit historical or refusal marker",
      excerpt: segment.text.replace(/\s+/g, " ").trim().slice(0, 260),
    });
  }
  return offenders;
}

/**
 * WI-1726926 — directories INSIDE an admitted root that are not clean yet.
 *
 * This exists so a root can be admitted at its CURRENT cleanliness instead of
 * waiting for the whole subtree, and the ordering rule survives: a path still
 * enters the corpus only when its own population is zero.
 *
 * It is a BACKLOG, not a blessing, and three things keep it from rotting into
 * the blindfold that allowlists usually become:
 *   1. every entry carries the offender count MEASURED when it was added, so a
 *      reader can see the debt rather than just the exemption;
 *   2. `pendingRootStatus()` re-measures them, and the guard test FAILS when an
 *      entry has reached zero — so cleaning a directory forces its promotion
 *      instead of quietly leaving it excluded forever; and
 *   3. it is a DENY list under an admitted root, so anything NEW is covered by
 *      DEFAULT. That inversion is the whole point: under the old allow-list
 *      shape a newly added directory sat outside the corpus until somebody
 *      remembered it, which is exactly how `plans/launch-prompt.ts` kept
 *      offering "(B) hand it to the Mug" through the tier's entire retirement
 *      (EI-21972876172423322).
 */
export const ACTIVE_RETIRED_GUIDANCE_PENDING = [
  { path: "packages/operator-core/lib/agent-tools/pot", offenders: 20 },
  { path: "packages/operator-core/lib/agent-tools/coordination", offenders: 13 },
  { path: "packages/operator-core/lib/agent-tools/dev", offenders: 6 },
  { path: "packages/operator-core/lib/agent-tools/fleet", offenders: 5 },
  { path: "packages/operator-core/lib/agent-tools/fleet_registry", offenders: 5 },
  { path: "packages/operator-core/lib/agent-tools/improvements", offenders: 4 },
  { path: "packages/operator-core/lib/agent-tools/plans", offenders: 4 },
  { path: "packages/operator-core/lib/agent-tools/release", offenders: 4 },
  { path: "packages/operator-core/lib/agent-tools/work_items", offenders: 4 },
  { path: "packages/operator-core/lib/agent-tools/config", offenders: 2 },
  { path: "packages/operator-core/lib/agent-tools/deploy", offenders: 2 },
  { path: "packages/operator-core/lib/agent-tools/gym", offenders: 2 },
  { path: "packages/operator-core/lib/agent-tools/scout", offenders: 2 },
  { path: "packages/operator-core/lib/agent-tools/capability", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/change_ledger", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/db", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/knowledge_packs", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/learning", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/loop", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/merge", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/recipes", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/review", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/routines", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/rubrics", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/scheduler", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/scorecards", offenders: 1 },
  { path: "packages/operator-core/lib/agent-tools/slash", offenders: 1 },
];

const PENDING_PATHS = new Set(
  ACTIVE_RETIRED_GUIDANCE_PENDING.map((entry) => entry.path),
);

function isPendingPath(repoRelative) {
  if (PENDING_PATHS.has(repoRelative)) return true;
  for (const pending of PENDING_PATHS) {
    if (repoRelative.startsWith(`${pending}/`)) return true;
  }
  return false;
}

function walkGuidanceRoot(root, acc, repoRoot) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || /^dist(?:-|$)/.test(entry.name)) continue;
    const abs = path.join(root, entry.name);
    if (
      repoRoot !== undefined &&
      isPendingPath(path.relative(repoRoot, abs).split(path.sep).join("/"))
    )
      continue;
    if (entry.isDirectory()) {
      walkGuidanceRoot(abs, acc, repoRoot);
      continue;
    }
    const normalized = abs.split(path.sep).join("/");
    if (
      !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ||
      TEST_FILE_RE.test(normalized)
    )
      continue;
    acc.push(abs);
  }
}

/**
 * WI-1726926 — RE-MEASURE every pending directory so the backlog cannot rot.
 *
 * Returns one row per `ACTIVE_RETIRED_GUIDANCE_PENDING` entry with the offender
 * count it holds RIGHT NOW. `graduated: true` means the directory is clean and
 * its entry must be deleted (which admits it to the corpus) — the guard test
 * fails on any graduated row, so cleaning a directory and leaving it excluded
 * is not a reachable end state.
 *
 * `missing: true` means the path no longer exists (moved/retired) — also a
 * failure, because a stale entry silently excludes nothing while looking like
 * it still guards something.
 */
export function pendingRootStatus(repoRoot) {
  return ACTIVE_RETIRED_GUIDANCE_PENDING.map((entry) => {
    const absolute = path.join(repoRoot, entry.path);
    if (!fs.existsSync(absolute))
      return { ...entry, current: 0, graduated: false, missing: true };
    const files = [];
    walkGuidanceRoot(absolute, files, undefined);
    let current = 0;
    for (const absoluteFile of files) {
      const relativeFile = path
        .relative(repoRoot, absoluteFile)
        .split(path.sep)
        .join("/");
      try {
        current += findRetiredGuidanceOffenders(
          relativeFile,
          guidanceTextFor(relativeFile, fs.readFileSync(absoluteFile, "utf8")),
        ).length;
      } catch {
        // A read error here is not a cleanliness signal; collectActiveRetiredGuidance
        // is the surface that reports readErrors.
      }
    }
    return { ...entry, current, graduated: current === 0, missing: false };
  });
}

/** Scan only maintained CURRENT guidance; historical docs/plans are outside this corpus by design. */
export function collectActiveRetiredGuidance(repoRoot) {
  const absoluteFiles = [];
  const missingPaths = [];
  const readErrors = [];

  for (const relativeRoot of ACTIVE_RETIRED_GUIDANCE_ROOTS) {
    const absoluteRoot = path.join(repoRoot, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) {
      missingPaths.push(relativeRoot);
      continue;
    }
    walkGuidanceRoot(absoluteRoot, absoluteFiles, repoRoot);
  }
  for (const relativeFile of ACTIVE_RETIRED_GUIDANCE_FILES) {
    const absoluteFile = path.join(repoRoot, relativeFile);
    if (!fs.existsSync(absoluteFile)) missingPaths.push(relativeFile);
    else absoluteFiles.push(absoluteFile);
  }

  const files = [...new Set(absoluteFiles)].sort();
  const offenders = [];
  for (const absoluteFile of files) {
    const relativeFile = path
      .relative(repoRoot, absoluteFile)
      .split(path.sep)
      .join("/");
    try {
      offenders.push(
        ...findRetiredGuidanceOffenders(
          relativeFile,
          guidanceTextFor(relativeFile, fs.readFileSync(absoluteFile, "utf8")),
        ),
      );
    } catch (error) {
      readErrors.push({
        file: relativeFile,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    filesScanned: files.length,
    missingPaths: missingPaths.sort(),
    readErrors,
    offenders,
  };
}
