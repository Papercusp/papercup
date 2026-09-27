---
authority: null
body_embedding_mode: null
body_embedding_profile: null
body_tsv: "'-4':105A '/papercusp/papercup':21A '/users/aviweiss/.papercusp/pot-git/papercusp/gh-1223568103.git/objects':32A '0':117A '1790550687730':44A '3775422464':33A '3861275443.2000003':38A 'across':90A 'action':85A 'alert':108A 'avail':35A 'branch':22A,60A 'bridg':4A,15A,48A 'bridge-remote-unreach':14A 'byte':34A,39A 'canon':100A 'caus':112A 'could':53A 'credenti':78A 'critic':36A 'detail':45A 'disk':29A 'diverg':5A,49A 'e.g':63A 'emit':42A 'env/path':71A 'error':24A 'even':55A 'fals':11A,109A 'fetch':26A 'forc':96A 'force-push':95A 'git':25A,51A 'github':3A,47A 'github-bridg':46A 'github-bridge-diverg':2A 'github.com':20A 'github.com/papercusp/papercup':19A 'har':6A 'headroom':30A 'hiccup':72A 'hive':99A 'kind':1A,13A 'like':81A 'main':23A 'need':9A,86A,106A,110A,114A 'never':94A 'null':113A 'origin':92A 'owner':10A,84A,107A,111A,115A 'papercusp':8A 'persist':89A 'problem':79A 'process':67A 'push':97A 'ref':101A 'remot':16A,75A 'remoteurl':18A 'reserv':37A 'restart':68A 'right':64A 'signal':12A 'slug':7A 'spawn':57A 'stop':27A 'sweep':116A 'tick':62A,91A 'transient':40A,82A 'transport':52A 'true':41A 'unchang':103A 'unless':87A 'unreach':17A 'url':76A '—':69A,80A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":false,\"signals\":[{\"kind\":\"bridge-remote-unreachable\",\"remoteUrl\":\"https://github.com/Papercusp/papercup\",\"branches\":[\"main\"],\"errors\":[\"git fetch stopped for disk headroom at /Users/aviweiss/.papercusp/pot-git/papercusp/gh-1223568103.git/objects: 3775422464 bytes available; critical reserve 3861275443.2000003 bytes\"],\"transient\":true}],\"emitted_at\":1790550687730,\"detail\":\"github-bridge divergence: the git transport could not even be SPAWNED for ANY branch this tick (e.g. right after a process restart — an env/PATH hiccup, not a remote URL or credential problem) — likely transient; no owner action needed unless it persists across ticks. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":0}"
mtime_ms: 1790550687730
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


