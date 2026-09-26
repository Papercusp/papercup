---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'/green-checkpoint':55A '15':33A '1790416443740':82A '3':11A '3h':23A,25A 'actual':70A 'agehour':10A 'ago':41A 'assum':76A 'cadenc':35A 'check':48A 'checkout':68A 'compar':64A 'deploy':4A,18A 'deployable-but-not-l':17A 'deployedat':59A 'detail':12A 'disk':74A 'document':32A 'either':42A 'emit':80A 'field':60A 'genuin':46A 'git':71A 'green':13A 'har':7A 'health':56A 'kind':1A 'list':50A 'live':21A 'long':40A 'min':34A 'papercusp':9A 'pin':14A 'pipelin':44A 'real':78A 'releas':3A,29A,53A,67A 'release-deploy-staleness-watchdog':2A 'release-trigg':28A,52A 'routin':31A,49A 'ship':38A 'slug':8A 'stale':5A 'stale/lying':63A 'stall':79A 'state':72A 'threshold':26A 'trigger':30A,54A 'watchdog':6A 'wedg':47A"
escalation: "{\"kind\":\"release-deploy-staleness-watchdog\",\"harness_slug\":\"papercusp\",\"ageHours\":3,\"detail\":\"green pin has been deployable-but-not-live for 3h (>= the 3h threshold) — the release-trigger routine (documented ≤15-min cadence) should have shipped it long ago. Either the pipeline is genuinely wedged (check routines:list for release-trigger/green-checkpoint health) or the deployedAt field itself is stale/lying (compare against the release checkout's actual git state on disk before assuming a real stall).\",\"emitted_at\":1790416443740}"
mtime_ms: 1790416443740
phase: "release-deploy-staleness-watchdog"
risk_tier: null
supervisor_notes: null
---


