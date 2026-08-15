#!/usr/bin/env bash
# Release-checkout setup / sync — plan release-gate-ready-branch-2026-06-04, Phase 0.
#
# Stands up + maintains the SEPARATE release checkout the operator runs from,
# pinned to a release ref (default the green `main` branch — staging→main model,
# staging-branch-pipeline-2026-06-06). This is the deploy system's own checkout
# — NOT an agent worktree (D-004), so it does not violate the "agents stay on
# the integration branch (`staging`)" rule. Idempotent: safe to re-run on every
# deploy.
#
# What it guarantees about the release checkout at $PAPERCUSP_RELEASE_ROOT:
#   1. a git worktree detached at the target commit (default: green `main`) —
#      the superproject's tracked files, as real isolated files,
#   2. submodule REPOS — REAL git repositories, cloned from the integration
#      tree's LOCAL object store and detached at each submodule's EXACT pinned
#      sha. Sourcing locally is what makes this work at all: many submodule pins
#      are never pushed to origin (the integration tree holds them locally), so a
#      fresh worktree/clone's `submodule update` fails "upload-pack: not our
#      ref". `git clone --local` reads exactly the same local objects `git
#      archive` did, HARDLINKS them (immutable → near-zero disk, and unaffected
#      by peer edits to the integration tree), and checks out a working tree of
#      REAL files at the pinned commit.
#
#      Why real repos rather than extracted files (EI-19299565558496583): a plain
#      file tree has no `.git`, so it is not a submodule to git at all, and
#      `git ls-files --recurse-submodules` silently returns superproject-only —
#      no error, just a smaller list. Measured in the gate checkout: 7,526
#      recursive == 7,526 plain (+0 from recursion), 35/35 submodules
#      uninitialized, hiding ~3,500 TS files (~32% of the tree) from every
#      tracked-files guard IN THE GATE. With real repos: +1,055 files, 0
#      uninitialized. `git archive` extraction is RETAINED as the fallback below.
#      (All submodules are top-level here — no recursion needed.)
#   3. node_modules HARDLINK-copied from the integration tree. We must COPY, not
#      symlink: npm-workspace packages are relative symlinks (../../packages/X);
#      a symlinked node_modules dir would resolve those back to the INTEGRATION
#      tree and defeat the whole isolation. Hardlinks share data (near-zero disk)
#      and are safe because node_modules is never hand-edited — unlike submodule
#      SOURCE (heavily edited by the fleet), which is why (2) is a real copy.
#
# Why a worktree (not a clone) for the superproject: shares the object store, so
# checking out the target commit is cheap and history isn't duplicated.
#
# Standalone by design (plan "Bootstrapping" risk): pure git + coreutils, no
# operator/Node runtime needed, so it can rebuild the release checkout even when
# the operator it deploys is wedged.
#
# Usage:
#   setup-release-checkout.sh [--ref <commit-ish>] [--node-modules auto|force|skip]
#                             [--integration <dir>] [--release <dir>]
#
# Env overrides: PAPERCUSP_INTEGRATION_ROOT, PAPERCUSP_RELEASE_ROOT.
set -euo pipefail

# Default to the checkout this script actually lives in — never one box's path
# (WI-4419: a hardcoded /home/<user>/… default is wrong on every other machine
# AND ships the owner's identity inside the release source drop).
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_DEFAULT="$(git -C "$_HERE" rev-parse --show-toplevel 2>/dev/null || (cd "$_HERE/../../../.." && pwd))"
INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-$_REPO_DEFAULT}"
RELEASE_ROOT="${PAPERCUSP_RELEASE_ROOT:-$(dirname "$INTEGRATION_ROOT")/papercusp-release}"
REF="main"
NODE_MODULES_MODE="auto"   # auto = copy when missing/lockfile-changed; force = always; skip = never

BUILD_SPA="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --node-modules) NODE_MODULES_MODE="$2"; shift 2 ;;
    --integration) INTEGRATION_ROOT="$2"; shift 2 ;;
    --release) RELEASE_ROOT="$2"; shift 2 ;;
    --build-spa) BUILD_SPA="1"; shift ;;
    *) echo "[setup-release] unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[setup-release] $*"; }

# Symlink-safe roots: `find` (default -P) does NOT descend through a symlinked
# START path, so a symlinked INTEGRATION_ROOT (e.g. papercup -> papercusp, since
# 2026-06-25) makes the node_modules copy loop below (`find "$INTEGRATION_ROOT"
# -name node_modules -type d`) enumerate ZERO dirs and silently copy NOTHING —
# leaving release node_modules stale until the workspace-resolution gate aborts
# every deploy (the 2026-06-30 "@papercusp/scheduled-registry unresolved" stall
# that left :3070 166 commits behind). Normalize to real paths so find/cp operate
# on the real tree regardless of how the caller named the root.
INTEGRATION_ROOT="$(realpath "$INTEGRATION_ROOT")"
RELEASE_ROOT="$(realpath -m "$RELEASE_ROOT")"

[ -d "$INTEGRATION_ROOT/.git" ] || { echo "[setup-release] integration root is not a git repo: $INTEGRATION_ROOT" >&2; exit 1; }

# Resolve the target commit from the integration repo (refs are shared with the worktree).
TARGET_SHA="$(git -C "$INTEGRATION_ROOT" rev-parse --verify "${REF}^{commit}")"
log "target ref=$REF sha=$TARGET_SHA"

