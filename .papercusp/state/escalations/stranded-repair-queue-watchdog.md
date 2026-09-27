---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':86A '0':33A,56A,58A '1':13A,32A '14h':24A '1790482805518':108A '2':60A '3':51A,54A 'admit':57A,95A 'age':30A 'alarm':82A 'attempt':35A 'await':28A 'awaiting-fix':27A 'candid':10A,18A 'cc83bd6e4ae0':19A 'cc83bd6e4ae0f098a3db329c37103ede67dc4c08':11A 'clear':83A 'decis':46A 'detail':16A 'dispatch':48A 'dispatch-fix':47A 'document':101A 'emit':106A 'fals':15A 'fix':88A 'fixer':29A,34A,38A,49A 'frozen':17A 'gate':40A 'green':59A,104A 'hand':67A 'har':7A 'held':21A,43A 'held-liv':42A 'kind':1A 'land':87A 'leg':52A,79A 'live':44A 'main':22A 'manifest':50A 'must':63A 'name':65A 'noth':84A 'op':73A,94A 'ownership':41A 'p':85A 'papercusp':9A 'path':62A,96A 'pathless':61A 'per':78A,99A 'per-leg':77A 'phase':26A 'pictur':80A 'queue':5A,45A,72A,93A 'read':68A 'record':39A 'red':55A 'releas':69A,90A 'repair':4A,71A,92A 'repair-queu':70A,91A 'retir':97A 'rung':12A,31A 'slug':8A 'status':74A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':105A 'unreach':103A 'unreachable-green':102A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"cc83bd6e4ae0f098a3db329c37103ede67dc4c08\",\"rung\":1,\"stranded\":false,\"detail\":\"Frozen candidate cc83bd6e4ae0 has held main for ~14h in phase 'awaiting-fixer' (age rung 1, 0 fixer attempt(s); NO fixer recorded; gate ownership held-live; queue decision 'dispatch-fixer'). Manifest: 3 leg(s) — 3 red, 0 admitted, 0 green, 2 pathless (paths must be named by hand). Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790482805518}"
mtime_ms: 1790482805518
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


