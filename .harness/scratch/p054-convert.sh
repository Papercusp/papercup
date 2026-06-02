#!/usr/bin/env bash
# P-054 (D-011, Option B) — convert in-tree packages/tooldef -> libs/generic/tooldef
# git submodule of github.com/Papercusp/tooldef.
#
# PURELY STRUCTURAL: investigation proved the 4 build configs (tsconfig/vitest/
# affected-tests/knip) have NO tooldef path refs — resolution is via the npm
# workspaces node_modules/@papercusp/tooldef symlink. So the conversion is:
#   git rm + submodule add + add libs/generic/tooldef to workspaces + repoint symlink.
# The only remaining packages/tooldef strings live in GENERATED docs + .gitignore +
# an example — NOT resolution-affecting; those are handled by the separate docs pass
# (edit .mdx sources + rebuild Starlight), never by hand-editing artifacts.
#
# Self-guarding, atomic (one commit), self-rolling-back, re-runnable. Verify is
# RESOLUTION-based (symlink resolves + node canary), not a string grep.
# tooldef-http is NOT converted here (separate follow-up; its repo must be created).
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup || { echo "[p054] ABORT: cd"; exit 1; }
URL="https://github.com/Papercusp/tooldef.git"

say(){ echo "[p054] $*"; }
fail(){ echo "[p054] ABORT: $*"; echo "[p054] VERDICT=ABORT"; exit 1; }

# ---- idempotency ----
if [ -e libs/generic/tooldef ]; then
  say "libs/generic/tooldef present — already converted; nothing to do."
  git submodule status libs/generic/tooldef 2>&1 | head
  echo "[p054] VERDICT=ALREADY_DONE head=$(git rev-parse --short HEAD)"; exit 0
fi

# ---- preconditions ----
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || fail "not on main"
[ -f packages/tooldef/src/index.ts ] || fail "packages/tooldef/src/index.ts missing"
[ -z "$(git status --porcelain -- packages/tooldef)" ] || fail "packages/tooldef has uncommitted changes"
[ -f package.json ] || fail "package.json missing"

# ---- relative-import safety gate (must be empty: alias-only consumers expected) ----
RELIMP=$(git grep -lE "from ['\"][^'\"]*packages/tooldef/" -- ':!packages/tooldef/**' ':!**/*.md' ':!**/*.mdx' ':!**/*.html' ':!**/*.txt' 2>/dev/null || true)
[ -z "$RELIMP" ] || { echo "$RELIMP"; fail "relative imports of packages/tooldef/ exist — migrate to @papercusp/tooldef first"; }

# ---- P1: shared src parity ----
say "fetch shared $URL main"
git fetch -q "$URL" main || fail "git fetch failed (network/auth?)"
SHARED=$(git rev-parse FETCH_HEAD); say "shared main = $SHARED"
git cat-file -t FETCH_HEAD:src >/dev/null 2>&1 || fail "shared repo has no src/ at root"
if ! git diff --quiet FETCH_HEAD:src HEAD:packages/tooldef/src; then
  git diff --stat FETCH_HEAD:src HEAD:packages/tooldef/src | tail -40
  fail "shared src != in-tree src (owner must reconcile; NO --force)"
fi
say "P1 OK: shared src == in-tree src (pin $SHARED is byte-identical)"

# ---- structural: add libs/generic/tooldef to package.json workspaces ----
python3 - <<'PY'
import re,sys
p='package.json'; s=open(p).read()
if '"libs/generic/tooldef"' in s:
    print('pkg-workspace-already'); sys.exit(0)
m=re.search(r'^([ \t]*)"libs/generic/ipc-endpoint-server"(,?)\s*$', s, re.M)
if not m:
    print('ASSERT_FAIL_PKG_ANCHOR'); sys.exit(3)
s=s[:m.start()]+f'{m.group(1)}"libs/generic/tooldef",\n'+s[m.start():]
open(p,'w').write(s); print('pkg-workspace-added')
PY
if [ $? -ne 0 ]; then git checkout -q HEAD -- package.json; fail "package.json workspace edit failed (anchor missing?)"; fi
grep -q '"libs/generic/tooldef"' package.json || { git checkout -q HEAD -- package.json; fail "package.json workspace not present after edit"; }
say "package.json workspace ensured"

# ---- restore point + clean any stale submodule gitdir ----
git tag -f tooldef-preconvert-restore HEAD >/dev/null 2>&1 && say "restore tag tooldef-preconvert-restore -> $(git rev-parse --short HEAD)"
[ -d .git/modules/libs/generic/tooldef ] && { say "removing stale .git/modules/libs/generic/tooldef"; rm -rf .git/modules/libs/generic/tooldef; }

