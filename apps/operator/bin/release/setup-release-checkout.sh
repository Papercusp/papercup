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
done < <(git -C "$INTEGRATION_ROOT" config -f .gitmodules --get-regexp '\.path$' | awk '{print $2}')

# 3. node_modules ----------------------------------------------------------
need_node_modules() {
  case "$NODE_MODULES_MODE" in
    skip) return 1 ;;
    force) return 0 ;;
    auto)
      # Copy when the release tree has no root node_modules yet, the root
      # lockfile differs (deps changed), OR the workspace package set changed.
      # The last case is the subtle one: a newly-added @papercusp/@papercup
      # workspace package gets a node_modules symlink that the ROOT package-lock
      # does NOT always reflect, so the lockfile-only heuristic skipped the copy
      # and the release operator boot-crashed with "Cannot find module
      # @papercusp/<new-pkg>" (release-gate-ready-branch cutover, 2026-06-05).
      [ -d "$RELEASE_ROOT/node_modules" ] || return 0
      for scope in @papercusp @papercup; do
        if ! diff -q <(ls -1 "$INTEGRATION_ROOT/node_modules/$scope" 2>/dev/null | sort) \
                     <(ls -1 "$RELEASE_ROOT/node_modules/$scope" 2>/dev/null | sort) >/dev/null 2>&1; then
          return 0
        fi
      done
      if [ -f "$INTEGRATION_ROOT/package-lock.json" ] && [ -f "$RELEASE_ROOT/package-lock.json" ]; then
        ! cmp -s "$INTEGRATION_ROOT/package-lock.json" "$RELEASE_ROOT/package-lock.json"
        return $?
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
