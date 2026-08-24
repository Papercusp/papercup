---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':25A,65A '1787567672988':59A '2':53A '7':26A 'auto':73A 'auto-commit':72A 'broken':66A 'clean':78A 'commit':74A 'consecut':49A 'consum':36A 'content':5A,50A,80A 'content-fix':79A 'detail':60A 'detector':15A 'dispatch':82A 'emit':57A 'error':6A,19A,22A,51A 'everi':35A 'exclud':69A 'expect':28A 'fail':42A 'fals':56A 'file':10A,13A,30A,48A,67A 'fixer':81A 'git':3A,62A 'git-sync':61A 'git-sync-content-error':2A 'har':7A 'hard':41A 'hard-fail':40A 'human':55A 'kind':1A 'line':24A 'need':54A 'packag':39A 'packages/operator-core/lib/turn-end-tracking.ts':14A 'papercusp':9A 'pars':18A,21A,33A,86A 'quarantin':64A 'scope':11A 'slug':8A 'stage':76A 'stay':77A 'superproject':12A 'superproject/packages/operator-core/lib/turn-end-tracking.ts':83A 'sync':4A,63A 'tick':52A 'ts':17A,85A 'ts-pars':16A,84A 'ts1005':27A 'typecheck':44A 'typescript':20A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/turn-end-tracking.ts\",\"detector\":\"ts-parse\",\"error\":\"TypeScript parse error at line 1:7 (TS1005): ';' expected. — the file does not PARSE, so every consumer of this package hard-fails to typecheck, not just this file\"}],\"consecutive_content_error_ticks\":2,\"needs_human\":false,\"emitted_at\":1787567672988,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/turn-end-tracking.ts [ts-parse].\"}"
mtime_ms: 1787567672988
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


