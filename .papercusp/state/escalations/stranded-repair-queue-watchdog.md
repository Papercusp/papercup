---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':110A '0':33A,56A,58A '1':51A,54A,60A '1790516868284':132A '2':13A,32A '23h':24A 'admit':57A,91A,119A 'age':30A 'alarm':106A 'attempt':35A 'await':28A,70A,81A 'awaiting-fix':27A,80A 'candid':10A,18A 'cannot':78A 'cc83bd6e4ae0':19A 'cc83bd6e4ae0f098a3db329c37103ede67dc4c08':11A 'clear':107A 'decis':46A 'detail':16A 'dispatch':48A,86A 'dispatch-fix':47A 'document':125A 'emit':130A 'expir':44A 'fix':89A,112A 'fixer':29A,34A,38A,49A,72A,82A 'frozen':17A 'gate':40A 'green':59A,128A 'hand':67A 'har':7A 'held':21A 'kind':1A 'land':111A 'leas':43A 'lease-expir':42A 'leav':79A 'leg':52A,103A 'live':75A 'main':22A 'manifest':50A 'must':63A 'name':65A 'none':74A 'noth':108A 'one':84A 'op':97A,118A 'ownership':41A 'p':109A 'papercusp':9A 'path':62A,120A 'pathless':61A 'per':102A,123A 'per-leg':101A 'phase':26A 'pictur':104A 'queue':5A,45A,77A,96A,117A 'read':92A 'record':39A 'red':55A 'releas':93A,114A 'repair':4A,95A,116A 'repair-queu':94A,115A 'retir':121A 'rung':12A,31A 'shape':69A 'slug':8A 'status':98A 'strand':3A,14A,68A 'stranded-repair-queue-watchdog':2A 'test':129A 'true':15A 'unreach':127A 'unreachable-green':126A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"cc83bd6e4ae0f098a3db329c37103ede67dc4c08\",\"rung\":2,\"stranded\":true,\"detail\":\"Frozen candidate cc83bd6e4ae0 has held main for ~23h in phase 'awaiting-fixer' (age rung 2, 0 fixer attempt(s); NO fixer recorded; gate ownership lease-expired; queue decision 'dispatch-fixer'). Manifest: 1 leg(s) — 1 red, 0 admitted, 0 green, 1 pathless (paths must be named by hand). STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one is dispatched or a fix is admitted. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790516868284}"
mtime_ms: 1790516868284
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


