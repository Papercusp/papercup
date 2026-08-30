---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':81A '15':26A '1788070221950':87A '2':93A '603':25A,44A '7':45A 'accessor':52A 'auto':101A 'auto-commit':100A 'broken':94A 'clean':106A 'commit':102A 'consecut':77A 'constructor':50A 'consum':64A 'content':5A,78A,108A 'content-fix':107A 'detail':88A 'detector':15A,34A 'dispatch':110A 'emit':85A 'error':6A,19A,22A,38A,41A,79A 'esbuild':17A,20A,113A 'esbuild-transform':16A,112A 'everi':63A 'exclud':97A 'expect':27A,56A 'fail':70A 'fals':84A 'file':10A,13A,32A,58A,76A,95A 'fixer':109A 'found':29A 'git':3A,90A 'git-sync':89A 'git-sync-content-error':2A 'har':7A 'hard':69A 'hard-fail':68A 'human':83A 'kind':1A 'line':24A,43A 'method':51A 'need':82A 'packag':67A 'packages/backup/src/workspace-backup.ts':14A,33A 'papercusp':9A 'pars':37A,40A,61A,118A 'properti':54A 'quarantin':92A 'scope':11A,30A 'slug':8A 'stage':104A 'stay':105A 'superproject':12A,31A 'superproject/packages/backup/src/workspace-backup.ts':111A,115A 'sync':4A,91A 'tick':80A 'token':48A 'transform':18A,21A,114A 'ts':36A,117A 'ts-pars':35A,116A 'ts1068':46A 'typecheck':72A 'typescript':39A 'unexpect':47A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/backup/src/workspace-backup.ts\",\"detector\":\"esbuild-transform\",\"error\":\"esbuild transform error at line 603:15: Expected \\\";\\\" but found \\\"{\\\"\"},{\"scope\":\"superproject\",\"file\":\"packages/backup/src/workspace-backup.ts\",\"detector\":\"ts-parse\",\"error\":\"TypeScript parse error at line 603:7 (TS1068): Unexpected token. A constructor, method, accessor, or property was expected. — the file does not PARSE, so every consumer of this package hard-fails to typecheck, not just this file\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1788070221950,\"detail\":\"git-sync quarantined 2 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/backup/src/workspace-backup.ts [esbuild-transform], superproject/packages/backup/src/workspace-backup.ts [ts-parse].\"}"
mtime_ms: 1788070221950
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


