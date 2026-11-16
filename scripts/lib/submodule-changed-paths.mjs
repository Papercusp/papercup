// The paths that changed INSIDE submodules, for a superproject change set that names each
// changed submodule only by its gitlink path.
//
// EI-28973270750407333. `git diff --name-only` in the superproject reports a submodule whose
// pointer moved (or whose work tree is dirty) as ONE path: the gitlink, e.g. `libs/papercusp`.
// The files that changed live in the submodule's own repository, so nothing keyed on a file
// path can see them. Measured on the shared tree 2026-11-16: `affected-tests.mjs
// --changed-paths libs/papercusp --print-affected` selected ZERO workspaces, because the
// workspace mapper matches a bare root only when a workspace sits at exactly that directory and
// `libs/papercusp` holds a dozen workspaces beneath it. Every forwardChangedPaths guard dropped
// the root too, since its file-family predicate (`/\.tsx?$/`, …) never matches a directory.
//
// This module recovers the inner paths by diffing each changed submodule inside its own
// repository against the pointer the superproject recorded at the START of the window,
// recursively for nested submodules. It is the runner-side counterpart of the guards' own
// expansions (`changedSinceBase` in check-fire-and-forget-classification.mjs,
// `typeScriptCandidatesAtBase` in check-required-field-strands.mjs).
//
// Lossless by construction. Inner paths are a UNION on top of the gitlink path, which callers
// keep, so a consumer matching the bare root (several guards do) is unaffected. A submodule that
// cannot be compared is never silently dropped:
//   - start pointer unknown (added in the window) or absent from its object store → listed
//     WHOLE (every tracked file), the conservative reading; returned in `whole` with the reason;
//   - no readable work tree (removed in the window, never initialized, a retired submodule whose
//     gitdir is gone) or a range end it does not have → returned in `unexpanded` with the reason,
//     so the caller can report the omission. Only the gitlink path represents it then.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** git's stdout, or null on any failure (a missing gitdir, an unknown revision, …). */
function gitOut(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const nulFields = (text) => (text ?? "").split("\0").filter(Boolean);

/**
 * Gitlink path -> commit, as recorded in `treeish` (a commit) or, when `treeish` is null, in
 * the index. Paths are relative to the root of the repository at `cwd`.
 *
 * @param {string} cwd
 * @param {string|null} treeish
 * @returns {Map<string, string>}
 */
export function gitlinksOf(cwd, treeish) {
  const out = treeish
    ? gitOut(cwd, ["ls-tree", "-r", "-z", treeish])
    : gitOut(cwd, ["ls-files", "--stage", "-z"]);
  const links = new Map();
  for (const entry of nulFields(out)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    // ls-tree: "<mode> <type> <object>"; ls-files --stage: "<mode> <object> <stage>".
    const [mode, second, third] = entry.slice(0, tab).split(" ");
    if (mode === "160000") links.set(entry.slice(tab + 1), treeish ? third : second);
  }
  return links;
}

/**
 * True when `dir` is the root of its own work tree. An uninitialized submodule is an empty
 * directory inside the parent, and git run there silently answers for the PARENT repository.
 */
function ownsWorktree(dir) {
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"])?.trim();
  try {
    return Boolean(top) && realpathSync(top) === realpathSync(dir);
  } catch {
    return false;
  }
}

const hasCommit = (dir, sha) =>
  gitOut(dir, ["cat-file", "-e", `${sha}^{commit}`]) !== null;

/** Uncommitted or untracked work in an initialized repository (never the parent's). */
const isDirty = (dir) =>
  ownsWorktree(dir) && (gitOut(dir, ["status", "--porcelain"]) ?? "").trim() !== "";

/**
 * @typedef {Object} SubmoduleNote
 * @property {string} path superproject-relative submodule path
 * @property {string} reason why it was listed whole, or could not be read
 */

/**
 * @typedef {Object} SubmoduleExpansion
 * @property {string[]} paths superproject-relative paths inside changed submodules, sorted
 * @property {string[]} compared submodules diffed against the pointer at the window's start
 * @property {SubmoduleNote[]} whole submodules listed whole (reason: added | start-not-local)
 * @property {SubmoduleNote[]} unexpanded submodules that could not be read (reason: removed |
 *   not-initialized | end-not-local | diff-failed | unreadable); only their gitlink remains
 */

/**
 * Expand every changed submodule named in `changed` into the paths that changed inside it.
 *
 * The window is `from` → `to` in the superproject. With `to` null it ends at the WORK TREE:
 * each submodule's work tree (commits since the start pointer, uncommitted edits and untracked
 * files) is compared with the pointer recorded at `from`. With `to` a commit, both ends are the
 * pointers recorded at `from` and `to` (a historical range; no work tree is involved).
 *
 * @param {Object} input
 * @param {string} input.root superproject work-tree root
 * @param {Iterable<string>} input.changed superproject-relative changed paths
 * @param {string} input.from commit the window starts at
 * @param {string|null} [input.to] commit the window ends at, or null for the work tree
 * @returns {SubmoduleExpansion}
 */
export function expandSubmoduleChanges({ root, changed, from, to = null }) {
  const worktree = to === null;
  const paths = new Set();
  const compared = [];
  const whole = [];
  const unexpanded = [];

  // Every tracked file of `dir` at `ref` (null: the index, plus untracked files), recursing
  // into initialized nested submodules.
  const listWhole = (dir, full, ref, reason) => {
    const listing = gitOut(dir, ref ? ["ls-tree", "-r", "-z", "--name-only", ref] : ["ls-files", "-z"]);
    if (listing === null) {
      unexpanded.push({ path: full, reason: "unreadable" });
      return;
    }
    whole.push({ path: full, reason });
    const local = new Set(nulFields(listing));
    if (!ref) {
      for (const p of nulFields(gitOut(dir, ["ls-files", "--others", "--exclude-standard", "-z"]))) local.add(p);
    }
    const nested = gitlinksOf(dir, ref);
    for (const p of local) {
      paths.add(`${full}/${p}`);
      if (!nested.has(p)) continue;
      const nestedDir = resolve(dir, p);
      const nestedFull = `${full}/${p}`;
      if (!ownsWorktree(nestedDir)) {
        unexpanded.push({ path: nestedFull, reason: "not-initialized" });
      } else if (ref && !hasCommit(nestedDir, nested.get(p))) {
        unexpanded.push({ path: nestedFull, reason: "end-not-local" });
      } else {
        listWhole(nestedDir, nestedFull, ref ? nested.get(p) : null, reason);
      }
    }
  };

  // Diff `dir` (an initialized submodule) from `oldPtr` to `target` (null: its work tree).
  const compare = (dir, full, oldPtr, target) => {
    // In the work tree, `--ignore-submodules=dirty` keeps a retired nested submodule's missing
    // gitdir from aborting the diff (the EI-1989 fatal); nested dirty work is probed below.
    const diff = gitOut(dir, target
      ? ["diff", "--name-only", "--no-renames", "-z", oldPtr, target]
      : ["diff", "--name-only", "--no-renames", "--ignore-submodules=dirty", "-z", oldPtr]);
    if (diff === null) {
      unexpanded.push({ path: full, reason: "diff-failed" });
      return;
    }
    compared.push(full);
    const nestedThen = gitlinksOf(dir, oldPtr);
    const nestedNow = gitlinksOf(dir, target);
    const local = new Set(nulFields(diff));
    if (!target) {
      for (const p of nulFields(gitOut(dir, ["ls-files", "--others", "--exclude-standard", "-z"]))) local.add(p);
      for (const p of nestedNow.keys()) if (!local.has(p) && isDirty(resolve(dir, p))) local.add(p);
    }
    for (const p of local) {
      paths.add(`${full}/${p}`);
      if (nestedThen.has(p) || nestedNow.has(p)) {
        visit(dir, `${full}/`, p, nestedThen.get(p) ?? null, nestedNow.get(p) ?? null, nestedNow.has(p));
      }
    }
  };

  const visit = (parentDir, prefix, path, oldPtr, nowPtr, present) => {
    const full = `${prefix}${path}`;
    const dir = resolve(parentDir, path);
    if (!present) {
      unexpanded.push({ path: full, reason: "removed" });
      return;
    }
    if (!ownsWorktree(dir)) {
      unexpanded.push({ path: full, reason: "not-initialized" });
      return;
    }
    const target = worktree ? null : nowPtr;
    if (target && !hasCommit(dir, target)) {
      unexpanded.push({ path: full, reason: "end-not-local" });
      return;
    }
    if (!oldPtr) {
      listWhole(dir, full, target, "added");
      return;
    }
    if (!hasCommit(dir, oldPtr)) {
      listWhole(dir, full, target, "start-not-local");
      return;
    }
    compare(dir, full, oldPtr, target);
  };

  const rootThen = gitlinksOf(root, from);
  const rootNow = gitlinksOf(root, to);
  for (const p of new Set(changed)) {
    if (!rootThen.has(p) && !rootNow.has(p)) continue;
    visit(root, "", p, rootThen.get(p) ?? null, rootNow.get(p) ?? null, rootNow.has(p));
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  return {
    paths: [...paths].sort(),
    compared: compared.sort(),
    whole: whole.sort(byPath),
    unexpanded: unexpanded.sort(byPath),
  };
}

/**
 * The one stderr line a run prints about the expansion, plus one line per submodule that was
 * listed whole or could not be read: the omission is reported, never silent.
 *
 * @param {SubmoduleExpansion} expansion
 * @returns {string[]}
 */
export function formatSubmoduleExpansion(expansion) {
  const lines = [
    `SUBMODULE_EXPANSION paths=${expansion.paths.length} compared=${expansion.compared.length} ` +
      `whole=${expansion.whole.length} unexpanded=${expansion.unexpanded.length}`,
  ];
  for (const note of expansion.whole) {
    lines.push(`SUBMODULE_EXPANSION_WHOLE path=${note.path} reason=${note.reason}`);
  }
  for (const note of expansion.unexpanded) {
    lines.push(`SUBMODULE_EXPANSION_UNEXPANDED path=${note.path} reason=${note.reason} (only its gitlink path represents it)`);
  }
  return lines;
}
