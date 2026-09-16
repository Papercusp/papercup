---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'12728084':13A '1789566490649':95A '2.2':29A '29':11A,17A '3.5':19A 'advanc':27A,35A 'affect':74A 'attribut':89A 'behind':4A,21A 'behindm':12A 'checkpoint':26A,51A,63A 'checkpoint-run':62A 'commit':18A 'commitsbehind':10A 'coverag':84A 'detail':14A 'emit':93A 'engin':49A 'fail':76A,81A,92A 'file':77A,82A,86A 'fire':56A 'first':85A 'fix':66A 'flight':55A 'fresh':58A 'gate':32A,59A 'green':25A 'green-checkpoint':24A 'h':20A,30A 'har':7A 'killed/wedged':43A 'kind':1A 'line':78A 'main':3A,15A,36A 'main-behind-staging-watchdog':2A 'mean':87A 'name':69A,79A 'noth':91A 'papercusp':9A 'read':83A 'red':40A 'regardless':37A 'releas':61A 'routin':48A 'run':44A,52A,60A,64A 'slug':8A 'stage':5A,22A 'test':75A 'verdict':41A,71A 'watchdog':6A 'wedg':47A"
escalation: "{\"kind\":\"main-behind-staging-watchdog\",\"harness_slug\":\"papercusp\",\"commitsBehind\":29,\"behindMs\":12728084,\"detail\":\"`main` is 29 commits / ~3.5h behind `staging` (no green-checkpoint advance in ~2.2h) — the gate is not advancing main, regardless of why (red verdicts, a killed/wedged run, or a wedged routine engine). No checkpoint run is in flight. Fire a fresh gate run (release:checkpoint-run), then fix what it names — its verdict's own AFFECTED_TESTS_FAILING_FILES line names the failing files (read `coverage` first — `files=[]` means \\\"not attributable\\\", NOT \\\"nothing failed\\\").\",\"emitted_at\":1789566490649}"
mtime_ms: 1789566490649
phase: "main-behind-staging-watchdog"
risk_tier: null
supervisor_notes: null
---


