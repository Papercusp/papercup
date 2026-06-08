#!/usr/bin/env bash
cd /home/marsh-office/papercupai-workspace/papercup
LOG=.papercusp/scratch/test-green
echo "POPULATE START $(date)"
echo "### operator-core UNIT (records now)"
( cd packages/operator-core && npx vitest run > "$OLDPWD/$LOG/pop-oc-unit.log" 2>&1; echo "oc-unit exit $?" )
echo "### operator-core INTEGRATION (records now) — OP_PORT=3170 for live-e2e"
( cd packages/operator-core && OP_PORT=3170 OP_HOST=localhost npx vitest run --config vitest.integration.config.ts > "$OLDPWD/$LOG/pop-oc-int.log" 2>&1; echo "oc-int exit $?" )
echo "### apps/operator INTEGRATION (records now)"
( cd apps/operator && npx vitest run --config vitest.integration.config.ts > "$OLDPWD/$LOG/pop-ao-int.log" 2>&1; echo "ao-int exit $?" )
echo "POPULATE DONE $(date)"
