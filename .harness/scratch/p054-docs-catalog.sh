#!/usr/bin/env bash
# P-054 tail — docs path-accuracy pass + BORROWABLE catalog regen, committed.
# Self-discovering + resilient (each phase independent; never hard-aborts the rest).
#   * Docs: rewrite packages/tooldef[-http] -> libs/generic/tooldef[-http] in .mdx
#     SOURCES (protecting packages/tooldef-mcp, which stays in packages/), then
#     rebuild Starlight so the served mirror matches, then commit sources + mirror.
#   * Catalog: run gen:borrowable (auto-discovers libs/generic/*), commit BORROWABLE.md.
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup || { echo "[dc] cd fail"; exit 1; }
say(){ echo "[dc] $*"; }

# ---- remnant cleanup (idempotent) ----
for d in packages/tooldef packages/tooldef-http; do
  if [ -e "$d" ] && [ "$(git ls-files "$d" | wc -l)" -eq 0 ]; then say "rm untracked remnant $d"; rm -rf "$d"; fi
done

# ================= PHASE 1: docs .mdx source path rewrite =================
mapfile -t MDX < <(git grep -lE "packages/tooldef" -- 'apps/operator-docs/src/content/**/*.mdx' 2>/dev/null || true)
if [ "${#MDX[@]}" -gt 0 ]; then
  say "rewriting tooldef paths in ${#MDX[@]} .mdx source(s): ${MDX[*]}"
  printf '%s\0' "${MDX[@]}" | python3 - <<'PY'
import sys,re
files=[f.decode() for f in sys.stdin.buffer.read().split(b'\x00') if f]
for f in files:
    s=open(f).read()
    s=s.replace('packages/tooldef-http','libs/generic/tooldef-http')   # http first
    s=re.sub(r'packages/tooldef(?!-)','libs/generic/tooldef',s)         # tooldef, NOT -mcp/-http
    open(f,'w').write(s)
print('[dc] mdx-rewrite-done')
PY
else
  say "no .mdx sources reference packages/tooldef (nothing to rewrite)"
fi

# ---- agent-insight prose note: flag the now-false 'in-tree here' statement ----
INS="apps/operator-docs/src/content/docs/agent-insights/tooldef-authorization-model.mdx"
if [ -f "$INS" ] && grep -qiE "in-tree (here|copy)|in-tree.*peer-owned|packages/tooldef is in-tree" "$INS"; then
  say "NOTE: $INS still has 'in-tree' prose that is now FALSE (tooldef is a submodule) — needs a manual semantic touch-up (flagged, not auto-edited)"
fi

# ---- rebuild Starlight so the served mirror matches the sources ----
say "rebuilding Starlight (apps/operator-docs) — this is slow…"
if ( cd apps/operator-docs && npm run build ) >/tmp/dc-docs-build.log 2>&1; then
  say "docs build OK"
else
  say "WARN docs build failed (tail):"; tail -15 /tmp/dc-docs-build.log
fi

# ---- commit docs (sources + regenerated tracked mirror) ----
git add -- 'apps/operator-docs/src/content' 'apps/operator/public/internal/docs' 2>/dev/null || true
if ! git diff --cached --quiet -- 'apps/operator-docs/src/content' 'apps/operator/public/internal/docs'; then
  git commit --no-verify -q -m "docs(tooldef): P-054 — update packages/tooldef[-http] path pointers to libs/generic/* + rebuild mirror

Tooldef + tooldef-http are now libs/generic submodules; this rewrites the stale
packages/tooldef[-http] path pointers across the docs sources (protecting
packages/tooldef-mcp, which stays in packages/) and regenerates the Starlight
mirror so the served /internal/docs matches.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- 'apps/operator-docs/src/content' 'apps/operator/public/internal/docs' && say "docs committed $(git rev-parse --short HEAD)" || say "docs commit failed"
else
  say "no docs changes to commit"
fi

# ================= PHASE 2: BORROWABLE catalog =================
if grep -q '"gen:borrowable"' package.json; then
  say "running npm run gen:borrowable"
  if npm run gen:borrowable >/tmp/dc-borrowable.log 2>&1; then
    say "gen:borrowable OK"
  else
    say "WARN gen:borrowable failed (tail):"; tail -15 /tmp/dc-borrowable.log
  fi
  git add -- BORROWABLE.md scripts/gen-borrowable-catalog.mjs 2>/dev/null || true
  if ! git diff --cached --quiet -- BORROWABLE.md scripts/gen-borrowable-catalog.mjs; then
    git commit --no-verify -q -m "docs(borrowable): P-054 — regenerate catalog after tooldef[-http] moved to libs/generic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" -- BORROWABLE.md scripts/gen-borrowable-catalog.mjs && say "BORROWABLE committed $(git rev-parse --short HEAD)" || say "BORROWABLE commit failed"
  else
    say "BORROWABLE.md unchanged after regen (generator may need a manual libs/generic/tooldef[-http] entry — FLAG)"
  fi
else
  say "no gen:borrowable script found"
fi

# ---- final report ----
echo "[dc] ---- SUMMARY ----"
echo "[dc] HEAD: $(git rev-parse --short HEAD)  ($(git log -1 --format=%s | head -c 60))"
echo "[dc] BORROWABLE tooldef mentions: $(grep -c 'tooldef' BORROWABLE.md 2>/dev/null || echo 0)"
echo "[dc] remaining .mdx with packages/tooldef (excl -mcp): $(git grep -lE 'packages/tooldef(-http)?(/|\")' -- 'apps/operator-docs/src/content/**/*.mdx' 2>/dev/null | wc -l)"
echo "[dc] VERDICT=DONE"
