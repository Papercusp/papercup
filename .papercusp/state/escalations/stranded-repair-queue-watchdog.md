---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':97A '0':33A,51A,53A '1':13A,32A '10h':24A '1790370438828':119A '3':46A,49A '55b22f4e30fe':19A '55b22f4e30fe399d72d6fd006d8995e93780c7f9':11A 'admit':52A,78A,106A 'age':30A 'alarm':93A 'attempt':35A 'await':28A,57A,68A 'awaiting-fix':27A,67A 'candid':10A,18A 'cannot':65A 'clear':94A 'decis':41A 'detail':16A 'dispatch':43A,73A 'dispatch-fix':42A 'document':112A 'emit':117A 'fix':76A,99A 'fixer':29A,34A,38A,44A,59A,69A 'frozen':17A 'green':54A,115A 'har':7A 'held':21A 'kind':1A 'land':98A 'leav':66A 'leg':47A,90A 'live':62A 'main':22A 'manifest':45A 'none':61A 'noth':95A 'one':71A 'op':84A,105A 'p':96A 'papercusp':9A 'path':107A 'per':89A,110A 'per-leg':88A 'phase':26A 'pictur':91A 'queue':5A,40A,64A,83A,104A 'read':79A 'record':39A 'red':50A 'releas':80A,101A 'repair':4A,82A,103A 'repair-queu':81A,102A 'retir':108A 'rung':12A,31A 'shape':56A 'slug':8A 'status':85A 'strand':3A,14A,55A 'stranded-repair-queue-watchdog':2A 'test':116A 'true':15A 'unreach':114A 'unreachable-green':113A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"55b22f4e30fe399d72d6fd006d8995e93780c7f9\",\"rung\":1,\"stranded\":true,\"detail\":\"Frozen candidate 55b22f4e30fe has held main for ~10h in phase 'awaiting-fixer' (age rung 1, 0 fixer attempt(s); NO fixer recorded; queue decision 'dispatch-fixer'). Manifest: 3 leg(s) — 3 red, 0 admitted, 0 green. STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one is dispatched or a fix is admitted. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790370438828}"
mtime_ms: 1790370438828
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


