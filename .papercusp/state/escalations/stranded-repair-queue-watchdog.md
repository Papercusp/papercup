---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':74A '0':34A,52A,54A '133f127778e5':19A '133f127778e5900d17e433942571f507a03a6e9e':11A '1790207060522':96A '17h':24A '2':13A,33A,47A,50A 'admit':53A,83A 'age':31A 'alarm':70A 'attempt':36A 'candid':10A,18A 'clear':71A 'decis':42A 'detail':16A 'document':89A 'emit':94A 'fals':15A 'fix':76A 'fixer':35A,39A 'frozen':17A 'green':55A,92A 'har':7A 'held':21A 'kind':1A 'land':75A 'leg':48A,67A 'main':22A 'manifest':46A 'noth':72A 'op':61A,82A 'p':73A 'papercusp':9A 'path':84A 'per':66A,87A 'per-leg':65A 'phase':26A 'pictur':68A 'queue':5A,41A,60A,81A 'read':56A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':51A 'releas':57A,78A 'repair':4A,45A,59A,80A 'repair-queu':58A,79A 'retir':85A 'rung':12A,32A 'slug':8A 'status':62A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':93A 'unreach':91A 'unreachable-green':90A 'verifi':30A,44A 'verify-repair':43A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"133f127778e5900d17e433942571f507a03a6e9e\",\"rung\":2,\"stranded\":false,\"detail\":\"Frozen candidate 133f127778e5 has held main for ~17h in phase 'ready-to-verify' (age rung 2, 0 fixer attempt(s); NO fixer recorded; queue decision 'verify-repair'). Manifest: 2 leg(s) — 2 red, 0 admitted, 0 green. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790207060522}"
mtime_ms: 1790207060522
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


