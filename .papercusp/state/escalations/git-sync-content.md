---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'-19932544083689229':45A '/../plan-efficiency':21A '1':69A '1790168916769':63A '2':57A 'alon':36A 'auto':77A 'auto-commit':76A 'back':48A 'broken':70A 'clean':82A 'commit':28A,33A,78A 'consecut':53A 'content':5A,54A,84A 'content-fix':83A 'detail':64A 'detector':15A 'dispatch':86A 'ei':44A 'emit':61A 'error':6A,19A,55A 'exclud':25A,73A 'exclus':32A 'fals':60A 'file':10A,13A,35A,71A 'fixer':85A 'git':3A,66A 'git-sync':65A 'git-sync-content-error':2A 'har':7A 'head':43A 'hold':46A 'human':59A 'import':18A,20A,41A,90A 'kind':1A 'leav':38A 'live':30A 'live-lock':29A 'lock':31A 'need':58A 'packages/operator-core/lib/agent-tools/plans/get.ts':14A 'packages/operator-core/lib/plan-efficiency.ts':22A,50A 'papercusp':9A 'quarantin':17A,68A,89A 'quarantined-import':16A,88A 'resolv':52A 'scope':11A 'slug':8A 'stage':80A 'stay':81A 'superproject':12A 'superproject/packages/operator-core/lib/agent-tools/plans/get.ts':87A 'sync':4A,67A 'tick':56A 'unresolv':40A 'would':37A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/agent-tools/plans/get.ts\",\"detector\":\"quarantined-importer\",\"error\":\"imports '../../plan-efficiency' → 'packages/operator-core/lib/plan-efficiency.ts', which is EXCLUDED from this commit (live-lock exclusion). Committing this file alone would leave an unresolvable import at HEAD (EI-19932544083689229) — holding it back until 'packages/operator-core/lib/plan-efficiency.ts' is resolved.\"}],\"consecutive_content_error_ticks\":2,\"needs_human\":false,\"emitted_at\":1790168916769,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/agent-tools/plans/get.ts [quarantined-importer].\"}"
mtime_ms: 1790168916769
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


