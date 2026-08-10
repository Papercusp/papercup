---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':54A,66A '1786399457120':60A '2':26A '793':25A 'auto':74A 'auto-commit':73A 'broken':67A 'clean':79A 'commit':75A 'consecut':50A 'consum':37A 'content':5A,51A,81A 'content-fix':80A 'detail':61A 'detector':15A 'dispatch':83A 'emit':58A 'error':6A,19A,22A,52A 'everi':36A 'exclud':70A 'expect':29A 'express':28A 'fail':43A 'fals':57A 'file':10A,13A,31A,49A,68A 'fixer':82A 'git':3A,63A 'git-sync':62A 'git-sync-content-error':2A 'har':7A 'hard':42A 'hard-fail':41A 'human':56A 'kind':1A 'line':24A 'need':55A 'packag':40A 'packages/operator-core/lib/scheduler/get-next.ts':14A 'papercusp':9A 'pars':18A,21A,34A,87A 'quarantin':65A 'scope':11A 'slug':8A 'stage':77A 'stay':78A 'superproject':12A 'superproject/packages/operator-core/lib/scheduler/get-next.ts':84A 'sync':4A,64A 'tick':53A 'ts':17A,86A 'ts-pars':16A,85A 'ts1109':27A 'typecheck':45A 'typescript':20A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/scheduler/get-next.ts\",\"detector\":\"ts-parse\",\"error\":\"TypeScript parse error at line 793:2 (TS1109): Expression expected. — the file does not PARSE, so every consumer of this package hard-fails to typecheck, not just this file\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1786399457120,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/scheduler/get-next.ts [ts-parse].\"}"
mtime_ms: 1786399457120
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


