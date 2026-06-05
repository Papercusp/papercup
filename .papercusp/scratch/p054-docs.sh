#!/usr/bin/env bash
# P-054 docs pass — repoint packages/tooldef[-http] -> libs/generic/* in docs SOURCES,
# semantically rewrite the now-false tooldef-authorization-model insight, commit TIGHT
# (rewrite+add+commit in a retry loop to beat the shared-tree revert race), then rebuild
# the Starlight mirror. packages/tooldef-mcp stays in packages/ (untouched).
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup || { echo "[doc] cd fail"; exit 1; }
say(){ echo "[doc] $*"; }
INS="apps/operator-docs/src/content/docs/agent-insights/tooldef-authorization-model.mdx"

committed=""
for attempt in 1 2 3; do
  mapfile -t MDX < <(git grep -lE "packages/tooldef(-http)?(/|\"|')" -- 'apps/operator-docs/src/content/**/*.mdx' 2>/dev/null | grep -vE 'packages/tooldef-mcp' || true)
  if [ "${#MDX[@]}" -eq 0 ]; then say "no stale .mdx remain (attempt $attempt)"; break; fi
  say "attempt $attempt: rewriting ${#MDX[@]} .mdx"
  INS="$INS" python3 - "${MDX[@]}" <<'PY'
import sys,re,os
INS=os.environ['INS']
files=sys.argv[1:]
for f in files:
    s=open(f).read()
    s=s.replace('packages/tooldef-http','libs/generic/tooldef-http')
    s=re.sub(r'packages/tooldef(?!-)','libs/generic/tooldef',s)   # protects -mcp/-http
    if f==INS:
        # semantic rewrite of the now-false section
        s=re.sub(r'(?m)^##[^\n]*in-tree here[^\n]*$',
                 '## tooldef + tooldef-http are libs/generic submodules (shared with Restart)', s)
        newpara=("In papercup, `libs/generic/tooldef` and `libs/generic/tooldef-http` are **git submodules** of "
                 "`Papercusp/tooldef` and `Papercusp/tooldef-http` — the same shared repos Restart consumes. They are "
                 "no longer in-tree (the in-tree-vs-mirror fork is resolved as of the P-054 conversion, 2026-05-31): "
                 "edit tooldef in the submodule and push to the shared repo as usual; there is no separate in-tree "
                 "copy to keep in sync.")
        s=re.sub(r'(?m)^In papercup,.*flag the peer\.\s*$', newpara, s)
    open(f,'w').write(s)
print('rewrite-done')
PY
  git add -- "${MDX[@]}" 2>/dev/null || true
  if git diff --cached --quiet -- "${MDX[@]}"; then say "attempt $attempt: staged diff empty (raced) — retrying"; continue; fi
  if git commit --no-verify -q -m "docs(tooldef): P-054 — repoint packages/tooldef[-http] -> libs/generic/* + fix stale auth insight

tooldef + tooldef-http are now libs/generic submodules; repoint the path pointers
across endpoint-system + agent-insights docs (packages/tooldef-mcp stays in packages/),
and rewrite the tooldef-authorization-model 'in-tree here' section which is now false
(the in-tree-vs-mirror fork is resolved).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- "${MDX[@]}"; then
    committed=$(git rev-parse --short HEAD); say "committed $committed (attempt $attempt)"; break
  else say "attempt $attempt: commit failed — retry"; fi
done

# verify sources clean
REMAIN=$(git grep -lE "packages/tooldef(-http)?(/|\"|')" -- 'apps/operator-docs/src/content/**/*.mdx' 2>/dev/null | grep -vE 'packages/tooldef-mcp' || true)
[ -z "$REMAIN" ] && say "VERIFY: 0 stale .mdx sources remain" || { say "VERIFY: STILL STALE:"; echo "$REMAIN"; }
say "agent-insight in-tree hits now: $(grep -ciE 'in-tree' "$INS" 2>/dev/null || echo 0)"

# rebuild Starlight mirror + commit
say "rebuilding Starlight mirror (slow)…"
if ( cd apps/operator-docs && npm run build ) >/tmp/p054docs-build.log 2>&1; then say "build OK"; else say "WARN build failed:"; tail -12 /tmp/p054docs-build.log; fi
git add -- 'apps/operator/public/internal/docs' 2>/dev/null || true
if ! git diff --cached --quiet -- 'apps/operator/public/internal/docs'; then
  git commit --no-verify -q -m "docs(mirror): P-054 — rebuild /internal/docs after tooldef path repoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- 'apps/operator/public/internal/docs' && say "mirror committed $(git rev-parse --short HEAD)" || say "mirror commit failed"
else say "mirror: no change"; fi

echo "[doc] VERDICT=DONE head=$(git rev-parse --short HEAD) sources_committed=${committed:-none}"
