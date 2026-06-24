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
#   2. submodule SOURCE extracted at each submodule's EXACT pinned sha via
#      `git archive` from the integration tree's LOCAL object store. This is the
#      only thing that works here: many submodule pins are never pushed to origin
#      (the integration tree holds them locally), so a fresh worktree/clone's
#      `submodule update` fails "upload-pack: not our ref". `git archive` reads
#      local objects, produces REAL files (not hardlinks → isolated from peer
#      edits to the integration tree), and pins to the right commit by
#      construction. (All submodules are top-level here — no recursion needed.)
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

INTEGRATION_ROOT="${PAPERCUSP_INTEGRATION_ROOT:-/home/marsh-office/papercupai-workspace/papercup}"
RELEASE_ROOT="${PAPERCUSP_RELEASE_ROOT:-/home/marsh-office/papercupai-workspace/papercup-release}"
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
  git -C "$RELEASE_ROOT" clean -fdq -e node_modules || true
else
  log "creating release worktree at $RELEASE_ROOT"
  git -C "$INTEGRATION_ROOT" worktree add --detach "$RELEASE_ROOT" "$TARGET_SHA"
fi

# 2. Submodule SOURCE — git archive at the exact pinned sha (local objects) ---
log "extracting submodule source at pinned shas (git archive, local objects)"
while IFS= read -r P; do
  [ -n "$P" ] || continue
  [ -d "$INTEGRATION_ROOT/$P" ] || { log "WARN integration submodule missing: $P — skipping"; continue; }
  # The gitlink sha recorded at the release worktree's HEAD for this path.
  S="$(git -C "$RELEASE_ROOT" ls-tree HEAD "$P" 2>/dev/null | awk '{print $3}')"
  [ -n "$S" ] || { log "WARN no gitlink sha for $P — skipping"; continue; }
  rm -rf "${RELEASE_ROOT:?}/$P"
  mkdir -p "$RELEASE_ROOT/$P"
  if git -C "$INTEGRATION_ROOT/$P" archive "$S" 2>/dev/null | tar -x -C "$RELEASE_ROOT/$P" 2>/dev/null; then
    :
  else
    log "WARN git archive $P@$S failed; rsync'ing integration HEAD (pin may drift)"
    rsync -a --exclude='node_modules' --exclude='.git' "$INTEGRATION_ROOT/$P/" "$RELEASE_ROOT/$P/"
  fi
# P-009: read the submodule list from the TARGET commit's .gitmodules blob, NOT the
# integration tree's current working copy — a submodule added/removed on staging while
# the target still pins the old set would otherwise be extracted from the wrong list
# during the transition window. `git config --blob <sha>:.gitmodules` reads the committed
# config; 2>/dev/null + an empty loop is the correct no-op when a sha has no .gitmodules.
done < <(git -C "$INTEGRATION_ROOT" config --blob "${TARGET_SHA}:.gitmodules" --get-regexp '\.path$' 2>/dev/null | awk '{print $2}')

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
  local scope pkg
  for scope in @papercusp @papercup; do
    [ -d "$INTEGRATION_ROOT/node_modules/$scope" ] || continue
    while IFS= read -r pkg; do
      [ -n "$pkg" ] || continue
      [ -e "$INTEGRATION_ROOT/node_modules/$scope/$pkg/package.json" ] || continue
      [ -e "$RELEASE_ROOT/node_modules/$scope/$pkg/package.json" ] && continue
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

if need_node_modules; then
  log "hardlink-copying node_modules from integration tree (this can take a minute)"
  # Enumerate every package-local node_modules in the integration tree (prune so
  # we get the dir itself, not the ones nested inside it — those ride along in the
  # parent's cp -al).
  while IFS= read -r nm; do
    rel="${nm#"$INTEGRATION_ROOT"/}"
    dest="$RELEASE_ROOT/$rel"
    # Stale copy → drop and re-hardlink (cheap; hardlinks share data).
    [ -e "$dest" ] && rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    cp -al "$nm" "$dest"
  done < <(find "$INTEGRATION_ROOT" -name node_modules -type d -prune -print)
  # Record WHICH dep state was just copied: package-lock.json is gitignored, so
  # the checkout above never updates the release tree's copy — without this the
  # `auto` cmp stays permanently dirty and every deploy re-copies node_modules.
  [ -f "$INTEGRATION_ROOT/package-lock.json" ] && cp "$INTEGRATION_ROOT/package-lock.json" "$RELEASE_ROOT/package-lock.json"
  log "node_modules sync complete"
else
  log "node_modules up to date (mode=$NODE_MODULES_MODE) — skipping copy"
fi

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
# fire when the copy genuinely could not produce a resolvable tree.
unresolved="$(unresolved_workspace_pkgs)"
if [ -n "$unresolved" ]; then
  echo "[setup-release] FATAL: release tree cannot resolve workspace package(s): $unresolved" >&2
  echo "[setup-release] aborting BEFORE restart — the swapped tree would crash-loop the operator" >&2
  echo "[setup-release] (re-run with --node-modules force to rebuild node_modules from the integration tree)" >&2
  exit 1
fi

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
if command -v node >/dev/null 2>&1; then
  NODE_ABI="$(node -p 'process.versions.modules' 2>/dev/null || echo '?')"
  IFS=',' read -ra _addons <<< "${PAPERCUSP_PREFLIGHT_ADDONS:-better-sqlite3}"
  for addon in "${_addons[@]}"; do
    addon="${addon//[[:space:]]/}"   # trim whitespace
    [ -n "$addon" ] || continue
    [ -d "$RELEASE_ROOT/node_modules/$addon" ] || continue   # not on this runtime path
    if (cd "$RELEASE_ROOT" && node -e "require('$addon')") >/dev/null 2>&1; then
      continue   # loads cleanly under the runtime Node — ABI matches, nothing to do
    fi
    log "WARN native addon '$addon' will not load under Node ABI $NODE_ABI — rebuilding in the release checkout"
    if (cd "$RELEASE_ROOT" && npm rebuild "$addon") >/dev/null 2>&1 \
       && (cd "$RELEASE_ROOT" && node -e "require('$addon')") >/dev/null 2>&1; then
      log "native addon '$addon' rebuilt OK for Node ABI $NODE_ABI"
    else
      log "ERROR native addon '$addon' STILL will not load after rebuild — the deploy-gate addon preflight will block this promotion"
    fi
  done
else
  log "skip native-addon ABI guard (node not on PATH — pre-build phase)"
fi

# 4. SPA dist (deploys only) -------------------------------------------------
# operator-vite/dist is UNTRACKED, so a fresh swap serves whatever dist was
# last built in this tree — found 25h STALE on 2026-06-06 (the /admin/git tab
# was missing from the deployed SPA while the server code was current). The
# DEPLOY passes --build-spa so what :3070 serves is always built from the
# deployed sha; the green-checkpoint tree skips it (nothing serves its SPA).
if [ "$BUILD_SPA" = "1" ]; then
  log "building operator-vite SPA dist at the deployed sha (this can take a minute)"
  (cd "$RELEASE_ROOT" && npm --workspace @papercusp/operator-vite run build 1>/dev/null) || {
    echo "[setup-release] SPA build FAILED — the swap would serve a stale SPA; aborting" >&2
    exit 1
  }
fi

log "release checkout ready at $RELEASE_ROOT (detached $TARGET_SHA)"
