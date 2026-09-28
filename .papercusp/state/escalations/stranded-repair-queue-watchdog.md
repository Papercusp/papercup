---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':87A '0':34A,59A '1':13A,33A,55A,61A '12h':24A '1790592555151':109A '2':57A '3':52A 'ac857b4ba0f1':19A 'ac857b4ba0f1c2e78683cd1366c6bfaca6320068':11A 'admit':58A,96A 'age':31A 'alarm':83A 'attempt':36A 'candid':10A,18A 'clear':84A 'decis':47A 'detail':16A 'document':102A 'emit':107A 'fals':15A 'fix':89A 'fixer':35A,39A 'frozen':17A 'gate':41A 'green':60A,105A 'hand':68A 'har':7A 'held':21A,44A 'held-liv':43A 'kind':1A 'land':88A 'leg':53A,80A 'live':45A 'main':22A 'manifest':51A 'must':64A 'name':66A 'noth':85A 'op':74A,95A 'ownership':42A 'p':86A 'papercusp':9A 'path':63A,97A 'pathless':62A 'per':79A,100A 'per-leg':78A 'phase':26A 'pictur':81A 'queue':5A,46A,73A,94A 'read':69A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':56A 'releas':70A,91A 'repair':4A,50A,72A,93A 'repair-queu':71A,92A 'retir':98A 'rung':12A,32A 'slug':8A 'status':75A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':106A 'unreach':104A 'unreachable-green':103A 'verifi':30A,49A 'verify-repair':48A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"ac857b4ba0f1c2e78683cd1366c6bfaca6320068\",\"rung\":1,\"stranded\":false,\"detail\":\"Frozen candidate ac857b4ba0f1 has held main for ~12h in phase 'ready-to-verify' (age rung 1, 0 fixer attempt(s); NO fixer recorded; gate ownership held-live; queue decision 'verify-repair'). Manifest: 3 leg(s) — 1 red, 2 admitted, 0 green, 1 pathless (paths must be named by hand). Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790592555151}"
mtime_ms: 1790592555151
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


