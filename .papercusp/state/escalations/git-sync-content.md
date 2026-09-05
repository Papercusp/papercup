---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':72A '1788614461840':78A '2':26A,45A,84A '243':25A,44A 'auto':92A 'auto-commit':91A 'broken':85A 'clean':97A 'commit':93A 'consecut':68A 'consum':55A 'content':5A,69A,99A 'content-fix':98A 'detail':79A 'detector':15A,34A 'dispatch':101A 'emit':76A 'error':6A,19A,22A,38A,41A,70A 'esbuild':17A,20A,104A 'esbuild-transform':16A,103A 'everi':54A 'exclud':88A 'expect':27A,47A 'fail':61A 'fals':75A 'file':10A,13A,32A,49A,67A,86A 'fixer':100A 'found':29A 'git':3A,81A 'git-sync':80A 'git-sync-content-error':2A 'har':7A 'hard':60A 'hard-fail':59A 'human':74A 'kind':1A 'line':24A,43A 'need':73A 'packag':58A 'packages/operator-core/lib/agent-tools/plans/items.ts':14A,33A 'papercusp':9A 'pars':37A,40A,52A,109A 'quarantin':83A 'scope':11A,30A 'slug':8A 'stage':95A 'stay':96A 'superproject':12A,31A 'superproject/packages/operator-core/lib/agent-tools/plans/items.ts':102A,106A 'sync':4A,82A 'tick':71A 'transform':18A,21A,105A 'ts':36A,108A 'ts-pars':35A,107A 'ts1005':46A 'typecheck':63A 'typescript':39A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/agent-tools/plans/items.ts\",\"detector\":\"esbuild-transform\",\"error\":\"esbuild transform error at line 243:2: Expected \\\")\\\" but found \\\";\\\"\"},{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/agent-tools/plans/items.ts\",\"detector\":\"ts-parse\",\"error\":\"TypeScript parse error at line 243:2 (TS1005): ')' expected. — the file does not PARSE, so every consumer of this package hard-fails to typecheck, not just this file\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1788614461840,\"detail\":\"git-sync quarantined 2 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/agent-tools/plans/items.ts [esbuild-transform], superproject/packages/operator-core/lib/agent-tools/plans/items.ts [ts-parse].\"}"
mtime_ms: 1788614461840
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


