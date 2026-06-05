#!/usr/bin/env bash
# Re-run each operator-core failed integration file in ISOLATION (one at a time,
# low contention) to separate real deterministic failures from box-load flakes.
set -u
cd /home/marsh-office/papercupai-workspace/papercup/packages/operator-core
OUT=/home/marsh-office/papercupai-workspace/papercup/.papercusp/scratch/brief59
FILES=(
  "lib/sync/hyperbee/backfill-local-state.integration.test.ts"
  "lib/__tests__/mint-roundtrip.integration.test.ts"
  "lib/__tests__/ui-control.integration.test.ts"
  "lib/__tests__/power-user-e2e.integration.test.ts"
  "lib/agent-tools/locks/__tests__/su-locks-http-mcp.integration.test.ts"
)
for f in "${FILES[@]}"; do
  base=$(basename "$f" .integration.test.ts)
  log="$OUT/iso-$base.log"
  echo "### RUNNING $f"
  npx vitest run --config vitest.integration.config.ts "$f" > "$log" 2>&1
  code=$?
  summary=$(grep -E "Test Files|^\s*Tests " "$log" | tail -2 | tr '\n' ' ')
  echo "### DONE $base exit=$code :: $summary"
done
echo "ALL_ISOLATED_RERUNS_DONE"
