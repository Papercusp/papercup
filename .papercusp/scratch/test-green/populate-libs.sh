#!/usr/bin/env bash
cd /home/marsh-office/papercupai-workspace/papercup
LOG=.papercusp/scratch/test-green
echo "LIB-POPULATE START $(date)"
DIRS=(
  apps/operator-vite libs/agent-chat libs/generic/git-graph
  libs/generic/papergrid/grid libs/generic/papergrid/grid-core libs/generic/ui-primitives
  libs/marketplace-public-ui libs/papercup-shared libs/papercusp-export-state
  libs/papercusp/libs/db libs/papercusp/packages/blueprint-distribution
  libs/papercusp/packages/file-claim libs/papercusp/packages/harness
  libs/papercusp/packages/orchestrator libs/papercusp-publish-auth
  libs/test-config packages/plugin-loader
)
for d in "${DIRS[@]}"; do
  name=$(echo "$d" | tr '/' '_')
  ( cd "$d" && VITEST_MAX_FORKS=3 timeout 240 npx vitest run > "$OLDPWD/$LOG/poplib-$name.log" 2>&1; echo "$d exit $?" )
done
echo "LIB-POPULATE DONE $(date)"
