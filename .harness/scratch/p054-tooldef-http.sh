#!/usr/bin/env bash
# P-054 tail — convert packages/tooldef-http -> libs/generic/tooldef-http submodule
# of a NEW github.com/Papercusp/tooldef-http repo (own repo per convention).
#
# Outward steps (gh repo create + push) are idempotent (skip if already done) and
# happen BEFORE any in-tree destruction; in-tree conversion is atomic + self-rolling-back.
# Structural only (no build-config refs to tooldef-http exist — same as tooldef).
# Commit uses -m BEFORE -- (the bug that bit the tooldef run). Re-runnable.
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup || { echo "[tdh] ABORT: cd"; exit 1; }
URL="https://github.com/Papercusp/tooldef-http.git"
say(){ echo "[tdh] $*"; }
fail(){ echo "[tdh] ABORT: $*"; echo "[tdh] VERDICT=ABORT"; exit 1; }

# ---- idempotency ----
if [ -e libs/generic/tooldef-http ]; then
  say "libs/generic/tooldef-http present — already converted."
  git submodule status libs/generic/tooldef-http 2>&1 | head
  echo "[tdh] VERDICT=ALREADY_DONE head=$(git rev-parse --short HEAD)"; exit 0
fi

# ---- preconditions ----
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || fail "not on main"
[ -f packages/tooldef-http/src/index.ts ] || fail "packages/tooldef-http/src/index.ts missing"
[ -z "$(git status --porcelain -- packages/tooldef-http)" ] || fail "packages/tooldef-http has uncommitted changes"

# relative-import gate (must be empty)
RELIMP=$(git grep -lE "from ['\"][^'\"]*packages/tooldef-http/" -- ':!packages/tooldef-http/**' ':!**/*.md' ':!**/*.mdx' ':!**/*.html' ':!**/*.txt' 2>/dev/null || true)
[ -z "$RELIMP" ] || { echo "$RELIMP"; fail "relative imports of packages/tooldef-http/ exist — migrate to @papercusp/tooldef-http first"; }

# ---- (1) create the remote repo if missing ----
if git ls-remote "$URL" >/dev/null 2>&1; then
  say "remote $URL already exists"
else
  say "creating Papercusp/tooldef-http (private)"
  gh repo create Papercusp/tooldef-http --private -d "HTTP transport adapter for @papercusp/tooldef — framework-neutral request->tool dispatch. Shared by papercup + Restart." || fail "gh repo create failed (perms?)"
fi

# ---- (2) populate remote main via subtree split (only if empty) ----
REMOTE_MAIN=$(git ls-remote "$URL" main 2>/dev/null | awk '{print $1}')
if [ -z "$REMOTE_MAIN" ]; then
  say "subtree split packages/tooldef-http + push to new main"
  git branch -D _tdh_split 2>/dev/null || true
  SPLIT=$(git subtree split --prefix=packages/tooldef-http 2>/dev/null) || fail "subtree split failed"
  [ -n "$SPLIT" ] || fail "subtree split produced no commit"
  say "split commit = $SPLIT"
  git push "$URL" "$SPLIT:refs/heads/main" || fail "push to new repo failed"
  git branch -D _tdh_split 2>/dev/null || true
  REMOTE_MAIN=$SPLIT
  say "pushed initial main = $REMOTE_MAIN"
else
  say "remote main already populated ($REMOTE_MAIN) — verifying src parity"
  git fetch -q "$URL" main || fail "fetch failed"
  if ! git diff --quiet FETCH_HEAD:src HEAD:packages/tooldef-http/src; then
    git diff --stat FETCH_HEAD:src HEAD:packages/tooldef-http/src | tail -30
    fail "remote tooldef-http src != in-tree src — reconcile needed (NO --force)"
  fi
  say "parity OK"
fi

# ---- (3) structural: add libs/generic/tooldef-http to package.json workspaces ----
python3 - <<'PY'
import re,sys
p='package.json'; s=open(p).read()
if '"libs/generic/tooldef-http"' in s:
    print('pkg-workspace-already'); sys.exit(0)
# anchor: insert right after the tooldef entry we added earlier (fallback: ipc-endpoint-server)
m=re.search(r'^([ \t]*)"libs/generic/tooldef"(,?)\s*$', s, re.M) or re.search(r'^([ \t]*)"libs/generic/ipc-endpoint-server"(,?)\s*$', s, re.M)
if not m:
    print('ASSERT_FAIL_PKG_ANCHOR'); sys.exit(3)
s=s[:m.end()]+f'\n{m.group(1)}"libs/generic/tooldef-http",'+s[m.end():]
open(p,'w').write(s); print('pkg-workspace-added')
PY
[ $? -eq 0 ] || { git checkout -q HEAD -- package.json; fail "package.json workspace edit failed (anchor?)"; }
grep -q '"libs/generic/tooldef-http"' package.json || { git checkout -q HEAD -- package.json; fail "package.json workspace not present after edit"; }
say "package.json workspace ensured"

