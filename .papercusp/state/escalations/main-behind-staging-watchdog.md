---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'101m':61A '1790443882966':131A '3.6':29A '31211211':13A '79':11A,17A '8.7':19A 'advanc':27A,35A 'affect':110A 'ago':62A 'anoth':66A 'attribut':125A 'await':102A 'behind':4A,21A 'behindm':12A 'checkpoint':26A,53A,101A 'commit':18A 'commitsbehind':10A 'cost':91A 'coverag':120A 'detail':14A 'discard':84A 'emit':129A 'engin':49A 'fail':112A,117A,128A 'file':113A,118A,122A 'fire':74A 'first':121A 'flight':57A 'full':93A 'gate':32A 'green':25A,52A 'green-checkpoint':24A,51A 'h':20A,30A 'har':7A 'in-progress':86A 'insid':75A 'killed/wedged':43A 'kind':1A 'launch':65A 'line':114A 'live':77A 'lock':69A 'main':3A,15A,36A 'main-behind-staging-watchdog':2A 'mean':123A 'name':115A 'noth':127A 'papercusp':9A 'progress':88A 're':81A 're-triag':80A 'read':119A 'red':40A,105A 'refus':71A 'regardless':37A 'rescu':89A 'right':58A 'routin':48A 'run':44A,54A,68A,78A,98A 'slug':8A 'stage':5A,22A 'start':60A 'suit':94A 'test':111A 'triag':82A 'verdict':41A,100A,107A 'wait':95A 'watchdog':6A 'wedg':47A 'window':83A 'would':70A"
escalation: "{\"kind\":\"main-behind-staging-watchdog\",\"harness_slug\":\"papercusp\",\"commitsBehind\":79,\"behindMs\":31211211,\"detail\":\"`main` is 79 commits / ~8.7h behind `staging` (no green-checkpoint advance in ~3.6h) — the gate is not advancing main, regardless of why (red verdicts, a killed/wedged run, or a wedged routine engine). A green-checkpoint run IS IN FLIGHT right now (started ~101m ago) — do NOT launch another: the run lock would refuse it, and firing inside a live run's re-triage window DISCARDS an in-progress rescue and costs a full suite. Wait for this run's verdict (checkpoint:await); if it reds, its verdict's own AFFECTED_TESTS_FAILING_FILES line names the failing files (read `coverage` first — `files=[]` means \\\"not attributable\\\", NOT \\\"nothing failed\\\").\",\"emitted_at\":1790443882966}"
mtime_ms: 1790443882966
phase: "main-behind-staging-watchdog"
risk_tier: null
supervisor_notes: null
---


