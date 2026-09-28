---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':85A '0':34A,57A '1':13A,33A,53A,59A '1790579549338':107A '3':55A '4':50A '9h':24A 'ac857b4ba0f1':19A 'ac857b4ba0f1c2e78683cd1366c6bfaca6320068':11A 'admit':56A,94A 'age':31A 'alarm':81A 'attempt':36A 'candid':10A,18A 'clear':82A 'decis':45A 'detail':16A 'document':100A 'emit':105A 'fals':15A 'fix':87A 'fixer':35A,39A 'frozen':17A 'gate':41A 'green':58A,103A 'hand':66A 'har':7A 'held':21A 'kind':1A 'land':86A 'leg':51A,78A 'main':22A 'manifest':49A 'must':62A 'name':64A 'noth':83A 'op':72A,93A 'ownership':42A 'p':84A 'papercusp':9A 'path':61A,95A 'pathless':60A 'per':77A,98A 'per-leg':76A 'phase':26A 'pictur':79A 'queue':5A,44A,71A,92A 'read':67A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':54A 'releas':68A,89A 'repair':4A,48A,70A,91A 'repair-queu':69A,90A 'retir':96A 'rung':12A,32A 'slug':8A 'status':73A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':104A 'unown':43A 'unreach':102A 'unreachable-green':101A 'verifi':30A,47A 'verify-repair':46A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"ac857b4ba0f1c2e78683cd1366c6bfaca6320068\",\"rung\":1,\"stranded\":false,\"detail\":\"Frozen candidate ac857b4ba0f1 has held main for ~9h in phase 'ready-to-verify' (age rung 1, 0 fixer attempt(s); NO fixer recorded; gate ownership unowned; queue decision 'verify-repair'). Manifest: 4 leg(s) — 1 red, 3 admitted, 0 green, 1 pathless (paths must be named by hand). Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790579549338}"
mtime_ms: 1790579549338
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


