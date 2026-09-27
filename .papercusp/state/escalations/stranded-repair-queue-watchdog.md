---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':102A '0':33A,56A,58A '1':13A,32A,51A,54A '15h':24A '1790487181124':124A 'admit':57A,83A,111A 'age':30A 'alarm':98A 'attempt':35A 'await':28A,62A,73A 'awaiting-fix':27A,72A 'candid':10A,18A 'cannot':70A 'cc83bd6e4ae0':19A 'cc83bd6e4ae0f098a3db329c37103ede67dc4c08':11A 'clear':99A 'decis':46A 'detail':16A 'dispatch':48A,78A 'dispatch-fix':47A 'document':117A 'emit':122A 'expir':44A 'fix':81A,104A 'fixer':29A,34A,38A,49A,64A,74A 'frozen':17A 'gate':40A 'green':59A,120A 'har':7A 'held':21A 'kind':1A 'land':103A 'leas':43A 'lease-expir':42A 'leav':71A 'leg':52A,95A 'live':67A 'main':22A 'manifest':50A 'none':66A 'noth':100A 'one':76A 'op':89A,110A 'ownership':41A 'p':101A 'papercusp':9A 'path':112A 'per':94A,115A 'per-leg':93A 'phase':26A 'pictur':96A 'queue':5A,45A,69A,88A,109A 'read':84A 'record':39A 'red':55A 'releas':85A,106A 'repair':4A,87A,108A 'repair-queu':86A,107A 'retir':113A 'rung':12A,31A 'shape':61A 'slug':8A 'status':90A 'strand':3A,14A,60A 'stranded-repair-queue-watchdog':2A 'test':121A 'true':15A 'unreach':119A 'unreachable-green':118A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"cc83bd6e4ae0f098a3db329c37103ede67dc4c08\",\"rung\":1,\"stranded\":true,\"detail\":\"Frozen candidate cc83bd6e4ae0 has held main for ~15h in phase 'awaiting-fixer' (age rung 1, 0 fixer attempt(s); NO fixer recorded; gate ownership lease-expired; queue decision 'dispatch-fixer'). Manifest: 1 leg(s) — 1 red, 0 admitted, 0 green. STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one is dispatched or a fix is admitted. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790487181124}"
mtime_ms: 1790487181124
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


