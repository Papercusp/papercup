---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':79A '0':34A,55A,59A '1':52A,57A '1790497381619':101A '18h':24A '2':13A,33A 'admit':58A,88A 'age':31A 'alarm':75A 'attempt':36A 'candid':10A,18A 'cc83bd6e4ae0':19A 'cc83bd6e4ae0f098a3db329c37103ede67dc4c08':11A 'clear':76A 'decis':47A 'detail':16A 'document':94A 'emit':99A 'expir':45A 'fals':15A 'fix':81A 'fixer':35A,39A 'frozen':17A 'gate':41A 'green':60A,97A 'har':7A 'held':21A 'kind':1A 'land':80A 'leas':44A 'lease-expir':43A 'leg':53A,72A 'main':22A 'manifest':51A 'noth':77A 'op':66A,87A 'ownership':42A 'p':78A 'papercusp':9A 'path':89A 'per':71A,92A 'per-leg':70A 'phase':26A 'pictur':73A 'queue':5A,46A,65A,86A 'read':61A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':56A 'releas':62A,83A 'repair':4A,50A,64A,85A 'repair-queu':63A,84A 'retir':90A 'rung':12A,32A 'slug':8A 'status':67A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':98A 'unreach':96A 'unreachable-green':95A 'verifi':30A,49A 'verify-repair':48A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"cc83bd6e4ae0f098a3db329c37103ede67dc4c08\",\"rung\":2,\"stranded\":false,\"detail\":\"Frozen candidate cc83bd6e4ae0 has held main for ~18h in phase 'ready-to-verify' (age rung 2, 0 fixer attempt(s); NO fixer recorded; gate ownership lease-expired; queue decision 'verify-repair'). Manifest: 1 leg(s) — 0 red, 1 admitted, 0 green. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790497381619}"
mtime_ms: 1790497381619
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


