---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':82A '0':34A,54A '1':50A,52A,56A '1055f289d864':19A '1055f289d8648443c166880b5a0791e1d062f693':11A '1790308501405':104A '2':13A,33A,47A '22h':24A 'admit':53A,91A 'age':31A 'alarm':78A 'attempt':36A 'candid':10A,18A 'clear':79A 'decis':42A 'detail':16A 'document':97A 'emit':102A 'fals':15A 'fix':84A 'fixer':35A,39A 'frozen':17A 'green':55A,100A 'hand':63A 'har':7A 'held':21A 'kind':1A 'land':83A 'leg':48A,75A 'main':22A 'manifest':46A 'must':59A 'name':61A 'noth':80A 'op':69A,90A 'p':81A 'papercusp':9A 'path':58A,92A 'pathless':57A 'per':74A,95A 'per-leg':73A 'phase':26A 'pictur':76A 'queue':5A,41A,68A,89A 'read':64A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':51A 'releas':65A,86A 'repair':4A,45A,67A,88A 'repair-queu':66A,87A 'retir':93A 'rung':12A,32A 'slug':8A 'status':70A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':101A 'unreach':99A 'unreachable-green':98A 'verifi':30A,44A 'verify-repair':43A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"1055f289d8648443c166880b5a0791e1d062f693\",\"rung\":2,\"stranded\":false,\"detail\":\"Frozen candidate 1055f289d864 has held main for ~22h in phase 'ready-to-verify' (age rung 2, 0 fixer attempt(s); NO fixer recorded; queue decision 'verify-repair'). Manifest: 2 leg(s) — 1 red, 1 admitted, 0 green, 1 pathless (paths must be named by hand). Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790308501405}"
mtime_ms: 1790308501405
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


