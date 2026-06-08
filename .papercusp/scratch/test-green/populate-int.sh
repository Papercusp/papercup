#!/usr/bin/env bash
cd /home/marsh-office/papercupai-workspace/papercup
LOG=.papercusp/scratch/test-green
echo "INT-POPULATE START $(date)"
echo "### operator-core INTEGRATION (OP_PORT=3170)"
( cd packages/operator-core && OP_PORT=3170 OP_HOST=localhost VITEST_MAX_FORKS=4 npx vitest run --config vitest.integration.config.ts > "$OLDPWD/$LOG/popint-oc.log" 2>&1; echo "oc-int exit $?" )
echo "### apps/operator INTEGRATION"
( cd apps/operator && VITEST_MAX_FORKS=4 npx vitest run --config vitest.integration.config.ts > "$OLDPWD/$LOG/popint-ao.log" 2>&1; echo "ao-int exit $?" )
echo "INT-POPULATE DONE $(date)"
