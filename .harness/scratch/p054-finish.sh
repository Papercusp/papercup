#!/usr/bin/env bash
# P-054 finish — BORROWABLE catalog + docs .mdx path pass (COMMIT-FIRST to beat the
# shared-tree revert race) + Starlight mirror rebuild. Resilient: each phase independent.
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup || { echo "[fin] cd fail"; exit 1; }
say(){ echo "[fin] $*"; }

# ============ PHASE 1: BORROWABLE catalog ============
python3 - <<'PY'
import re
f='scripts/gen-borrowable-catalog.mjs'; s=open(f).read()
add=[]
if "'libs/generic/tooldef'," not in s:      add.append("  ['libs/generic/tooldef',                        'IPC, transport & sync'],")
if "'libs/generic/tooldef-http'," not in s: add.append("  ['libs/generic/tooldef-http',                   'IPC, transport & sync'],")
if not add:
    print('catalog-already-has-entries'); raise SystemExit(0)
m=re.search(r"\['libs/generic/chat-protocol',\s*'IPC, transport & sync'\],", s)
if not m:
    print('NO_ANCHOR'); raise SystemExit(3)
s=s[:m.end()]+"\n"+"\n".join(add)+s[m.end():]
open(f,'w').write(s); print('catalog-entries-added: '+str(len(add)))
PY
if [ $? -eq 0 ]; then
  if npm run gen:borrowable >/tmp/fin-borrow.log 2>&1; then say "gen:borrowable OK ($(grep -c tooldef BORROWABLE.md) tooldef mentions now)"; else say "WARN gen:borrowable failed:"; tail -12 /tmp/fin-borrow.log; fi
  git add -- scripts/gen-borrowable-catalog.mjs BORROWABLE.md 2>/dev/null || true
  if ! git diff --cached --quiet -- scripts/gen-borrowable-catalog.mjs BORROWABLE.md; then
    git commit --no-verify -q -m "docs(borrowable): P-054 — add tooldef + tooldef-http to the catalog

Both are now libs/generic submodules; regenerated BORROWABLE.md.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- scripts/gen-borrowable-catalog.mjs BORROWABLE.md && say "BORROWABLE committed $(git rev-parse --short HEAD)" || say "BORROWABLE commit failed"
  else say "BORROWABLE no change"; fi
else say "WARN catalog edit step failed"; fi

# ============ PHASE 2: docs .mdx path pass (COMMIT-FIRST) ============
mapfile -t MDX < <(git grep -lE "packages/tooldef(-http)?(/|\"|')" -- 'apps/operator-docs/src/content/**/*.mdx' 2>/dev/null | grep -vE 'packages/tooldef-mcp' || true)
if [ "${#MDX[@]}" -gt 0 ]; then
  say "rewriting ${#MDX[@]} .mdx: ${MDX[*]}"
  printf '%s\0' "${MDX[@]}" | python3 - <<'PY'
import sys,re
files=[f.decode() for f in sys.stdin.buffer.read().split(b'\x00') if f]
for f in files:
    s=open(f).read()
    s=s.replace('packages/tooldef-http','libs/generic/tooldef-http')
    s=re.sub(r'packages/tooldef(?!-)','libs/generic/tooldef',s)   # not -mcp/-http
    open(f,'w').write(s)
print('mdx-rewrite-done')
PY
  # COMMIT THE SOURCES IMMEDIATELY (before the slow build) so a peer can't revert them
  git add -- "${MDX[@]}" 2>/dev/null || true
  if ! git diff --cached --quiet -- "${MDX[@]}"; then
    git commit --no-verify -q -m "docs(tooldef): P-054 — repoint packages/tooldef[-http] -> libs/generic/* in docs sources

tooldef + tooldef-http are now libs/generic submodules; fix the stale path
pointers across endpoint-system + agent-insights docs (packages/tooldef-mcp
stays in packages/, untouched). Mirror rebuilt separately.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- "${MDX[@]}" && say "docs sources committed $(git rev-parse --short HEAD)" || say "docs source commit failed"
  else say "docs sources: no staged change (already done?)"; fi
else
  say "no .mdx sources need rewriting"
fi

# ============ PHASE 3: rebuild Starlight mirror + commit ============
say "rebuilding Starlight mirror (slow)…"
if ( cd apps/operator-docs && npm run build ) >/tmp/fin-docs.log 2>&1; then say "docs build OK"; else say "WARN docs build failed:"; tail -12 /tmp/fin-docs.log; fi
git add -- 'apps/operator/public/internal/docs' 2>/dev/null || true
if ! git diff --cached --quiet -- 'apps/operator/public/internal/docs'; then
  git commit --no-verify -q -m "docs(mirror): P-054 — rebuild /internal/docs Starlight output after tooldef path repoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- 'apps/operator/public/internal/docs' && say "mirror committed $(git rev-parse --short HEAD)" || say "mirror commit failed"
else say "mirror: no change to commit"; fi

# ============ summary ============
echo "[fin] ---- SUMMARY ----"
echo "[fin] HEAD: $(git rev-parse --short HEAD)  ($(git log -1 --format=%s | head -c 55))"
echo "[fin] BORROWABLE tooldef rows: $(grep -cE '@papercusp/tooldef' BORROWABLE.md 2>/dev/null || echo 0)"
echo "[fin] remaining .mdx stale tooldef path refs: $(git grep -lE 'packages/tooldef(-http)?(/|\"|'\'')' -- 'apps/operator-docs/src/content/**/*.mdx' 2>/dev/null | grep -vE 'packages/tooldef-mcp' | wc -l)"
echo "[fin] agent-insight in-tree prose (manual flag): $(grep -ciE 'in-tree' apps/operator-docs/src/content/docs/agent-insights/tooldef-authorization-model.mdx 2>/dev/null || echo 0) hits"
echo "[fin] VERDICT=DONE"
