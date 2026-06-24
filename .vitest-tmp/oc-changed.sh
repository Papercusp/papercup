#\!/usr/bin/env bash
cd /home/marsh-office/papercupai-workspace/papercup/packages/operator-core
export TMPDIR=/home/marsh-office/papercupai-workspace/papercup/.vitest-tmp
export GREEN_CHECKPOINT=1 VITEST_UNIT_TIMEOUT_MS=180000
files=$(sed 's#packages/operator-core/##' /home/marsh-office/papercupai-workspace/papercup/.vitest-tmp/changed-oc-tests.txt | tr '\n' ' ')
echo "START $(date -Is)"
npx vitest run $files --reporter=dot
echo "EXIT $? $(date -Is)"