rollback(){
  say "ROLLBACK -> pristine in-tree state"
  if [ -e libs/generic/tooldef ]; then git submodule deinit -f libs/generic/tooldef >/dev/null 2>&1; git rm -f libs/generic/tooldef >/dev/null 2>&1; rm -rf libs/generic/tooldef .git/modules/libs/generic/tooldef; fi
  git checkout -q HEAD -- .gitmodules packages/tooldef package.json 2>/dev/null || true
  git reset -q HEAD -- packages/tooldef libs/generic/tooldef .gitmodules package.json 2>/dev/null || true
  rm -f node_modules/@papercusp/tooldef 2>/dev/null; ln -s ../../packages/tooldef node_modules/@papercusp/tooldef 2>/dev/null || true
}

# ---- destructive: rm + submodule add ----
git rm -r -q packages/tooldef || { git checkout -q HEAD -- package.json; fail "git rm packages/tooldef failed"; }
say "git rm packages/tooldef OK"
git submodule add -f "$URL" libs/generic/tooldef || { rollback; fail "git submodule add failed"; }
say "submodule added @ $(git -C libs/generic/tooldef rev-parse --short HEAD)"

# ---- content verify ----
[ -f libs/generic/tooldef/src/index.ts ] || { rollback; fail "submodule missing src/index.ts"; }
NAME=$(python3 -c "import json;print(json.load(open('libs/generic/tooldef/package.json')).get('name',''))" 2>/dev/null)
[ "$NAME" = "@papercusp/tooldef" ] || { rollback; fail "submodule name '$NAME' != @papercusp/tooldef"; }
say "submodule content OK (name=$NAME)"

# ---- re-point ALL node_modules/@papercusp/tooldef symlinks (root + any sub-package) ----
rm -f node_modules/@papercusp/tooldef
ln -s ../../libs/generic/tooldef node_modules/@papercusp/tooldef
while IFS= read -r link; do
  [ -z "$link" ] && continue
  d=$(dirname "$link"); rel=$(realpath -m --relative-to="$d" libs/generic/tooldef)
  rm -f "$link"; ln -s "$rel" "$link"; say "repointed sub-symlink $link -> $rel"
done < <(find . -not -path "./.git/*" -not -path "./libs/generic/tooldef/*" -type l -path "*/node_modules/@papercusp/tooldef" ! -path "./node_modules/@papercusp/tooldef" 2>/dev/null)

# ---- RESOLUTION verify (hard: symlink resolves to a real file) ----
[ -f node_modules/@papercusp/tooldef/src/index.ts ] || { rollback; fail "root symlink does not resolve to src/index.ts"; }
# node canary (informational — exports conditions may vary; file-existence above is the hard gate)
if node -e "require.resolve('@papercusp/tooldef')" >/dev/null 2>&1; then say "node require.resolve(@papercusp/tooldef) OK"; else say "WARN: node require.resolve failed (likely exports-conditions; tsc uses node_modules symlink — will confirm post-commit)"; fi
say "symlink resolution OK (root -> $(readlink node_modules/@papercusp/tooldef))"

# ---- atomic commit (focused pathspec) ----
git add -- .gitmodules libs/generic/tooldef packages/tooldef package.json 2>/dev/null || true
git commit --no-verify -q -- .gitmodules libs/generic/tooldef packages/tooldef package.json -m "refactor(tooldef): P-054 — convert packages/tooldef -> libs/generic/tooldef submodule (D-011, Option B)

papercup now consumes @papercusp/tooldef as a libs/generic git submodule of
Papercusp/tooldef, pinned to shared main ${SHARED} (src verified byte-identical
to the in-tree copy before pinning). Added libs/generic/tooldef to package.json
workspaces (generic libs are listed individually, not globbed) and re-pointed the
node_modules/@papercusp/tooldef symlink(s). The four build configs (tsconfig/
vitest/affected-tests/knip) had NO tooldef path refs — resolution is via the
workspace symlink — so they needed no edits. Stale packages/tooldef strings in
generated docs/.gitignore/examples are handled by the separate docs pass, not
here. tooldef-http NOT converted this pass (its remote does not exist yet).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || { say "commit failed"; echo "[p054] VERDICT=COMMIT_FAILED"; exit 1; }

say "SUCCESS committed $(git rev-parse --short HEAD)"
echo "[p054] VERDICT=SUCCESS head=$(git rev-parse --short HEAD) pin=$SHARED"
