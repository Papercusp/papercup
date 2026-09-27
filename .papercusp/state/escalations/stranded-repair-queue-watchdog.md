---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':88A '0':34A,58A,60A '1':13A,33A '12h':24A '1790474972179':110A '2':62A '3':53A,56A 'admit':59A,97A 'age':31A 'alarm':84A 'attempt':36A 'candid':10A,18A 'cc83bd6e4ae0':19A 'cc83bd6e4ae0f098a3db329c37103ede67dc4c08':11A 'clear':85A 'confirm':46A 'decis':48A 'detail':16A 'document':103A 'emit':108A 'fals':15A 'fix':90A 'fixer':35A,39A 'frozen':17A 'gate':41A 'green':61A,106A 'hand':69A 'har':7A 'held':21A,44A 'held-needs-confirm':43A 'kind':1A 'land':89A 'leg':54A,81A 'main':22A 'manifest':52A 'must':65A 'name':67A 'need':45A 'noth':86A 'op':75A,96A 'ownership':42A 'p':87A 'papercusp':9A 'path':64A,98A 'pathless':63A 'per':80A,101A 'per-leg':79A 'phase':26A 'pictur':82A 'queue':5A,47A,74A,95A 'read':70A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':57A 'releas':71A,92A 'repair':4A,51A,73A,94A 'repair-queu':72A,93A 'retir':99A 'rung':12A,32A 'slug':8A 'status':76A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':107A 'unreach':105A 'unreachable-green':104A 'verifi':30A,50A 'verify-repair':49A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"cc83bd6e4ae0f098a3db329c37103ede67dc4c08\",\"rung\":1,\"stranded\":false,\"detail\":\"Frozen candidate cc83bd6e4ae0 has held main for ~12h in phase 'ready-to-verify' (age rung 1, 0 fixer attempt(s); NO fixer recorded; gate ownership held-needs-confirmation; queue decision 'verify-repair'). Manifest: 3 leg(s) — 3 red, 0 admitted, 0 green, 2 pathless (paths must be named by hand). Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790474972179}"
mtime_ms: 1790474972179
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


