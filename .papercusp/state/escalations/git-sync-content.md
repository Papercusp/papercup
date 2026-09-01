---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-19932544083689229':43A '/../fleet/capacity-verdict':21A '1':55A,67A '1788239489958':61A 'alon':34A 'auto':75A 'auto-commit':74A 'back':46A 'broken':68A 'clean':80A 'commit':28A,31A,76A 'consecut':51A 'content':5A,52A,82A 'content-fix':81A 'content/deletion':29A 'detail':62A 'detector':15A 'dispatch':84A 'ei':42A 'emit':59A 'error':6A,19A,53A 'exclud':25A,71A 'fals':58A 'file':10A,13A,33A,69A 'fixer':83A 'git':3A,64A 'git-sync':63A 'git-sync-content-error':2A 'guard':30A 'har':7A 'head':41A 'hold':44A 'human':57A 'import':18A,20A,39A,88A 'kind':1A 'leav':36A 'need':56A 'packages/operator-core/lib/agent-tools/fleet/capacity.ts':14A 'packages/operator-core/lib/fleet/capacity-verdict.ts':22A,48A 'papercusp':9A 'quarantin':17A,66A,87A 'quarantined-import':16A,86A 'resolv':50A 'scope':11A 'slug':8A 'stage':78A 'stay':79A 'superproject':12A 'superproject/packages/operator-core/lib/agent-tools/fleet/capacity.ts':85A 'sync':4A,65A 'tick':54A 'unresolv':38A 'would':35A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/agent-tools/fleet/capacity.ts\",\"detector\":\"quarantined-importer\",\"error\":\"imports '../../fleet/capacity-verdict' → 'packages/operator-core/lib/fleet/capacity-verdict.ts', which is EXCLUDED from this commit (content/deletion guard). Committing this file alone would leave an unresolvable import at HEAD (EI-19932544083689229) — holding it back until 'packages/operator-core/lib/fleet/capacity-verdict.ts' is resolved.\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1788239489958,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/agent-tools/fleet/capacity.ts [quarantined-importer].\"}"
mtime_ms: 1788239489958
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


