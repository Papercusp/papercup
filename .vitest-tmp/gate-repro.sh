#\!/usr/bin/env bash
cd /home/marsh-office/papercupai-workspace/papercup
# strip host identity exactly like buildGreenCheckpointEnv
for k in $(env | grep -oE '^PAPERCUSP_[A-Za-z0-9_]+'); do unset "$k"; done
unset AGENT_MODELS
export GREEN_CHECKPOINT=1 VITEST_MAX_FORKS=8 VITEST_MAX_THREADS=8 AFFECTED_RETRY_FAILED=1 VITEST_UNIT_TIMEOUT_MS=180000
export TMPDIR=/home/marsh-office/papercupai-workspace/papercup/.vitest-tmp
export AFFECTED_BASE=fcd8194db851f18f77c663865e2bc15acfc66330
echo "START $(date -Is)"
npm run test:affected
echo "EXIT $? $(date -Is)"
