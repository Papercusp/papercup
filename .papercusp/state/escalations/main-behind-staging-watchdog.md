---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'1.1':28A '1789680740404':116A '22334793':13A '39':11A,17A '6.2':19A,40A 'advanc':26A,44A 'affect':95A 'ago':30A 'attribut':110A 'backlog':50A,57A 'behind':4A,21A 'behindm':12A 'checkpoint':72A,84A 'checkpoint-run':83A 'commit':18A,37A 'commitsbehind':10A 'consum':55A 'coverag':105A 'detail':14A 'emit':114A 'end':47A 'engin':70A 'fail':97A,102A,113A 'file':98A,103A,107A 'fire':77A 'first':106A 'fix':87A 'flight':76A 'fresh':79A 'gate':24A,52A,80A 'h':20A,29A,41A 'har':7A 'killed/wedged':64A 'kind':1A 'line':99A 'main':3A,15A,27A 'main-behind-staging-watchdog':2A 'mean':108A 'name':90A,100A 'noth':112A 'old':42A 'oldest':33A 'papercusp':9A 'promot':36A 'read':104A 'red':61A 'regardless':58A 'releas':82A 'routin':69A 'run':65A,73A,81A,85A 'slug':8A 'stage':5A,22A 'still':39A 'test':96A 'tip':46A 'un':35A 'un-promot':34A 'verdict':62A,92A 'watchdog':6A 'wedg':68A"
escalation: "{\"kind\":\"main-behind-staging-watchdog\",\"harness_slug\":\"papercusp\",\"commitsBehind\":39,\"behindMs\":22334793,\"detail\":\"`main` is 39 commits / ~6.2h behind `staging` (the gate DID advance main ~1.1h ago, but the oldest un-promoted commit is still ~6.2h old — it advanced the tip end, not this backlog) — the gate is not consuming this backlog, regardless of why (red verdicts, a killed/wedged run, or a wedged routine engine). No checkpoint run is in flight. Fire a fresh gate run (release:checkpoint-run), then fix what it names — its verdict's own AFFECTED_TESTS_FAILING_FILES line names the failing files (read `coverage` first — `files=[]` means \\\"not attributable\\\", NOT \\\"nothing failed\\\").\",\"emitted_at\":1789680740404}"
mtime_ms: 1789680740404
phase: "main-behind-staging-watchdog"
risk_tier: null
supervisor_notes: null
---


