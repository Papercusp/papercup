---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'1.6':28A '1790436388553':152A '23718259':13A '32':11A,17A '6.6':19A,40A '63m':82A 'advanc':26A,44A 'affect':131A 'ago':30A,83A 'anoth':87A 'attribut':146A 'await':123A 'backlog':50A,57A 'behind':4A,21A 'behindm':12A 'checkpoint':74A,122A 'commit':18A,37A 'commitsbehind':10A 'consum':55A 'cost':112A 'coverag':141A 'detail':14A 'discard':105A 'emit':150A 'end':47A 'engin':70A 'fail':133A,138A,149A 'file':134A,139A,143A 'fire':95A 'first':142A 'flight':78A 'full':114A 'gate':24A,52A 'green':73A 'green-checkpoint':72A 'h':20A,29A,41A 'har':7A 'in-progress':107A 'insid':96A 'killed/wedged':64A 'kind':1A 'launch':86A 'line':135A 'live':98A 'lock':90A 'main':3A,15A,27A 'main-behind-staging-watchdog':2A 'mean':144A 'name':136A 'noth':148A 'old':42A 'oldest':33A 'papercusp':9A 'progress':109A 'promot':36A 're':102A 're-triag':101A 'read':140A 'red':61A,126A 'refus':92A 'regardless':58A 'rescu':110A 'right':79A 'routin':69A 'run':65A,75A,89A,99A,119A 'slug':8A 'stage':5A,22A 'start':81A 'still':39A 'suit':115A 'test':132A 'tip':46A 'triag':103A 'un':35A 'un-promot':34A 'verdict':62A,121A,128A 'wait':116A 'watchdog':6A 'wedg':68A 'window':104A 'would':91A"
escalation: "{\"kind\":\"main-behind-staging-watchdog\",\"harness_slug\":\"papercusp\",\"commitsBehind\":32,\"behindMs\":23718259,\"detail\":\"`main` is 32 commits / ~6.6h behind `staging` (the gate DID advance main ~1.6h ago, but the oldest un-promoted commit is still ~6.6h old — it advanced the tip end, not this backlog) — the gate is not consuming this backlog, regardless of why (red verdicts, a killed/wedged run, or a wedged routine engine). A green-checkpoint run IS IN FLIGHT right now (started ~63m ago) — do NOT launch another: the run lock would refuse it, and firing inside a live run's re-triage window DISCARDS an in-progress rescue and costs a full suite. Wait for this run's verdict (checkpoint:await); if it reds, its verdict's own AFFECTED_TESTS_FAILING_FILES line names the failing files (read `coverage` first — `files=[]` means \\\"not attributable\\\", NOT \\\"nothing failed\\\").\",\"emitted_at\":1790436388553}"
mtime_ms: 1790436388553
phase: "main-behind-staging-watchdog"
risk_tier: null
supervisor_notes: null
---


