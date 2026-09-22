---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':74A '0':52A,54A '1':13A,33A '11h':24A '1790106504378':96A '2':34A '3':47A,50A 'admit':53A,83A 'age':31A 'alarm':70A 'attempt':36A 'candid':10A,18A 'clear':71A 'decis':42A 'detail':16A 'document':89A 'e8ff0cf80505':19A 'e8ff0cf8050563d82fd832ee9b345de6bad73bb3':11A 'emit':94A 'fals':15A 'fix':76A 'fixer':35A,39A 'frozen':17A 'green':55A,92A 'har':7A 'held':21A 'kind':1A 'land':75A 'leg':48A,67A 'main':22A 'manifest':46A 'noth':72A 'op':61A,82A 'p':73A 'papercusp':9A 'path':84A 'per':66A,87A 'per-leg':65A 'phase':26A 'pictur':68A 'queue':5A,41A,60A,81A 'read':56A 'readi':28A 'ready-to-verifi':27A 'record':40A 'red':51A 'releas':57A,78A 'repair':4A,45A,59A,80A 'repair-queu':58A,79A 'retir':85A 'rung':12A,32A 'slug':8A 'status':62A 'strand':3A,14A 'stranded-repair-queue-watchdog':2A 'test':93A 'unreach':91A 'unreachable-green':90A 'verifi':30A,44A 'verify-repair':43A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"e8ff0cf8050563d82fd832ee9b345de6bad73bb3\",\"rung\":1,\"stranded\":false,\"detail\":\"Frozen candidate e8ff0cf80505 has held main for ~11h in phase 'ready-to-verify' (age rung 1, 2 fixer attempt(s); NO fixer recorded; queue decision 'verify-repair'). Manifest: 3 leg(s) — 3 red, 0 admitted, 0 green. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790106504378}"
mtime_ms: 1790106504378
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


