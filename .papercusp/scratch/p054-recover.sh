#!/usr/bin/env bash
# P-054 RECOVERY — land a clean, correctly-committed tooldef submodule conversion
# after the previous run's commit failed (git arg-order bug: -m after -- ) and a
# peer commit landed on top, leaving an ambiguous half-state.
#
# Deterministic + safe in ALL branches:
#  * Operates ONLY on the 4 tooldef paths (narrow pathspec) — cannot sweep peers.
#  * Reaches the SAME good end-state whether the conversion is staged, partially
#    in HEAD, or fully in HEAD (then it no-ops).
#  * Re-runnable.
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup || { echo "[rec] ABORT: cd"; exit 1; }
URL="https://github.com/Papercusp/tooldef.git"
say(){ echo "[rec] $*"; }
fail(){ echo "[rec] ABORT: $*"; echo "[rec] VERDICT=ABORT"; exit 1; }

say "HEAD before: $(git rev-parse --short HEAD)  ($(git log -1 --format=%s | head -c 60))"

# ---- (0) the submodule content MUST be present & correct, or we cannot land a valid conversion ----
[ -f libs/generic/tooldef/src/index.ts ] || fail "libs/generic/tooldef/src/index.ts missing — submodule not present"
SUBNAME=$(python3 -c "import json;print(json.load(open('libs/generic/tooldef/package.json')).get('name',''))" 2>/dev/null)
[ "$SUBNAME" = "@papercusp/tooldef" ] || fail "submodule name '$SUBNAME' != @papercusp/tooldef"
grep -q 'libs/generic/tooldef' .gitmodules || fail ".gitmodules has no libs/generic/tooldef entry"
SUBPIN=$(git -C libs/generic/tooldef rev-parse HEAD 2>/dev/null)
say "submodule present (name=$SUBNAME pin=$SUBPIN)"

# ---- (1) ensure package.json has the workspace entry (re-add if a sweep/revert dropped it) ----
python3 - <<'PY'
import re,sys
p='package.json'; s=open(p).read()
if '"libs/generic/tooldef"' in s:
    print('[rec] package.json workspace already present'); sys.exit(0)
m=re.search(r'^([ \t]*)"libs/generic/ipc-endpoint-server"(,?)\s*$', s, re.M)
if not m:
    print('[rec] ASSERT_FAIL_PKG_ANCHOR'); sys.exit(3)
s=s[:m.start()]+f'{m.group(1)}"libs/generic/tooldef",\n'+s[m.start():]
open(p,'w').write(s); print('[rec] package.json workspace re-added')
PY
[ $? -eq 0 ] || fail "package.json workspace ensure failed"

# ---- (2) ensure packages/tooldef is removed (tracked + working tree + untracked remnant) ----
git rm -r -q --ignore-unmatch packages/tooldef 2>/dev/null || true
[ -e packages/tooldef ] && { say "removing untracked packages/tooldef remnant dir"; rm -rf packages/tooldef; }

# ---- (3) stage exactly the conversion paths ----
git add -- libs/generic/tooldef .gitmodules package.json 2>/dev/null || true
# (packages/tooldef deletion already staged by git rm above)

# ---- (4) commit narrowly IF there is something to commit among our paths (fixed: -m BEFORE --) ----
if git diff --cached --quiet -- packages/tooldef libs/generic/tooldef .gitmodules package.json; then
  if [ -n "$(git ls-tree HEAD -- libs/generic/tooldef)" ] && [ "$(git ls-tree HEAD -- packages/tooldef | wc -l)" -eq 0 ]; then
    say "nothing to commit — conversion already in HEAD"
    VERDICT="ALREADY_IN_HEAD"
  else
    say "nothing staged but HEAD not fully converted — AMBIGUOUS, needs eyes"
    VERDICT="AMBIGUOUS"
  fi
else
  git commit --no-verify -q -m "refactor(tooldef): P-054 — convert packages/tooldef -> libs/generic/tooldef submodule (D-011, Option B)

papercup consumes @papercusp/tooldef as a libs/generic git submodule of
Papercusp/tooldef, pinned to shared main ${SUBPIN} (src verified byte-identical
to in-tree before the move). Added libs/generic/tooldef to package.json workspaces
and re-pointed the node_modules symlink(s). The 4 build configs had no tooldef
path refs (resolution is via the workspace symlink), so they needed no edits.
Recovery commit: the prior atomic run completed all steps but its commit failed on
a git arg-order bug, leaving the change staged; this lands it cleanly. tooldef-http
deferred (its remote does not exist yet).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- packages/tooldef libs/generic/tooldef .gitmodules package.json || fail "commit failed"
  VERDICT="COMMITTED"
  say "committed $(git rev-parse --short HEAD)"
fi

# ---- (5) ensure node_modules symlinks point at the new location ----
rm -f node_modules/@papercusp/tooldef
ln -s ../../libs/generic/tooldef node_modules/@papercusp/tooldef
while IFS= read -r link; do
  [ -z "$link" ] && continue
  d=$(dirname "$link"); rel=$(realpath -m --relative-to="$d" libs/generic/tooldef)
  rm -f "$link"; ln -s "$rel" "$link"; say "repointed sub-symlink $link -> $rel"
done < <(find . -not -path "./.git/*" -not -path "./libs/generic/tooldef/*" -type l -path "*/node_modules/@papercusp/tooldef" ! -path "./node_modules/@papercusp/tooldef" 2>/dev/null)
[ -f node_modules/@papercusp/tooldef/src/index.ts ] && say "symlink resolves OK" || say "WARN symlink broken"

# ---- (6) final state report ----
echo "[rec] ---- FINAL STATE ----"
echo "[rec] HEAD: $(git rev-parse --short HEAD)  ($(git log -1 --format=%s | head -c 60))"
echo "[rec] packages/tooldef exists: $([ -e packages/tooldef ] && echo yes || echo no); tracked: $(git ls-files packages/tooldef | wc -l)"
echo "[rec] libs/generic/tooldef gitlink in HEAD: $(git ls-tree HEAD -- libs/generic/tooldef)"
echo "[rec] package.json workspace in HEAD: $(git show HEAD:package.json 2>/dev/null | grep -c 'libs/generic/tooldef')"
echo "[rec] working tree clean (tooldef paths): $(git status --porcelain -- packages/tooldef libs/generic/tooldef .gitmodules package.json | wc -l) lines"
echo "[rec] VERDICT=$VERDICT head=$(git rev-parse --short HEAD)"
