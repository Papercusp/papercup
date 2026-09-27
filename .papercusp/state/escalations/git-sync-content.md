---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'/plan-acceptance-gate':21A '1':58A,70A '1790496909062':64A 'alon':36A 'auto':78A 'auto-commit':77A 'back':49A 'broken':71A 'chang':43A 'clean':83A 'commit':28A,33A,79A 'consecut':54A 'content':5A,55A,85A 'content-fix':84A 'could':37A 'depend':42A 'detail':65A 'detector':15A 'dispatch':87A 'emit':62A 'error':6A,19A,56A 'exclud':25A,74A 'exclus':32A 'fals':61A 'file':10A,13A,35A,72A 'fixer':86A 'git':3A,67A 'git-sync':66A 'git-sync-content-error':2A 'har':7A 'head':39A 'hold':47A 'human':60A 'import':18A,20A,45A,91A 'kind':1A 'leav':38A 'live':30A 'live-lock':29A 'lock':31A 'need':46A,59A 'packages/operator-core/lib/plan-acceptance-gate.test.ts':14A 'packages/operator-core/lib/plan-acceptance-gate.ts':22A,51A 'papercusp':9A 'quarantin':17A,69A,90A 'quarantined-import':16A,89A 'resolv':53A 'scope':11A 'slug':8A 'stage':81A 'stay':82A 'superproject':12A 'superproject/packages/operator-core/lib/plan-acceptance-gate.test.ts':88A 'sync':4A,68A 'tick':57A 'without':40A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/plan-acceptance-gate.test.ts\",\"detector\":\"quarantined-importer\",\"error\":\"imports './plan-acceptance-gate' → 'packages/operator-core/lib/plan-acceptance-gate.ts', which is EXCLUDED from this commit (live-lock exclusion). Committing this file alone could leave HEAD without the dependency changes its import needs — holding it back until 'packages/operator-core/lib/plan-acceptance-gate.ts' is resolved.\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1790496909062,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/plan-acceptance-gate.test.ts [quarantined-importer].\"}"
mtime_ms: 1790496909062
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


