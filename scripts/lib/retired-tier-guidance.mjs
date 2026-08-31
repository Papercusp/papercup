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
];

export const ACTIVE_RETIRED_GUIDANCE_FILES = [
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
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

function walkGuidanceRoot(root, acc) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || /^dist(?:-|$)/.test(entry.name)) continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkGuidanceRoot(abs, acc);
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
    walkGuidanceRoot(absoluteRoot, absoluteFiles);
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
