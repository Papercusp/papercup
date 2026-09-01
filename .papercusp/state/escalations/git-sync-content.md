---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1':48A '1248':26A '14':35A,57A '1788257021022':41A '220898':25A 'apps/operator/dist-sidecar/embed-sidecar.mjs':14A 'auto':82A 'auto-commit':81A 'check':55A 'clean':87A 'commit':83A 'consecut':31A 'content':5A,32A,46A,54A,61A 'content-fix':60A 'could':63A 'detail':42A 'detector':15A 'emit':39A 'error':6A,19A,22A,33A 'esbuild':17A,20A,73A 'esbuild-transform':16A,72A 'everi':80A 'exclud':78A 'expect':27A 'fact':30A 'fail':52A 'file':10A,13A,49A 'fix':70A 'fixer':62A 'found':29A 'git':3A,44A 'git-sync':43A 'git-sync-content-error':2A 'guard':47A 'har':7A 'human':37A,68A 'kind':1A 'line':24A 'must':69A 'need':36A 'papercusp':9A 'quarantin':77A 'repair':65A 'scope':11A 'slug':8A 'stage':85A 'stay':86A 'still':51A 'superproject':12A 'superproject/apps/operator/dist-sidecar/embed-sidecar.mjs':71A 'sync':4A,45A 'tick':34A,58A 'transform':18A,21A,74A 'true':38A 'wait':90A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"apps/operator/dist-sidecar/embed-sidecar.mjs\",\"detector\":\"esbuild-transform\",\"error\":\"esbuild transform error at line 220898:1248: Expected \\\";\\\" but found \\\"facts\\\"\"}],\"consecutive_content_error_ticks\":14,\"needs_human\":true,\"emitted_at\":1788257021022,\"detail\":\"git-sync content guard: 1 file(s) STILL failing their content check after 14 ticks — the content-fixer could not repair them; a human must fix: superproject/apps/operator/dist-sidecar/embed-sidecar.mjs [esbuild-transform]. (They are quarantined — excluded from every auto-commit — so staging stays clean while they wait.)\"}"
mtime_ms: 1788257021022
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


