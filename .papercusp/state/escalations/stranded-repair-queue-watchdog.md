---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':108A '0':33A,54A,56A '1':13A,32A '11h':24A '1790587037307':130A '3':49A,52A,58A 'ac857b4ba0f1':19A 'ac857b4ba0f1c2e78683cd1366c6bfaca6320068':11A 'admit':55A,89A,117A 'age':30A 'alarm':104A 'attempt':35A 'await':28A,68A,79A 'awaiting-fix':27A,78A 'candid':10A,18A 'cannot':76A 'clear':105A 'decis':44A 'detail':16A 'dispatch':46A,84A 'dispatch-fix':45A 'document':123A 'emit':128A 'fix':87A,110A 'fixer':29A,34A,38A,47A,70A,80A 'frozen':17A 'gate':40A 'green':57A,126A 'hand':65A 'har':7A 'held':21A 'kind':1A 'land':109A 'leav':77A 'leg':50A,101A 'live':73A 'main':22A 'manifest':48A 'must':61A 'name':63A 'none':72A 'noth':106A 'one':82A 'op':95A,116A 'ownership':41A 'p':107A 'papercusp':9A 'path':60A,118A 'pathless':59A 'per':100A,121A 'per-leg':99A 'phase':26A 'pictur':102A 'queue':5A,43A,75A,94A,115A 'read':90A 'record':39A 'red':53A 'releas':91A,112A 'repair':4A,93A,114A 'repair-queu':92A,113A 'retir':119A 'rung':12A,31A 'shape':67A 'slug':8A 'status':96A 'strand':3A,14A,66A 'stranded-repair-queue-watchdog':2A 'test':127A 'true':15A 'unown':42A 'unreach':125A 'unreachable-green':124A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"ac857b4ba0f1c2e78683cd1366c6bfaca6320068\",\"rung\":1,\"stranded\":true,\"detail\":\"Frozen candidate ac857b4ba0f1 has held main for ~11h in phase 'awaiting-fixer' (age rung 1, 0 fixer attempt(s); NO fixer recorded; gate ownership unowned; queue decision 'dispatch-fixer'). Manifest: 3 leg(s) — 3 red, 0 admitted, 0 green, 3 pathless (paths must be named by hand). STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one is dispatched or a fix is admitted. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790587037307}"
mtime_ms: 1790587037307
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


