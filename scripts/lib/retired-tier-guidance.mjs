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

export const ACTIVE_RETIRED_GUIDANCE_ROOTS = [
  "templates/papercusp-app",
  "templates/papercusp-ops-pots",
];

export const ACTIVE_RETIRED_GUIDANCE_FILES = [
  "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
];

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
  /(?:\b(?:queen|mug|kettle)\b.{0,100}\b(?:executor|orchestrator|dispatcher|supervisor|decider|execution role|placement role)\b|\b(?:executor|orchestrator|dispatcher|supervisor|decider|execution role|placement role)\b.{0,100}\b(?:queen|mug|kettle)\b)/i;
const EXPLICIT_NON_CURRENT_RE =
  /\b(?:retir(?:e[sd]?|ing|ement)|historical(?:ly)?|legacy|former(?:ly)?|obsolete|deprecated|removed|deleted|no longer|replaced|previous(?:ly)?|once)\b/i;
const EXPLICIT_REFUSAL_RE =
  /\b(?:do not|don't|never|must not|cannot|can't|refus\w*|forbid\w*|unsupported|not supported|not current|not the same|not a fallback)\b/i;
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
    if (
      !EXECUTION_RE.test(segment.text) &&
      !EXECUTOR_NOUN_RE.test(segment.text)
    )
      continue;

    const nonCurrentAt = EXPLICIT_NON_CURRENT_RE.exec(segment.text)?.index;
    const refusalAt = EXPLICIT_REFUSAL_RE.exec(segment.text)?.index;
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
        "active guidance prescribes a retired Queen/Mug/Kettle execution role without an explicit historical or refusal marker",
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
          fs.readFileSync(absoluteFile, "utf8"),
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
