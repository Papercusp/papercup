#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

function mergeLineRanges(ranges) {
  return [...ranges]
    .sort((left, right) => left.startLine - right.startLine)
    .reduce((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.startLine <= previous.endLine + 1) {
        previous.endLine = Math.max(previous.endLine, range.endLine);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
}

/** Return the added line ranges from a zero-context unified diff. */
export function parseAddedLineRanges(diff) {
  const ranges = [];
  for (const match of diff.matchAll(HUNK_RE)) {
    const startLine = Number(match[1]);
    const lineCount = Number(match[2] ?? 1);
    if (lineCount > 0) {
      ranges.push({ startLine, endLine: startLine + lineCount - 1 });
    }
  }
  return mergeLineRanges(ranges);
}

function lineStartOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

/** Convert a one-based inclusive line range into Prettier character offsets. */
export function characterRangeForLines(source, range) {
  const offsets = lineStartOffsets(source);
  const startLine = Math.min(Math.max(range.startLine, 1), offsets.length);
  const endLine = Math.min(Math.max(range.endLine, startLine), offsets.length);
  return {
    start: offsets[startLine - 1],
    end: endLine < offsets.length ? offsets[endLine] : source.length,
  };
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function isTracked(repoPath) {
  const result = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "--", repoPath],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function changedLineRanges(repoPath, source) {
  if (!isTracked(repoPath)) {
    return source.length === 0
      ? []
      : [{ startLine: 1, endLine: lineStartOffsets(source).length }];
  }
  return parseAddedLineRanges(
    git([
      "diff",
      "--no-ext-diff",
      "--unified=0",
      "--no-color",
      "HEAD",
      "--",
      repoPath,
    ]),
  );
}

const RANGE_CHECK_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

/** Validate and normalize explicit in-repository file paths. */
export function normalizeScopedPaths(args) {
  const rawPaths = args[0] === "--" ? args.slice(1) : args;
  if (rawPaths.length === 0) {
    throw new Error(
      "provide one or more explicit file paths after `npm run format:check:scoped --`",
    );
  }

  return rawPaths.map((rawPath) => {
    if (!rawPath || rawPath.startsWith("-") || /[*?{}[\]!]/.test(rawPath)) {
      throw new Error(
        `format check accepts explicit file paths only: ${rawPath || "<empty>"}`,
      );
    }
    const absolutePath = resolve(REPO_ROOT, rawPath);
    const repoPath = relative(REPO_ROOT, absolutePath);
    if (
      !repoPath ||
      repoPath === ".." ||
      repoPath.startsWith(`..${sep}`) ||
      isAbsolute(repoPath)
    ) {
      throw new Error(
        `format check path must be inside the repository: ${rawPath}`,
      );
    }
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
      throw new Error(`format check path must be an existing file: ${rawPath}`);
    }
    const realPath = realpathSync(absolutePath);
    const realRepoPath = relative(REPO_ROOT, realPath);
    if (
      !realRepoPath ||
      realRepoPath === ".." ||
      realRepoPath.startsWith(`..${sep}`) ||
      isAbsolute(realRepoPath)
    ) {
      throw new Error(
        `format check path must resolve inside the repository: ${rawPath}`,
      );
    }
    return repoPath.split(sep).join("/");
  });
}

function prettierCli() {
  return require.resolve("prettier/bin/prettier.cjs", { paths: [REPO_ROOT] });
}

export function buildPrettierCheckArgs(cli, repoPath, range) {
  return buildPrettierArgs(cli, repoPath, range, "check");
}

export function buildPrettierArgs(cli, repoPath, range, mode = "check") {
  return [
    cli,
    mode === "write" ? "--write" : "--check",
    "--ignore-unknown",
    "--range-start",
    String(range.start),
    "--range-end",
    String(range.end),
    repoPath,
  ];
}

export function parseFormatCliArgs(args) {
  const raw = args[0] === "--" ? args.slice(1) : [...args];
  const write = raw[0] === "--write";
  return {
    mode: write ? "write" : "check",
    paths: normalizeScopedPaths(write ? raw.slice(1) : raw),
  };
}

function main() {
  const { mode, paths } = parseFormatCliArgs(process.argv.slice(2));
  const label =
    mode === "write" ? "format:write:scoped" : "format:check:scoped";
  let checkedRanges = 0;
  let failedRanges = 0;

  for (const repoPath of paths) {
    const source = readFileSync(resolve(REPO_ROOT, repoPath), "utf8");
    const lineRanges = changedLineRanges(repoPath, source);
    if (lineRanges.length === 0) {
      console.log(`${label}: no added lines in ${repoPath}`);
      continue;
    }
    if (!RANGE_CHECK_EXTENSIONS.has(extname(repoPath))) {
      console.log(`${label}: skipped non-code path ${repoPath}`);
      continue;
    }

    // Writes run bottom-up so formatting a later range cannot shift the byte
    // offsets of an earlier range that has not been processed yet.
    const orderedRanges =
      mode === "write" ? [...lineRanges].reverse() : lineRanges;
    for (const lineRange of orderedRanges) {
      const range = characterRangeForLines(source, lineRange);
      if (range.end <= range.start) continue;
      checkedRanges += 1;
      const result = spawnSync(
        process.execPath,
        buildPrettierArgs(prettierCli(), repoPath, range, mode),
        {
          cwd: REPO_ROOT,
          stdio: "inherit",
        },
      );
      if (result.error || result.status !== 0) failedRanges += 1;
    }
  }

  if (failedRanges > 0) {
    console.error(
      `${label}: ${failedRanges}/${checkedRanges} changed range(s) ${mode === "write" ? "failed to write" : "need formatting"}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `${label}: ${checkedRanges} changed range(s) ${mode === "write" ? "written" : "checked"}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `format:check:scoped: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