# 1. Worktree --------------------------------------------------------------
if [ -e "$RELEASE_ROOT/.git" ]; then
  log "release worktree exists; checking out $TARGET_SHA"
  git -C "$RELEASE_ROOT" checkout --detach "$TARGET_SHA" >/dev/null 2>&1 || \
    git -C "$RELEASE_ROOT" reset --hard "$TARGET_SHA"
  git -C "$RELEASE_ROOT" reset --hard "$TARGET_SHA"
  # UNTRACKED debris survives reset --hard and poisons every later run from
  # this tree (2026-06-06: a stray test file made the green-checkpoint red
  # forever). Clean it — node_modules excluded (the hardlink copies from step
  # 3 are untracked by design); submodule SOURCE is re-extracted in step 2
  # anyway, so losing it here is fine.
  #
  # WI-5366: `-x` too — a plain `clean -fdq` (no `-x`) leaves every GITIGNORED
  # artifact untouched, not just node_modules. Verified live in this exact
  # tree (2026-07-19): package-local `.vitest-tmp/` and `.papercusp-tmp/node-
  # compile-cache/` dirs dated 2026-07-02 — 17 days and untold checkouts
  # stale — survived every single `reset --hard` + clean since, because they
  # are ignored, not untracked-but-unignored. This tree's own header comment
  # calls it "a throwaway, correctness-critical tree [that] must always
  # re-copy from integration" (the reasoning that made `--node-modules force`
  # mandatory here over `auto`); a stale gitignored build/test cache left
  # over from a PRIOR checkout at a DIFFERENT commit is the exact same class
  # of correctness risk, just unaddressed for anything outside node_modules.
  # This is the leading suspect behind WI-5366 (green-checkpoint's stale-
  # candidate re-triage twice reporting a false "failures REPRODUCE at tip"
  # verdict for a tip provably clean at that sha) — a stale cache is a much
  # better fit than a checkout race (assert_checkout_landed, WI-5110, already
  # proves HEAD lands correctly; the reflog for the incident shows a single
  # clean transition with nothing interleaved). `-x` makes the clean total:
  # every ignored file/dir is removed too, `-e node_modules` still spares
  # the one directory this tree deliberately preserves + refreshes itself.
  git -C "$RELEASE_ROOT" clean -fdqx -e node_modules || true
else
  log "creating release worktree at $RELEASE_ROOT"
  git -C "$INTEGRATION_ROOT" worktree add --detach "$RELEASE_ROOT" "$TARGET_SHA"
fi

# 1a. Verify the checkout actually landed (WI-5110) ------------------------
# A caller trusts a ZERO exit from this script as proof the tree is at
# $TARGET_SHA — the green-checkpoint stale-candidate re-triage in particular
# renders a "failures REPRODUCE at tip <sha>" verdict straight off that
# assumption (apps/operator/lib/release/green-checkpoint.ts runTestsAtRef).
# Twice on 2026-07-17 that verdict was FALSE for tests that demonstrably
# passed when re-run by hand at the same sha — i.e. something upstream of
# this assertion produced a green exit code without the working tree actually
# reflecting $TARGET_SHA (a worktree race, a swallowed git error, or similar;
# root cause not yet isolated). Rather than let ANY caller keep trusting a
# postcondition this script has not actually verified, assert it here, once,
# at the source: fail loudly (exit 1, no swap/no test run happens on a
# throwaway tree) if HEAD does not match. This makes a zero exit from this
# script an honest guarantee for every caller (candidate judgment, tip
# re-run, prefix salvage) instead of requiring each one to re-verify a value
# this script should have gotten right the first time.
# Named function (reads RELEASE_ROOT / TARGET_SHA / REF from the outer scope) for
# sed-extraction unit tests — same convention as need_node_modules /
# prune_post_pin_workspace_pkgs (setup-release-checkout-deps.test.ts). Exits the
# whole script non-zero on a mismatch: this check is fatal by design — a
# throwaway checkpoint/release tree that is not provably at TARGET_SHA must never
# be handed to a caller as if it were.
assert_checkout_landed() {
  local actual
  actual="$(git -C "$RELEASE_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [ "$actual" != "$TARGET_SHA" ]; then
    echo "[setup-release] FATAL: release tree HEAD (${actual:-unknown}) does not match target ref ${REF:-?} ($TARGET_SHA) after checkout — refusing to let a caller trust this tree" >&2
    exit 1
  fi
}
assert_checkout_landed

# 2. Submodule SOURCE — git archive at the exact pinned sha (local objects) ---
# EI-18749180047527506: a `tar -x` that EXITS ZERO is not proof the extraction is
# COMPLETE — a truncated/interrupted archive stream can still exit 0 having
# written fewer files than its own manifest promised, silently leaving a
# submodule tree PARTIAL. That is indistinguishable, downstream, from a real
# content regression: prompt-blueprint-verb-catalog.test.ts's >150-file
# scan-sanity floor (guarding this exact submodule tree) has no way to tell
# "the checkout is genuinely incomplete" from "a candidate deleted files", and
# a false alarm here holds the WHOLE fleet's green pin. Verify the on-disk file
# count against the archive's OWN manifest (`tar -tf`) before trusting the
# extraction; a shortfall is treated exactly like the pre-existing `tar -x`
# failure path — fall back to the full-tree rsync, which is complete by
# construction. Named + reads INTEGRATION_ROOT/RELEASE_ROOT from the outer
# scope so it can be sed-extracted + unit-tested (setup-release-checkout-deps.
# test.ts pattern) like need_node_modules / sync_one_node_modules /
# prune_post_pin_workspace_pkgs above.
extract_submodule_source() {  # <repo-relative path> <pinned sha>
  local rel_path="$1" sha="$2" tar_file expected actual
  rm -rf "${RELEASE_ROOT:?}/$rel_path"
  mkdir -p "$RELEASE_ROOT/$rel_path"
  tar_file="$(mktemp)"
  if git -C "$INTEGRATION_ROOT/$rel_path" archive "$sha" >"$tar_file" 2>/dev/null && [ -s "$tar_file" ]; then
    # tar -tf lists directory entries with a trailing '/'; count only file
    # entries (matches the on-disk `find -type f` count below). A parse
    # failure (corrupt/unreadable archive) yields -1 so it never satisfies
    # the `-ge 0` check and always falls through to the rsync fallback.
    expected="$(tar -tf "$tar_file" 2>/dev/null | grep -vc '/$' || true)"
    [ -n "$expected" ] || expected=-1
    if tar -x -C "$RELEASE_ROOT/$rel_path" -f "$tar_file" 2>/dev/null; then
      actual="$(find "$RELEASE_ROOT/$rel_path" -type f | wc -l | tr -d ' ')"
      if [ "$expected" -ge 0 ] && [ "$actual" -ge "$expected" ]; then
        rm -f "$tar_file"
        return 0
      fi
      log "WARN git archive $rel_path@$sha landed only $actual/$expected file(s) — treating as an incomplete extraction"
    fi
  fi
  rm -f "$tar_file"
  log "WARN git archive $rel_path@$sha failed or incomplete; rsync'ing integration HEAD (pin may drift)"
  rsync -a --exclude='node_modules' --exclude='.git' "$INTEGRATION_ROOT/$rel_path/" "$RELEASE_ROOT/$rel_path/"
}

