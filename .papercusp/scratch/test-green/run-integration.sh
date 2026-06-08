#!/usr/bin/env bash
set -uo pipefail
cd /home/marsh-office/papercupai-workspace/papercup
LOG=.papercusp/scratch/test-green
declare -A WS=(
  [operator-core]=packages/operator-core
  [apps-operator]=apps/operator
  [test-config]=libs/test-config
  [export-state]=libs/papercusp-export-state
)
echo "INTEGRATION RUN START $(date)"
for name in operator-core apps-operator test-config export-state; do
  dir=${WS[$name]}
  echo ""
  echo "########## $name :: test:integration ($dir) ##########"
  npm run test:integration --workspace "$dir" > "$LOG/int-$name.log" 2>&1
  code=$?
  echo "$name exit code: $code"
  tail -15 "$LOG/int-$name.log"
done
echo "INTEGRATION RUN DONE $(date)"
