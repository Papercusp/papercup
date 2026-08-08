---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':55A,67A '11':26A '1786230382440':61A '308':25A 'argument':28A 'auto':75A 'auto-commit':74A 'broken':68A 'clean':80A 'commit':76A 'consecut':51A 'consum':38A 'content':5A,52A,82A 'content-fix':81A 'detail':62A 'detector':15A 'dispatch':84A 'emit':59A 'error':6A,19A,22A,53A 'everi':37A 'exclud':71A 'expect':30A 'express':29A 'fail':44A 'fals':58A 'file':10A,13A,32A,50A,69A 'fixer':83A 'git':3A,64A 'git-sync':63A 'git-sync-content-error':2A 'har':7A 'hard':43A 'hard-fail':42A 'human':57A 'kind':1A 'line':24A 'need':56A 'packag':41A 'packages/operator-core/lib/result-door.ts':14A 'papercusp':9A 'pars':18A,21A,35A,88A 'quarantin':66A 'scope':11A 'slug':8A 'stage':78A 'stay':79A 'superproject':12A 'superproject/packages/operator-core/lib/result-door.ts':85A 'sync':4A,65A 'tick':54A 'ts':17A,87A 'ts-pars':16A,86A 'ts1135':27A 'typecheck':46A 'typescript':20A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/result-door.ts\",\"detector\":\"ts-parse\",\"error\":\"TypeScript parse error at line 308:11 (TS1135): Argument expression expected. — the file does not PARSE, so every consumer of this package hard-fails to typecheck, not just this file\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1786230382440,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/result-door.ts [ts-parse].\"}"
mtime_ms: 1786230382440
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


