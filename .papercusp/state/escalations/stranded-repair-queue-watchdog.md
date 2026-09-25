---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':105A '0':33A,51A,53A '1055f289d864':19A '1055f289d8648443c166880b5a0791e1d062f693':11A '1790294231622':127A '18h':24A '2':13A,32A,46A,49A,55A 'admit':52A,86A,114A 'age':30A 'alarm':101A 'attempt':35A 'await':28A,65A,76A 'awaiting-fix':27A,75A 'candid':10A,18A 'cannot':73A 'clear':102A 'decis':41A 'detail':16A 'dispatch':43A,81A 'dispatch-fix':42A 'document':120A 'emit':125A 'fix':84A,107A 'fixer':29A,34A,38A,44A,67A,77A 'frozen':17A 'green':54A,123A 'hand':62A 'har':7A 'held':21A 'kind':1A 'land':106A 'leav':74A 'leg':47A,98A 'live':70A 'main':22A 'manifest':45A 'must':58A 'name':60A 'none':69A 'noth':103A 'one':79A 'op':92A,113A 'p':104A 'papercusp':9A 'path':57A,115A 'pathless':56A 'per':97A,118A 'per-leg':96A 'phase':26A 'pictur':99A 'queue':5A,40A,72A,91A,112A 'read':87A 'record':39A 'red':50A 'releas':88A,109A 'repair':4A,90A,111A 'repair-queu':89A,110A 'retir':116A 'rung':12A,31A 'shape':64A 'slug':8A 'status':93A 'strand':3A,14A,63A 'stranded-repair-queue-watchdog':2A 'test':124A 'true':15A 'unreach':122A 'unreachable-green':121A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"1055f289d8648443c166880b5a0791e1d062f693\",\"rung\":2,\"stranded\":true,\"detail\":\"Frozen candidate 1055f289d864 has held main for ~18h in phase 'awaiting-fixer' (age rung 2, 0 fixer attempt(s); NO fixer recorded; queue decision 'dispatch-fixer'). Manifest: 2 leg(s) — 2 red, 0 admitted, 0 green, 2 pathless (paths must be named by hand). STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one is dispatched or a fix is admitted. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790294231622}"
mtime_ms: 1790294231622
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