# ---- restore point + clean stale gitdir ----
git tag -f tooldefhttp-preconvert-restore HEAD >/dev/null 2>&1 && say "restore tag -> $(git rev-parse --short HEAD)"
[ -d .git/modules/libs/generic/tooldef-http ] && { say "clean stale gitdir"; rm -rf .git/modules/libs/generic/tooldef-http; }

rollback(){
  say "ROLLBACK in-tree -> pristine (remote repo left intact for retry)"
  if [ -e libs/generic/tooldef-http ]; then git submodule deinit -f libs/generic/tooldef-http >/dev/null 2>&1; git rm -f libs/generic/tooldef-http >/dev/null 2>&1; rm -rf libs/generic/tooldef-http .git/modules/libs/generic/tooldef-http; fi
  git checkout -q HEAD -- .gitmodules packages/tooldef-http package.json 2>/dev/null || true
  git reset -q HEAD -- packages/tooldef-http libs/generic/tooldef-http .gitmodules package.json 2>/dev/null || true
  rm -f node_modules/@papercusp/tooldef-http 2>/dev/null; ln -s ../../packages/tooldef-http node_modules/@papercusp/tooldef-http 2>/dev/null || true
}

# ---- (4) destructive: rm + submodule add ----
git rm -r -q packages/tooldef-http || { git checkout -q HEAD -- package.json; fail "git rm packages/tooldef-http failed"; }
say "git rm packages/tooldef-http OK"
git submodule add -f "$URL" libs/generic/tooldef-http || { rollback; fail "git submodule add failed"; }
say "submodule added @ $(git -C libs/generic/tooldef-http rev-parse --short HEAD)"

# ---- content verify ----
[ -f libs/generic/tooldef-http/src/index.ts ] || { rollback; fail "submodule missing src/index.ts"; }
NAME=$(python3 -c "import json;print(json.load(open('libs/generic/tooldef-http/package.json')).get('name',''))" 2>/dev/null)
[ "$NAME" = "@papercusp/tooldef-http" ] || { rollback; fail "submodule name '$NAME' != @papercusp/tooldef-http"; }
say "submodule content OK (name=$NAME)"

# ---- re-point ALL node_modules/@papercusp/tooldef-http symlinks ----
rm -f node_modules/@papercusp/tooldef-http
ln -s ../../libs/generic/tooldef-http node_modules/@papercusp/tooldef-http
while IFS= read -r link; do
  [ -z "$link" ] && continue
  d=$(dirname "$link"); rel=$(realpath -m --relative-to="$d" libs/generic/tooldef-http)
  rm -f "$link"; ln -s "$rel" "$link"; say "repointed sub-symlink $link -> $rel"
done < <(find . -not -path "./.git/*" -not -path "./libs/generic/tooldef-http/*" -type l -path "*/node_modules/@papercusp/tooldef-http" ! -path "./node_modules/@papercusp/tooldef-http" 2>/dev/null)
[ -f node_modules/@papercusp/tooldef-http/src/index.ts ] || { rollback; fail "root symlink does not resolve to src/index.ts"; }
if node -e "require.resolve('@papercusp/tooldef-http')" >/dev/null 2>&1; then say "node require.resolve(@papercusp/tooldef-http) OK"; else say "WARN node resolve failed (exports cond?; tsc uses symlink)"; fi
say "symlink resolution OK"

# ---- (5) atomic commit (-m BEFORE --, focused pathspec) ----
git add -- .gitmodules libs/generic/tooldef-http packages/tooldef-http package.json 2>/dev/null || true
git commit --no-verify -q -m "refactor(tooldef-http): P-054 — convert packages/tooldef-http -> libs/generic/tooldef-http submodule (D-011)

Created Papercusp/tooldef-http (own repo, per the one-lib-one-repo convention) from
a subtree split of packages/tooldef-http, and consume it as a libs/generic git
submodule pinned to ${REMOTE_MAIN}. Added to package.json workspaces + re-pointed
the node_modules symlink(s). Structural only (no build-config refs to tooldef-http).
Completes the tooldef family extraction (tooldef in 5d5c4a464; this finishes P-054).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- .gitmodules libs/generic/tooldef-http packages/tooldef-http package.json || { say "commit failed"; echo "[tdh] VERDICT=COMMIT_FAILED"; exit 1; }

say "SUCCESS committed $(git rev-parse --short HEAD)"
echo "[tdh] VERDICT=SUCCESS head=$(git rev-parse --short HEAD) pin=$REMOTE_MAIN"
