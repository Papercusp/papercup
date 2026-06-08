#!/usr/bin/env bash
cd /home/marsh-office/papercupai-workspace/papercup
LOG=.papercusp/scratch/test-green
echo "SUBMOD-POPULATE START $(date)"
while read d; do
  [ -z "$d" ] && continue
  name=$(echo "$d" | tr '/' '_')
  ( cd "$d" && VITEST_MAX_FORKS=3 timeout 240 npx vitest run > "$OLDPWD/$LOG/popsub-$name.log" 2>&1; echo "$d exit $?" )
done < /tmp/submodule_dvc_dirs.txt
echo "SUBMOD-POPULATE DONE $(date)"
