---
rel_path: "portability/census/v26-9-p053-v26-probe-roots-payload.json-74591686b849aebe"
updated_at: 1794231846316
_body: "content"
---

{"work_item_id": "WI-10007347", "title": "Inspect saved credential census roots before bounded producer probe", "script": "const r=await tools.capability.bash({\"command\": \"python3 - <<'PYCODE'\\nimport json,collections\\nx=json.load(open('/tmp/p053-v24-host.json'))\\nrs=[r for r in x['residue'] if r.get('kind')=='path' and 'deploy-credentials/' in r.get('name','')]\\ng=collections.Counter('/'.join(r['name'].split('/')[:4]) for r in rs)\\nprint(json.dumps({'roots':x.get('roots'), 'keys':list(x.keys()), 'credentialResidue':len(rs),'groups':g.most_common(12),'samples':rs[:3]}))\\nPYCODE\", \"cwd\": \"/home/marsh-office/papercupai-workspace/papercusp\", \"work_item_id\": \"WI-10007347\", \"timeout\": 45000});return {status:r.status,exit_code:r.exit_code,output:r.output};", "timeoutSec": 45}