# EI-19299565558496583: clone a REAL submodule repository at the pinned sha. This
# is the PRIMARY path; extract_submodule_source above is the FALLBACK and is
# deliberately retained rather than replaced — it carries its own incident
# hardening (EI-18749180047527506's completeness check + the rsync last resort)
# and still produces correct CONTENT when a clone cannot be made.
#
# Two properties here are load-bearing and must not be "simplified away":
#
#  (a) `git clone --local` produces a real `.git` DIRECTORY inside the submodule
#      path (git's legacy layout). That is REQUIRED, not incidental. The obvious
#      alternative — `git submodule update --init` with the URL rewritten to the
#      local path — places each gitdir under `git rev-parse --git-common-dir`/
#      modules/<name>, and because the release tree is a LINKED WORKTREE of the
#      integration repo, that common dir IS the integration repo's own `.git`.
#      It would collide with the integration tree's live submodule gitdirs, i.e.
#      corrupt the tree the whole fleet is working in. A self-contained `.git`
#      dir is isolated by construction.
#
#  (b) This function must NEVER write submodule config. `git config` run from a
#      linked worktree writes to the SHARED config — into the integration repo —
#      so registering `submodule.<name>.url` here would mutate that tree too.
#      It is also unnecessary: the release worktree already INHERITS
#      `submodule.<name>.active` from the shared config, which is why recursion
#      works with zero config writes.
#
# Named + reads INTEGRATION_ROOT/RELEASE_ROOT from the outer scope so it can be
# sed-extracted and unit-tested (setup-release-checkout-deps.test.ts pattern),
# like need_node_modules / sync_one_node_modules / extract_submodule_source.
clone_submodule_repo() {  # <repo-relative path> <pinned sha>
  local rel_path="$1" sha="$2"
  # Deliberately a SECOND `local`: bash expands every argument of a single
  # `local` before the builtin assigns any of them, so folding this into the
  # line above makes `$rel_path` unbound under `set -u` (caught in test).
  local dest="$RELEASE_ROOT/$rel_path"
  rm -rf "${dest:?}"
  # --no-checkout: the clone's default HEAD may be a different commit, and the
  # ONLY working-tree files this may write are the pinned ones.
  git clone --quiet --local --no-checkout "$INTEGRATION_ROOT/$rel_path" "$dest" 2>/dev/null || return 1
  git -C "$dest" checkout --quiet --detach "$sha" 2>/dev/null || return 1
  # Pin correctness: HEAD must be EXACTLY the gitlink sha, never merely "close".
  [ "$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)" = "$sha" ] || return 1
  # Completeness — the same guarantee the archive path buys with its tar-manifest
  # count, but strictly stronger: a clean worktree proves every tracked file is
  # present AND carries the pinned content. `-uno` keeps it cheap.
  [ -z "$(git -C "$dest" status --porcelain -uno 2>/dev/null)" ] || return 1
  return 0
}

log "cloning submodule repos at pinned shas (local objects; real .git so --recurse-submodules works)"
_sub_cloned=0
_sub_fallback=0
while IFS= read -r P; do
  [ -n "$P" ] || continue
  [ -d "$INTEGRATION_ROOT/$P" ] || { log "WARN integration submodule missing: $P — skipping"; continue; }
  # The gitlink sha recorded at the release worktree's HEAD for this path.
  S="$(git -C "$RELEASE_ROOT" ls-tree HEAD "$P" 2>/dev/null | awk '{print $3}')"
  [ -n "$S" ] || { log "WARN no gitlink sha for $P — skipping"; continue; }
  if clone_submodule_repo "$P" "$S"; then
    _sub_cloned=$((_sub_cloned + 1))
  else
    _sub_fallback=$((_sub_fallback + 1))
    log "WARN clone failed for $P@${S:0:10} — falling back to git archive extraction (that submodule gets NO .git, so tracked-files guards will not see inside it)"
    extract_submodule_source "$P" "$S"
  fi
# P-009: read the submodule list from the TARGET commit's .gitmodules blob, NOT the
# integration tree's current working copy — a submodule added/removed on staging while
# the target still pins the old set would otherwise be extracted from the wrong list
# during the transition window. `git config --blob <sha>:.gitmodules` reads the committed
# config; 2>/dev/null + an empty loop is the correct no-op when a sha has no .gitmodules.
done < <(git -C "$INTEGRATION_ROOT" config --blob "${TARGET_SHA}:.gitmodules" --get-regexp '\.path$' 2>/dev/null | awk '{print $2}')

# 2a. Recursion sanity (EI-19299565558496583) ---------------------------------
# The defect this replaced was SILENT — no error, just a smaller file list — and
# that is precisely why it survived long enough to hide ~32% of the tree from the
# gate. Log the real numbers on EVERY run so a regression shows up in the deploy
# log immediately, instead of surfacing months later as a guard that mysteriously
# stopped finding things.
#
# Deliberately NON-FATAL: a deploy must never be wedged by a reporting check, and
# the archive fallback above still yields correct CONTENT (only recursion is
# lost). Hard enforcement belongs to the gate's own scan-sanity floor
# (prompt-blueprint-verb-catalog.test.ts), which fails loudly by design.
_plain="$(git -C "$RELEASE_ROOT" ls-files 2>/dev/null | wc -l | tr -d ' ')"
_recursive="$(git -C "$RELEASE_ROOT" ls-files --recurse-submodules 2>/dev/null | wc -l | tr -d ' ')"
_uninit="$(git -C "$RELEASE_ROOT" submodule status 2>/dev/null | grep -c '^-' || true)"
log "submodule recursion: cloned=$_sub_cloned archive-fallback=$_sub_fallback tracked plain=$_plain recursive=$_recursive uninitialized=$_uninit"
if [ "$_sub_cloned" -gt 0 ] && [ "$_recursive" -le "$_plain" ]; then
  log "WARN recursion added NO files despite $_sub_cloned cloned submodule repo(s) — tracked-files guards are probably scanning the superproject only"
