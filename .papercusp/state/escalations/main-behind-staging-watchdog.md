---
authority: null
body_embedding: null
body_embedding_mode: null
body_tsv: "'13107802':13A '1783885869084':69A '2.2':29A '3.6':19A '70':11A,17A 'actual':64A 'advanc':27A,35A 'behind':4A,21A 'behindm':12A 'checkpoint':26A,57A 'checkpoint-run':56A 'commit':18A 'commitsbehind':10A 'detail':14A 'emit':67A 'engin':49A 'failing/blocking':65A 'find':60A 'fire':50A 'fix':61A 'fresh':52A 'gate':32A,53A 'green':25A 'green-checkpoint':24A 'h':20A,30A 'har':7A 'killed/wedged':43A 'kind':1A 'main':3A,15A,36A 'main-behind-staging-watchdog':2A 'papercusp':9A 'red':40A 'regardless':37A 'releas':55A 'routin':48A 'run':44A,54A,58A 'slug':8A 'stage':5A,22A 'verdict':41A 'watchdog':6A 'wedg':47A 'whatev':62A"
escalation: "{\"kind\":\"main-behind-staging-watchdog\",\"harness_slug\":\"papercusp\",\"commitsBehind\":70,\"behindMs\":13107802,\"detail\":\"`main` is 70 commits / ~3.6h behind `staging` (no green-checkpoint advance in ~2.2h) — the gate is not advancing main, regardless of why (red verdicts, a killed/wedged run, or a wedged routine engine). Fire a fresh gate run (release:checkpoint-run) and find + fix whatever is actually failing/blocking it.\",\"emitted_at\":1783885869084}"
mtime_ms: 1783885869084
phase: "main-behind-staging-watchdog"
risk_tier: null
supervisor_notes: null
---


