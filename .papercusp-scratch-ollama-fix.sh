#!/bin/bash
# EI-18661577149752049 — install `ollama` (non-optional peer of mem0ai/oss) once the
# in-flight green-checkpoint run finishes. Additive-only install (dry-run verified:
# 4 added / 0 removed), so the WI-5801 prune hazard does not apply.
set -u
cd /home/marsh-office/papercupai-workspace/papercusp || exit 1
LOG=/tmp/ollama-fix.log
exec >>"$LOG" 2>&1
echo "=== START $(date -Is) ==="

gate_procs() { ps -eo cmd --no-headers | grep -c '[g]reen-checkpoint\.ts'; }

# 1. Wait for the live gate run to clear (cap ~30 min).
for i in $(seq 1 180); do
  n=$(gate_procs)
  if [ "$n" -eq 0 ]; then echo "gate clear after $((i*10))s"; break; fi
  sleep 10
done
if [ "$(gate_procs)" -ne 0 ]; then
  echo "ABORT: gate run still live after 30min"; exit 9
fi

# 2. Re-verify the prune hazard is still absent (nothing extraneous to remove).
EXTRA=$(node -e '
const fs=require("fs");
const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));
const keys=new Set(Object.keys(lock.packages||{}));
const present=[];
for(const e of fs.readdirSync("node_modules",{withFileTypes:true})){
  if(!e.isDirectory()&&!e.isSymbolicLink())continue;
  if(e.name.startsWith("."))continue;
  if(e.name.startsWith("@")){let s=[];try{s=fs.readdirSync("node_modules/"+e.name,{withFileTypes:true});}catch{}
    for(const x of s){if(x.isDirectory()||x.isSymbolicLink())present.push(e.name+"/"+x.name);}}
  else present.push(e.name);
}
console.log(present.filter(p=>!keys.has("node_modules/"+p)).length);
')
echo "extraneous-before-install: $EXTRA"
if [ "$EXTRA" != "0" ]; then
  echo "ABORT: $EXTRA extraneous packages present — an install would PRUNE them (WI-5801 hazard). Investigate first."
  exit 8
fi

# 3. Install.
echo "--- npm install $(date -Is) ---"
timeout 600 npm install --no-audit --no-fund 2>&1 | tail -15
echo "npm exit: ${PIPESTATUS[0]}"

# 4. Boot-integrity: every CRITICAL_BOOT_MODULE must still resolve.
echo "--- boot-integrity check $(date -Is) ---"
node -e '
const mods=["@papercusp/plugin-loader","@papercusp/operator-core","@modelcontextprotocol/sdk/package.json","mem0ai","hono","postgres","chokidar"];
let bad=0;
for(const m of mods){try{require.resolve(m);console.log("OK  ",m);}catch(e){bad++;console.log("FAIL",m,e.message.split("\n")[0]);}}
try{require.resolve("ollama");console.log("OK   ollama (the fix)");}catch(e){bad++;console.log("FAIL ollama",e.message.split("\n")[0]);}
console.log(bad===0?"BOOT-INTEGRITY: ALL RESOLVE":"BOOT-INTEGRITY: "+bad+" MISSING");
'
echo "--- bg-host status ---"
systemctl --user is-active papercup-bg-host.service 2>&1
echo "=== DONE $(date -Is) ==="
