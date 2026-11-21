#!/bin/sh
# Install an offline candidate and print the path to an ACP client fragment.
set -eu
umask 077
if [ "$#" -ne 5 ]; then
  echo "Usage: sh setup.sh PACKAGE.tgz INSTALL_PREFIX OPERATOR_URL WORKSPACE TOKEN_FILE" >&2
  exit 2
fi
artifact=$(realpath "$1")
prefix=$(realpath -m "$2")
mkdir -p "$prefix"
npm install --legacy-peer-deps --offline --ignore-scripts --no-audit --no-fund --prefix "$prefix" "$artifact" >&2
python3 - "$prefix" "$3" "$4" "$5" <<'PY'
import json,os,sys
from pathlib import Path
prefix=Path(sys.argv[1])
pkg=prefix/'node_modules'/'psu-acp'
config=json.loads((pkg/'config.example.json').read_text())
config.update(operatorUrl=sys.argv[2],workspace=sys.argv[3],tokenFile=str(Path(sys.argv[4]).expanduser().resolve()),stateDir=str(prefix/'sessions'))
cfg=prefix/'psu-acp.json'
entry={'agent_servers':{'Papercusp':{'type':'custom','command':str(prefix/'node_modules/.bin/psu-acp'),'args':['--config',str(cfg)]}}}
for path,obj in [(cfg,config),(prefix/'client.json',entry)]:
    payload=json.dumps(obj,indent=2)+'\n'
    if path.exists():
        if path.read_text()!=payload:raise SystemExit('Existing configuration differs: '+str(path))
        continue
    with path.open('x') as f:f.write(payload)
print(prefix/'client.json')
PY
