---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'1788805532688':98A '3':16A,110A 'attent':104A 'author':31A,56A,83A 'automat':39A,64A,91A 'commit':113A 'consecut':13A,111A 'desktop':71A 'detail':99A 'disabl':42A,67A,94A 'effect':30A,33A,55A,58A,82A,85A 'emit':96A 'error':5A,14A,17A 'exclus':32A,57A,84A 'fail':22A,47A,74A,109A 'failov':40A,65A,92A 'failur':12A,107A 'git':3A,24A,49A,76A,101A 'git-sync':23A,48A,75A,100A 'git-sync-error':2A 'har':6A 'hive':29A,37A,54A,62A,81A,89A 'hive-effect-author':28A,53A,80A 'key':38A,63A,90A 'kind':1A 'libs/generic/tooldef':19A 'libs/papercusp':44A 'messag':20A,45A,72A 'need':103A 'origin':116A 'overs':95A 'own':36A,61A,88A 'papercusp':8A,70A 'papercusp-desktop':69A 'public':26A,51A,78A 'push':11A,21A,46A,73A,106A,108A 'push-failur':10A,105A 'reach':115A 'reason':9A 'refus':27A,52A,79A 'requir':34A,59A,86A 'scope':18A,43A,68A 'slug':7A 'sync':4A,25A,50A,77A,102A 'tick':15A,112A"
escalation: "{\"kind\":\"git-sync-error\",\"harness_slug\":\"papercusp\",\"reasons\":[\"push-failure\"],\"consecutive_error_ticks\":3,\"errors\":[{\"scope\":\"libs/generic/tooldef\",\"message\":\"push failed: git-sync publication refused: hive-effect-authority: exclusive effect requires the owning hive key; automatic failover is disabled\"},{\"scope\":\"libs/papercusp\",\"message\":\"push failed: git-sync publication refused: hive-effect-authority: exclusive effect requires the owning hive key; automatic failover is disabled\"},{\"scope\":\"papercusp-desktop\",\"message\":\"push failed: git-sync publication refused: hive-effect-authority: exclusive effect requires the owning hive key; automatic failover is disabled\"}],\"oversized\":[],\"emitted_at\":1788805532688,\"detail\":\"git-sync needs attention: push-failure — push failed 3 consecutive ticks (commits NOT reaching origin)\"}"
mtime_ms: 1788805532688
phase: "git-sync"
risk_tier: null
supervisor_notes: null
---


