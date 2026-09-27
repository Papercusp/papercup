---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'-4':85A '0':97A '1790484482223':45A '4096mb':32A '5096mb':30A 'across':70A 'action':65A 'alert':88A 'bridg':4A,15A,49A 'bridge-egress-unreach':14A 'canon':80A 'caus':92A 'could':55A 'detail':46A 'diverg':5A,50A 'egress':16A,52A 'emit':43A 'error':18A 'fals':11A,89A 'forc':76A 'force-push':75A 'git':23A,26A,53A 'github':3A,48A 'github-bridg':47A 'github-bridge-diverg':2A 'har':6A 'hive':79A 'kind':1A,13A 'like':61A 'limit':31A 'local':25A 'need':9A,66A,86A,90A,94A 'never':74A 'null':93A 'origin':72A 'owner':10A,64A,87A,91A,95A 'papercusp':8A 'parent':39A 'persist':69A 'pot':22A 'pot-git':21A 'push':19A,77A 'ref':81A 'refs/heads/staging':20A 'refus':24A 'requir':36A 'rss':29A 'sidecar':34A 'signal':12A 'size':40A 'slug':7A 'spawn':27A,58A 'spawner':33A 'sweep':96A 'tick':60A,71A 'transient':41A,62A 'transport':54A 'true':42A 'unchang':83A 'unless':67A 'unreach':17A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":false,\"signals\":[{\"kind\":\"bridge-egress-unreachable\",\"errors\":[\"push refs/heads/staging: pot-git: refusing local git spawn at RSS 5096MB (limit 4096MB); spawner sidecar is required at this parent size\"],\"transient\":true}],\"emitted_at\":1790484482223,\"detail\":\"github-bridge divergence: the egress git transport could not be SPAWNED this tick — likely transient; no owner action needed unless it persists across ticks. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":0}"
mtime_ms: 1790484482223
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