fi

# 3. node_modules ----------------------------------------------------------
# EI-2118: list workspace packages (@papercusp/@papercup) that RESOLVE in the
# integration tree but do NOT resolve in the release tree — i.e. a release
# node_modules symlink that is MISSING or DANGLING (its target absent from the
# release tree). `need_node_modules`'s name-set `diff` below only compares ENTRY
# NAMES, and `ls` lists a dangling symlink's name just the same as a live one — so
# a release symlink that exists by name but does not resolve slips through that
# check, yet fails at require() with "Cannot find module '@papercusp/<pkg>'",
# crash-looping the operator at the restart cutover (2026-06-20 @papercusp/plugin-loader;
# same class as the 2026-06-09 @dnd-kit/core outage). `-e` FOLLOWS symlinks, so a
# missing/dangling link (or a target dir without package.json) fails it. The
# integration tree is the source of truth: a package integration itself cannot
# resolve is a pre-existing break, not this copy's regression to chase. Pure shell
# (no Node) — keeps this script standalone by design.
unresolved_workspace_pkgs() {
  local scope pkg src rel
  for scope in @papercusp @papercup; do
    [ -d "$INTEGRATION_ROOT/node_modules/$scope" ] || continue
    while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue
      [ -e "$INTEGRATION_ROOT/node_modules/$scope/$pkg/package.json" ] || continue
      [ -e "$RELEASE_ROOT/node_modules/$scope/$pkg/package.json" ] && continue
      # EI-13127: a package whose SOURCE is absent from the pinned target tree
      # cannot be referenced by pinned code (it post-dates the pin — the
      # integration symlink set reflects staging tip, the release source tree
      # reflects TARGET_SHA). Reporting it froze EVERY deploy (target AND
      # rollback refs alike) from the moment a new workspace package landed on
      # staging until the next green pin included it. Skip it here — the same
      # discriminator prune_post_pin_workspace_pkgs uses to drop the dangling
      # symlink. Deliberately inline (not a shared helper): both functions are
      # sed-extracted standalone by setup-release-checkout-deps.test.ts.
      # No TARGET_SHA in scope (a caller predating the pin resolution) keeps
      # the original strict behavior.
      if [ -n "${TARGET_SHA:-}" ]; then
        src="$(readlink -f "$INTEGRATION_ROOT/node_modules/$scope/$pkg" 2>/dev/null)" || src=""
        case "$src" in
          "$INTEGRATION_ROOT"/*)
            rel="${src#"$INTEGRATION_ROOT"/}"
            if [ -z "$(git -C "$INTEGRATION_ROOT" ls-tree "$TARGET_SHA" -- "$rel" 2>/dev/null)" ]; then
              continue
            fi
            ;;
        esac
      fi
      printf '%s/%s ' "$scope" "$pkg"
    done < <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null)
  done
  return 0
}

need_node_modules() {
  case "$NODE_MODULES_MODE" in
    skip) return 1 ;;
    force) return 0 ;;
    auto)
      # Copy when the release tree has no root node_modules yet, the root
      # lockfile differs (deps changed), OR the package set changed (scoped or non-scoped).
      # Scoped case (2026-06-05): a newly-added @papercusp/@papercup workspace package
      # gets a node_modules symlink the ROOT package-lock does NOT always reflect,
      # so the lockfile-only heuristic skipped the copy → "Cannot find module" crash.
      # Non-scoped case (EI-935): a newly-added non-scoped dep (e.g. lodash) is
      # missed by the scoped-package check and may not be detected by lockfile
      # comparison if the release tree's package-lock.json is missing or stale.
      [ -d "$RELEASE_ROOT/node_modules" ] || return 0
      # EI-2118: force a re-copy when any release workspace symlink is missing or
      # DANGLES (exists by name but does not resolve) — the name-set diff below
      # cannot see a broken-but-named symlink. Step 3's rm -rf + cp -al re-links it.
      [ -n "$(unresolved_workspace_pkgs)" ] && return 0
      # WI-39243: the root dependency tree can be current while a package-local
      # node_modules is absent. Release cleanup intentionally removes ignored
      # package-local dependency dirs, and the copy step refreshes them only when
      # THIS predicate returns true. Missing SSE-local TypeScript 5.9 therefore
      # made its pinned build fall back to root TypeScript 6 and fail with TS5107,
      # even though the root package set and lockfile matched exactly. Check every
      # integration package-local tree whose package also exists at this pin; a
      # package absent from RELEASE_ROOT belongs to a newer staging pin and must
      # not make an old rollback ref perpetually dirty.
      while IFS= read -r integration_nm; do
        [ "$integration_nm" = "$INTEGRATION_ROOT/node_modules" ] && continue
        rel="${integration_nm#"$INTEGRATION_ROOT"/}"
        package_rel="${rel%/node_modules}"
        [ -e "$RELEASE_ROOT/$package_rel/package.json" ] || continue
        [ -d "$RELEASE_ROOT/$rel" ] || return 0
      done < <(find "$INTEGRATION_ROOT" -name node_modules -type d -prune -print)
      # Check scoped packages (@papercusp, @papercup).
      for scope in @papercusp @papercup; do
        if ! diff -q <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null | sort) \
                     <(ls -1 "$RELEASE_ROOT/node_modules/$scope" 2>/dev/null | sort) >/dev/null 2>&1; then
          return 0
        fi
      done
      # Check non-scoped root packages (anything in node_modules/ that is NOT a scope, .bin, etc).
      # Filter out scoped dirs (@*), special files/dirs (.bin, .package-lock.json, .modules.yaml, etc).
      if ! diff -q <(ls -1 "$INTEGRATION_ROOT/node_modules" 2>/dev/null | grep -v '^@' | grep -v '^\.' | sort) \
                   <(ls -1 "$RELEASE_ROOT/node_modules" 2>/dev/null | grep -v '^@' | grep -v '^\.' | sort) >/dev/null 2>&1; then
        return 0
      fi
      # Fall back to lockfile comparison. Both files must exist; if either is missing,
      # we assume they differ and copy (fail-safe: worse to copy unnecessarily than skip).
      if [ -f "$INTEGRATION_ROOT/package-lock.json" ] && [ -f "$RELEASE_ROOT/package-lock.json" ]; then
        ! cmp -s "$INTEGRATION_ROOT/package-lock.json" "$RELEASE_ROOT/package-lock.json"
        return $?
      fi
      # If the lockfile comparison can't run, assume they differ and copy (fail-safe).
      if [ -f "$INTEGRATION_ROOT/package-lock.json" ]; then
        return 0
      fi
      return 1 ;;
    *) echo "[setup-release] bad --node-modules mode: $NODE_MODULES_MODE" >&2; exit 2 ;;
  esac
}

# ATOMIC refresh of ONE node_modules dir (infra-fail-fast — the 2026-06-25 all-pages
# connection-refused outage). The integration source is hardlink-copied into a SIBLING
# temp dir FIRST, then swapped into place with two fast renames — so the LIVE operator
# always sees a COMPLETE node_modules and never the minute-long half-populated window an
# in-place `rm -rf "$dest"; cp -al "$src" "$dest"` opens.
#
# The window WAS the outage: a deploy `rm -rf`'d the live root node_modules and slowly
# re-`cp -al`'d it (~a minute, 100k+ files) while :3070 was still serving from it. The
# 32 cluster workers respawned mid-copy, hit MODULE_NOT_FOUND (@modelcontextprotocol/sdk,
# @papercusp/plugin-loader), exhausted the 160-respawn budget → 0 workers → connection
# refused on every page until the copy finished. Two renames shrink the exposure from
# ~a minute to the microseconds between two rename(2) syscalls — effectively zero, and a
# respawn would have to land in exactly that gap to see anything missing.
#
# Sibling temp ("$dest.deploy-tmp.$$") sits at the SAME depth as "$dest", so the workspace
# packages' RELATIVE symlinks (../../packages/X) resolve to the RELEASE tree identically
# in the temp and final locations (cp -al preserves symlinks; the isolation invariant in
# the header note holds). `set -e` aborts on a failed cp BEFORE any swap, so a partial
# copy can never replace the live tree (fail-safe — same abort semantics as before).
sync_one_node_modules() {
  local src="$1" dest="$2"
  local tmp="${dest}.deploy-tmp.$$" old="${dest}.deploy-old.$$"
  # EI-202238*: package installers atomically rename transient trees such as
  # `sidecar.old.<pid>` while this script's `find` enumeration is in flight.
  # A node_modules path can therefore be real when `find` prints it and gone by
  # the time this function runs. It was never part of the stable dependency
  # tree, so skip that vanished source instead of crashing the whole release
  # gate before tests begin. A stable source disappearing is still caught by
  # the post-copy dependency gates below.
  if [ ! -d "$src" ]; then
    log "node_modules source vanished during enumeration; skipping transient path: $src"
    return 0
  fi
  rm -rf "$tmp" "$old"                 # defensive: clear this run's leftovers (crash-safety)
  mkdir -p "$(dirname "$dest")"
  cp -al "$src" "$tmp"                 # slow; "$dest" stays untouched + complete throughout
  if [ -e "$dest" ]; then
    mv "$dest" "$old"                  # instant rename
    mv "$tmp" "$dest"                  # instant rename — ONLY these two bracket the swap
    rm -rf "$old"                      # cleanup; the new tree is already live
  else
    mv "$tmp" "$dest"                  # first-time create: a single rename
  fi
}

if need_node_modules; then
  log "hardlink-copying node_modules from integration tree (atomic swap; this can take a minute)"
  # Enumerate every package-local node_modules in the integration tree (prune so
  # we get the dir itself, not the ones nested inside it — those ride along in the
  # parent's cp -al). Each is refreshed via an atomic sibling-temp swap (above).
  while IFS= read -r nm; do
    rel="${nm#"$INTEGRATION_ROOT"/}"
    sync_one_node_modules "$nm" "$RELEASE_ROOT/$rel"
  done < <(find "$INTEGRATION_ROOT" -name node_modules -type d -prune -print)
  # Record WHICH dep state was just copied: package-lock.json is gitignored, so
  # the checkout above never updates the release tree's copy — without this the
  # `auto` cmp stays permanently dirty and every deploy re-copies node_modules.
  [ -f "$INTEGRATION_ROOT/package-lock.json" ] && cp "$INTEGRATION_ROOT/package-lock.json" "$RELEASE_ROOT/package-lock.json"
  log "node_modules sync complete"
else
  log "node_modules up to date (mode=$NODE_MODULES_MODE) — skipping copy"
fi

# 3a½. pnpm-debris self-heal ---------------------------------------------------
# A release/checkpoint tree never runs installs, so a .pnpm virtual store that is
# absent from the integration source is stale debris and must not linger forever.
# But co-hosted app harnesses may legitimately use pnpm: their top-level package
# symlinks resolve THROUGH node_modules/.pnpm. Removing a store that was copied from
# such an integration tree leaves every symlink present-by-name but dangling (the
# SideStage TypeScript pre-test red, WI-39301). Preserve source-backed stores; prune
# only release-only debris. Papercusp's no-pnpm-hijack test remains the policy guard
# for its own npm-only integration tree.
prune_stale_pnpm_store() {
  if [ -d "$RELEASE_ROOT/node_modules/.pnpm" ] && [ ! -d "$INTEGRATION_ROOT/node_modules/.pnpm" ]; then
    log "removing release-only node_modules/.pnpm (stale pnpm debris absent from integration source)"
    rm -rf "$RELEASE_ROOT/node_modules/.pnpm"
  elif [ -d "$RELEASE_ROOT/node_modules/.pnpm" ]; then
    log "preserving source-backed node_modules/.pnpm virtual store"
  fi
}
prune_stale_pnpm_store

# 3b. Dependency patches (patch-package) -------------------------------------
# patch-package patches apply at INSTALL time, but this tree never `npm install`s
# — it hardlink-copies node_modules from the integration tree (step 3). That copy
# carries the integration tree's already-patched files WHEN it runs, but the
# `auto` heuristic skips the copy on a patches-only change (a new patch alters no
# lockfile / workspace-package set), and an integration file edited in place gets
# a NEW inode the pre-existing hardlink never tracked — so this tree's node_modules
# can be left UNPATCHED. Re-apply committed patches here (idempotent; the same
# patch-package the repo's postinstall uses). Without it a committed dependency
# patch (e.g. the EI-127 mcp-handler per-request-server leak fix) silently reaches
# NEITHER the deployed operator NOR the green-checkpoint tree — which then reds on
# the patch's own regression test, blocking every deploy. Non-fatal by design: a
# patch hiccup must never wedge the deploy.
if [ -d "$RELEASE_ROOT/patches" ] && [ -x "$RELEASE_ROOT/node_modules/.bin/patch-package" ]; then
  log "applying committed dependency patches (patch-package)"
  (cd "$RELEASE_ROOT" && ./node_modules/.bin/patch-package 1>/dev/null 2>&1) \
    || log "WARN patch-package reported issues (continuing)"
fi

# 3b-2. Post-pin package prune (EI-13127) — a dangling release symlink has TWO
# causes with OPPOSITE correct handling, and the fatal gate below cannot tell
# them apart on its own:
#   (a) the package's source IS in the target ref but extraction/copy failed →
#       pinned code may require() it → crash-loop risk → FATAL is correct;
#   (b) the package was added to staging AFTER the target ref was pinned (the
#       integration node_modules symlink set always reflects staging tip, the
#       release source tree reflects the PIN) → pinned code cannot possibly
#       import a package that did not exist when it was committed → the dangling
#       name is inert, and fataling on it froze EVERY deploy (target AND
#       rollback refs both predate the package) until the next green pin — a
#       multi-hour deploy freeze re-opened by every new workspace package
#       (2026-07-16 @papercusp/release-profile: :3070 stuck 13 commits behind
#       a green pin). Discriminate with the pin itself: the integration
#       symlink's repo-relative source path present in TARGET_SHA ⇒ case (a),
#       leave for the gate; absent ⇒ case (b), prune the dangling symlink and
#       log. Named function for sed-extraction unit tests
#       (setup-release-checkout-deps.test.ts pattern).
prune_post_pin_workspace_pkgs() {
  local scope pkg src rel
  for scope in @papercusp @papercup; do
    [ -d "$INTEGRATION_ROOT/node_modules/$scope" ] || continue
    while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue
      # Same predicate as unresolved_workspace_pkgs: resolves in integration…
      [ -e "$INTEGRATION_ROOT/node_modules/$scope/$pkg/package.json" ] || continue
      # …but not in the release tree.
      [ -e "$RELEASE_ROOT/node_modules/$scope/$pkg/package.json" ] && continue
      # Repo-relative source path via the integration symlink target.
      src="$(readlink -f "$INTEGRATION_ROOT/node_modules/$scope/$pkg" 2>/dev/null)" || continue
      [ -n "$src" ] || continue
      case "$src" in
        "$INTEGRATION_ROOT"/*) rel="${src#"$INTEGRATION_ROOT"/}" ;;
        *) continue ;;
      esac
      # Present in the pinned tree (plain dir OR submodule gitlink)? Then this
      # is case (a) — a genuine extraction break; leave it for the fatal gate.
      if [ -n "$(git -C "$INTEGRATION_ROOT" ls-tree "$TARGET_SHA" -- "$rel" 2>/dev/null)" ]; then
        continue
      fi
      rm -rf "$RELEASE_ROOT/node_modules/$scope/$pkg"
      log "pruned post-pin workspace package $scope/$pkg (source $rel absent from target ref ${TARGET_SHA:0:10} — added to staging after the pin; pinned code cannot import it)"
    done < <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null)
  done
  return 0
}
prune_post_pin_workspace_pkgs

# 3c. Workspace-resolution gate (EI-2118) — fail the swap BEFORE any restart ---
# A workspace package the release tree cannot resolve is invisible until the
# operator boots and crash-loops on "Cannot find module", which then health-fails
# into a rollback FLAP (fbd1c134<->0a5d3074, 2026-06-20). The deploy's verify-paths
# step runs only AFTER the restart cutover, so it cannot prevent that. Catch it
# HERE, loudly, while the live operator is still untouched: if step 3 left (or, in
# mode=skip, never synced) any package that resolves in the integration tree but
# not in the release tree, abort non-zero so the deploy's `swap` step fails cleanly
# (no migrate, no restart) instead of cutting over to a tree that cannot boot. In
# `auto` mode step 3's copy already re-links any break, so this should only ever
# fire when the copy genuinely could not produce a resolvable tree. Post-pin
# packages (case (b) above) were pruned by prune_post_pin_workspace_pkgs, so a
# hit here is a REAL in-pin resolution break.
unresolved="$(unresolved_workspace_pkgs)"
if [ -n "$unresolved" ]; then
  echo "[setup-release] FATAL: release tree cannot resolve workspace package(s): $unresolved" >&2
  echo "[setup-release] aborting BEFORE restart — the swapped tree would crash-loop the operator" >&2
  echo "[setup-release] (re-run with --node-modules force to rebuild node_modules from the integration tree)" >&2
  exit 1
fi

# 3c-2. Pinned workspace RUNTIME BUILDS --------------------------------------
# EI-20453835015280838: workspace symlinks resolve into the RELEASE tree, not
# the integration tree (the isolation guarantee in this script's header). That
# matters for submodule packages whose runtime entry points are generated and
# gitignored. `libs/generic/sse`, for example, commits `src/` but intentionally
# exposes CommonJS `require`/`default` entries from `dist/`. Step 2 clones the
# exact pinned submodule SHA and step 1 correctly removes ignored output from a
# prior pin, so a release checkout has NO `dist/` until it is rebuilt. Staging
# masks the defect because its developer tree already has a locally-built dist;
# tests/typechecks use the package's `import: ./src/index.ts` condition, while
# the real operator boot reaches `require: ./dist/index.js` and fails only in
# the pre-cutover preflight.
#
# Build from the PINNED release source. Never copy these outputs from the
# integration tree: a submodule may already have moved past TARGET_SHA, and
# copying its ignored dist would mix two source revisions in one deployment.
# The registry is deliberately explicit and is policed repository-wide by
# setup-release-checkout-workspace-builds.test.ts: any new workspace package
# that exposes a gitignored `main`/`require`/`default` target must be registered
# here or that detector fails before the same class can reach deploy again.
RUNTIME_BUILD_WORKSPACES=(
  "@papercusp/sse"
)

build_pinned_workspace_runtime_outputs() {
  local workspace scope package manifest integration_workspace_root release_workspace_root
  for workspace in "${RUNTIME_BUILD_WORKSPACES[@]}"; do
    scope="${workspace%%/*}"
    package="${workspace#*/}"
    manifest="$RELEASE_ROOT/node_modules/$scope/$package/package.json"

    # Rollback refs may predate a registered workspace. The post-pin prune
    # above already removes its dangling symlink; absence here is therefore an
    # expected no-op, not a reason an old known-good pin should become
    # undeployable.
    if [ ! -e "$manifest" ]; then
      log "pinned runtime workspace $workspace absent at ${TARGET_SHA:0:10} — skipping build"
      continue
    fi

    # A submodule can exist at an older rollback pin before the root manifest
    # registered it as an npm workspace. `npm --workspace ... run build` is not
    # valid there even though node_modules still exposes the package symlink.
    # Treat root workspace membership—not source-directory presence—as the
    # compatibility boundary, so a forward-only registry never makes a known-
    # good older release impossible to restore.
    if ! (cd "$RELEASE_ROOT" && npm --workspace "$workspace" pkg get name >/dev/null 2>&1); then
      log "pinned runtime workspace $workspace is not registered at ${TARGET_SHA:0:10} — skipping build"
      continue
    fi

    # Step 2 replaces submodule source wholesale, including its gitignored
    # package-local node_modules. If the root dependency snapshot was otherwise
    # unchanged, step 3 legitimately skips its global refresh and the package
    # build silently falls back to the root toolchain (TypeScript 6 instead of
    # @papercusp/sse's pinned 5.9 in the incident that earned this guard).
    # Restore the workspace-local dependency tree explicitly, using the same
    # atomic hardlink copier as the root refresh. This remains source-consistent:
    # all release node_modules are sourced from the integration dependency
    # snapshot; only package SOURCE is pinned independently.
    integration_workspace_root="$(readlink -f "$INTEGRATION_ROOT/node_modules/$scope/$package" 2>/dev/null || true)"
    release_workspace_root="$(readlink -f "$RELEASE_ROOT/node_modules/$scope/$package" 2>/dev/null || true)"
    if [ -n "$integration_workspace_root" ] && [ -d "$integration_workspace_root/node_modules" ]; then
      case "$integration_workspace_root:$release_workspace_root" in
        "$INTEGRATION_ROOT"/*:"$RELEASE_ROOT"/*)
          log "restoring package-local toolchain for $workspace"
          sync_one_node_modules "$integration_workspace_root/node_modules" "$release_workspace_root/node_modules"
          ;;
        *)
          echo "[setup-release] FATAL: runtime workspace $workspace resolves outside the integration/release roots — refusing a cross-tree toolchain copy" >&2
          return 1
          ;;
      esac
    fi

    log "building pinned runtime output for $workspace"
    # Keep build stdout visible on failure. TypeScript reports diagnostics on
    # stdout, and discarding it reduced the original deploy failure to an opaque
    # lifecycle exit code with no actionable file/line evidence.
    if ! (cd "$RELEASE_ROOT" && npm --workspace "$workspace" run build); then
      echo "[setup-release] FATAL: pinned runtime build failed for $workspace at ${TARGET_SHA:0:10} — refusing a release tree whose declared runtime entry points may be absent" >&2
      return 1
    fi
  done
}
build_pinned_workspace_runtime_outputs

# 3d. Native-addon ABI guard (infra-fail-fast-build-integrity-2026-06-19 P-003) -
# The hardlink-copied node_modules (step 3) carry whatever Node ABI the
# INTEGRATION tree was built under. If that differs from the RUNTIME Node, the
# broken binary ships to green: the 2026-06-19 outage was better-sqlite3 built
# for Node 22 (ABI 127) while the service runs Node 25 (ABI 141) → "Module did
# not self-register", mem0 never came up, every memory-touching handler hung
# behind a green health check. The pin (.nvmrc / package.json engines = Node 25)
# + dropping nvm22 from the unit PATH make a mismatch unlikely; THIS makes the
# refresh SELF-HEAL it: verify each runtime-critical native addon LOADS under the
# same `node` the operator boots with, and `npm rebuild` it in place on a
# mismatch so the release checkout's binary always matches the runtime ABI.
# Cheap when already correct (load-check only — no rebuild). Non-fatal: the
# deploy-gate native-addon preflight (lib/native-addon-preflight.ts) is the hard
# block; this turns that block into auto-recovery. Addon set mirrors the
# preflight's DEFAULT_REQUIRED_ADDONS (env override PAPERCUSP_PREFLIGHT_ADDONS).
# Named function so it can be extracted + unit-tested in setup-release-checkout-deps.test.ts
# (same sed-extraction pattern as need_node_modules / sync_one_node_modules).
# Reads RELEASE_ROOT + PAPERCUSP_PREFLIGHT_ADDONS from the outer scope.
rebuild_stale_native_addons() {
  command -v node >/dev/null 2>&1 || { log "skip native-addon ABI guard (node not on PATH — pre-build phase)"; return 0; }
  local node_abi
  node_abi="$(node -p 'process.versions.modules' 2>/dev/null || echo '?')"
  local -a _addons
  IFS=',' read -ra _addons <<< "${PAPERCUSP_PREFLIGHT_ADDONS:-better-sqlite3}"
  local addon _result=0
  for addon in "${_addons[@]}"; do
    addon="${addon//[[:space:]]/}"   # trim whitespace
    [ -n "$addon" ] || continue
    [ -d "$RELEASE_ROOT/node_modules/$addon" ] || continue   # not installed on this path
    if (cd "$RELEASE_ROOT" && node -e "require('$addon')") >/dev/null 2>&1; then
      continue   # loads cleanly under the runtime Node — ABI matches, nothing to do
    fi
    log "WARN native addon '$addon' will not load under Node ABI $node_abi — rebuilding in the release checkout"
    if (cd "$RELEASE_ROOT" && npm rebuild "$addon") >/dev/null 2>&1 \
       && (cd "$RELEASE_ROOT" && node -e "require('$addon')") >/dev/null 2>&1; then
      log "native addon '$addon' rebuilt OK for Node ABI $node_abi"
    else
      log "ERROR native addon '$addon' STILL will not load after rebuild — the deploy-gate addon preflight will block this promotion"
      _result=1
    fi
  done
  return $_result
}
rebuild_stale_native_addons

# 3b. Gitignored RUNTIME ASSETS under apps/operator/public --------------------
# EI-19373176486666620. Step 1's `clean -fdqx -e node_modules` is deliberately
# total (WI-5366: a stale gitignored cache from a PRIOR checkout at a DIFFERENT
# sha is a correctness risk), but it cannot tell a stale CACHE from a required
# RUNTIME ASSET — and `apps/operator/public/` is full of the latter: vditor,
# porcupine, excalidraw, monaco and the ort-wasm-* blobs are ALL gitignored,
# provisioned by apps/operator/scripts/setup-*-runtime.sh via postinstall.
#
# So the gate's tree never had them, and a test that asserts one can NEVER pass
# here however many times it is re-fired. Observed live 2026-08-02: candidate
# 38ae7faf went red on `vditor mirror missing at .../public/vditor/dist/js/lute/
# lute.min.js` (vditor-cdn.test.ts, WI-7088) — a permanent red-pin on main for
# the whole fleet, not a flake. porcupine-cdn.test.ts asserts the same shape.
#
# Same treatment node_modules already gets in step 3, and for the same stated
# reason ("untracked by design"): provision from the integration tree rather
# than re-download. Hardlink first — lute.min.js alone is ~3.9MB and the gate
# host is not reliably networked, so re-running the setup scripts here would
# trade a deterministic red for a flaky one.
#
# ONLY fills entries MISSING from the release tree, so anything tracked at
# TARGET_SHA always wins; every failure is non-fatal (a missing asset must
# surface as the owning test's red, never as an aborted tree setup).
PUBLIC_ASSET_REL="apps/operator/public"
if [ -d "$INTEGRATION_ROOT/$PUBLIC_ASSET_REL" ]; then
  _provisioned_assets=0
  while IFS= read -r _ignored_entry; do
    [ -n "$_ignored_entry" ] || continue
    _asset_src="$INTEGRATION_ROOT/$_ignored_entry"
    _asset_dst="$RELEASE_ROOT/$_ignored_entry"
    [ -e "$_asset_src" ] || continue
    [ -e "$_asset_dst" ] && continue
    mkdir -p "$(dirname "$_asset_dst")" 2>/dev/null || true
    if cp -al "$_asset_src" "$_asset_dst" 2>/dev/null ||
      cp -a "$_asset_src" "$_asset_dst" 2>/dev/null; then
      _provisioned_assets=$((_provisioned_assets + 1))
    else
      log "WARN could not provision gitignored runtime asset $_ignored_entry"
    fi
  done <<EOF
$(git -C "$INTEGRATION_ROOT" status --porcelain --ignored -- "$PUBLIC_ASSET_REL" 2>/dev/null |
    sed -n 's|^!! ||p' | sed 's|/$||')
EOF
  log "provisioned $_provisioned_assets gitignored runtime asset(s) under $PUBLIC_ASSET_REL"
fi

# 4. SPA dist (deploys only) -------------------------------------------------
# operator-vite/dist is UNTRACKED, so a fresh swap serves whatever dist was
# last built in this tree — found 25h STALE on 2026-06-06 (the /admin/git tab
# was missing from the deployed SPA while the server code was current). The
# DEPLOY passes --build-spa so what :3070 serves is always built from the
# deployed sha; the green-checkpoint tree skips it (nothing serves its SPA).
# Deliberately does NOT set PAPERCUSP_RETAIN_DIST_CHUNKS=0: this build lands in
# the RELEASE checkout, which is REUSED across deploys and is what SERVES :3070
# to live desktop windows. A wiping build here yanks the hashed chunks those
# windows are pinned to — the same stale-chunk 404 the retain default exists to
# prevent — so the deploy build WANTS retention (growth is bounded by the TTL
# prune, and index.html always points at the new chunks). The opt-out belongs
# only to builds whose dist/ is PACKAGED into a shipped artifact; see
# papercusp-desktop/bin/build-desktop-sidecar.sh and shouldRetainDistChunks()
# in apps/operator-vite/dev-dist-prune.ts. Plan
# `dist-chunk-retention-default-2026-07-26` P-002 — do not "fix" this by adding =0.
if [ "$BUILD_SPA" = "1" ]; then
  log "building operator-vite SPA dist at the deployed sha (this can take a minute)"
  (cd "$RELEASE_ROOT" && npm --workspace @papercusp/operator-vite run build 1>/dev/null) || {
    echo "[setup-release] SPA build FAILED — the swap would serve a stale SPA; aborting" >&2
    exit 1
  }
fi

log "release checkout ready at $RELEASE_ROOT (detached $TARGET_SHA)"
