---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: "gemma-embeddinggemma-300m-768@v1"
body_tsv: "'-010':105A '0':33A,51A,53A '1':13A,32A '133f127778e5':19A '133f127778e5900d17e433942571f507a03a6e9e':11A '1790178034084':127A '2':46A,49A,55A '9h':24A 'admit':52A,86A,114A 'age':30A 'alarm':101A 'attempt':35A 'await':28A,65A,76A 'awaiting-fix':27A,75A 'candid':10A,18A 'cannot':73A 'clear':102A 'decis':41A 'detail':16A 'dispatch':43A,81A 'dispatch-fix':42A 'document':120A 'emit':125A 'fix':84A,107A 'fixer':29A,34A,38A,44A,67A,77A 'frozen':17A 'green':54A,123A 'hand':62A 'har':7A 'held':21A 'kind':1A 'land':106A 'leav':74A 'leg':47A,98A 'live':70A 'main':22A 'manifest':45A 'must':58A 'name':60A 'none':69A 'noth':103A 'one':79A 'op':92A,113A 'p':104A 'papercusp':9A 'path':57A,115A 'pathless':56A 'per':97A,118A 'per-leg':96A 'phase':26A 'pictur':99A 'queue':5A,40A,72A,91A,112A 'read':87A 'record':39A 'red':50A 'releas':88A,109A 'repair':4A,90A,111A 'repair-queu':89A,110A 'retir':116A 'rung':12A,31A 'shape':64A 'slug':8A 'status':93A 'strand':3A,14A,63A 'stranded-repair-queue-watchdog':2A 'test':124A 'true':15A 'unreach':122A 'unreachable-green':121A 'watchdog':6A"
escalation: "{\"kind\":\"stranded-repair-queue-watchdog\",\"harness_slug\":\"papercusp\",\"candidate\":\"133f127778e5900d17e433942571f507a03a6e9e\",\"rung\":1,\"stranded\":true,\"detail\":\"Frozen candidate 133f127778e5 has held main for ~9h in phase 'awaiting-fixer' (age rung 1, 0 fixer attempt(s); NO fixer recorded; queue decision 'dispatch-fixer'). Manifest: 2 leg(s) — 2 red, 0 admitted, 0 green, 2 pathless (paths must be named by hand). STRANDED SHAPE: awaiting a fixer with none live — the queue cannot leave awaiting-fixer until one is dispatched or a fix is admitted. Read release:repair-queue { op:'status' } for the per-leg picture. This alarm clears nothing (P-010): land fixes with release:repair-queue { op:'admit', paths:[...] }; retire only per the documented unreachable-green test.\",\"emitted_at\":1790178034084}"
mtime_ms: 1790178034084
phase: "stranded-repair-queue-watchdog"
risk_tier: null
supervisor_notes: null
---


