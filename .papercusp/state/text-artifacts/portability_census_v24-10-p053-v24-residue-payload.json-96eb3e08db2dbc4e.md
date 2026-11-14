---
rel_path: "portability/census/v24-10-p053-v24-residue-payload.json-96eb3e08db2dbc4e"
updated_at: 1794230641786
_body: "content"
---

{"script": "const r=await tools.capability.bash({\"command\": \"python - <<'PYCODE'\\nimport json,pathlib,collections\\np=pathlib.Path('/tmp/p053-v24-host.json')\\nif not p.exists(): p=pathlib.Path('/tmp/p053-v21-host.json')\\nd=json.loads(p.read_text());res=d['residue'];groups=collections.defaultdict(list)\\nfor r in res:\\n name=r.get('name',r.get('path',''))\\n parts=name.split('/')\\n key=(r.get('kind'),r.get('root'),'/'.join(parts[:2]))\\n groups[str(key)].append(r)\\nsummary={'source':str(p),'scope':d['scope'],'inventory':len(d['inventory']),'residue':len(res),'wholeInstallVerified':d['wholeInstallVerified'],'groups':[{'group':k,'count':len(v),'samples':v[:2]} for k,v in sorted(groups.items(),key=lambda kv:-len(kv[1]))[:18]]}\\npathlib.Path('/tmp/p053-v24-residue-summary.json').write_text(json.dumps(summary));print(json.dumps(summary))\\nPYCODE\", \"cwd\": \"/home/marsh-office/papercupai-workspace/papercusp\", \"work_item_id\": \"WI-10007347\", \"timeout\": 45000});return {status:r.status,exit_code:r.exit_code,output:r.output};", "work_item_id": "WI-10007347", "title": "Summarize existing census residue by kind and declared root", "timeoutSec": 30}
