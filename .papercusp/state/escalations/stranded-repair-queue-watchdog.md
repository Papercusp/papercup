---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':87A '0':34A,57A,59A '1':52A,55A,61A '1790520472134':109A '24h':24A '3':13A,33A 'admit':58A,96A 'age':31A 'alarm':83A 'attempt':36A 'candid':10A,18A 'cc83bd6e4ae0':19A 'cc83bd6e4ae0f098a3db329c37103ede67dc4c08':11A 'clear':84A 'decis':47A 'detail':16A 'document':102A 'emit':107A 'fals':15A 'fix':89A 'fixer':35A,39A 'frozen':17A 'gate':41A 'green':60A,105A 'hand':68A 'har':7A 'held':21A,44A 'held-liv':43A 'kind':1A 'land':88A 'leg':53A,80A 'live':45A 'main':22A 'manifest':51A 'must':64A 'name':66A 'noth':85A 'op':74A,95A 'ownership':42A 'p':86A 'papercusp':9A 'path':63A,97A 'pathless':62A 'per':79A,100A 'per-leg':78A 'phase':26A 'pictur':81A 'queue':5A,46A,73A,94A 'read':69A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':56A 'releas':70A,91A 'repair':4A,50A,72A,93A 'repair-queu':71A,92A 'retir':98A 'rung':12A,32A 'slug':8A 'status':75A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':106A 'unreach':104A 'unreachable-green':103A 'verifi':30A,49A 'verify-repair':48A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"cc83bd6e4ae0f098a3db329c37103ede67dc4c08\",\"rung\":3,\"stranded\":false,\"detail\":\"Frozen candidate cc83bd6e4ae0 has held main for ~24h in phase 'ready-to-verify' (age rung 3, 0 fixer attempt(s); NO fixer recorded; gate ownership held-live; queue decision 'verify-repair'). Manifest: 1 leg(s) — 1 red, 0 admitted, 0 green, 1 pathless (paths must be named by hand). Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790520472134}"
mtime_ms: 1790520472134
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


