---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-4':103A '/papercusp/papercup.git':21A '/papercusp/papercup.git/'':':31A '1786249691066':42A 'access':28A 'auth':61A 'branch':22A,57A 'bridg':4A,15A,46A,65A 'bridge-remote-unreach':14A 'canon':98A 'connect':34A 'contact':54A 'could':51A 'credenti':83A 'detail':43A 'diverg':5A,47A 'egress':71A 'emit':40A 'error':24A 'failur':33A 'fals':39A 'fatal':25A 'fix':76A 'forc':94A 'force-push':93A 'found':60A 'frozen':75A 'git':85A 'github':3A,45A,49A 'github-bridg':44A 'github-bridge-diverg':2A 'github.com':20A,30A 'github.com/papercusp/papercup.git':19A 'github.com/papercusp/papercup.git/'':':29A 'har':6A 'hive':97A 'inert':67A 'ingress':69A 'kind':1A,13A 'main':23A 'need':9A,87A 'network':63A 'never':92A 'noth':68A,70A 'origin':73A,90A 'owner':10A 'papercusp':8A 'peer':37A 'push':95A 'recv':32A 'ref':99A 'refus':62A 'remot':16A,50A,78A 'remoteurl':18A 'repo':58A 'reset':35A 'signal':12A 'slug':7A 'transient':38A 'transport':86A 'true':11A 'unabl':26A 'unchang':101A 'unreach':17A 'url':79A 'wire':81A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":true,\"signals\":[{\"kind\":\"bridge-remote-unreachable\",\"remoteUrl\":\"https://github.com/Papercusp/papercup.git\",\"branches\":[\"main\"],\"errors\":[\"fatal: unable to access 'https://github.com/Papercusp/papercup.git/': Recv failure: Connection reset by peer\"],\"transient\":false}],\"emitted_at\":1786249691066,\"detail\":\"github-bridge divergence: the GitHub remote could not be contacted for ANY branch (repo not found / auth refused / network) — the bridge is INERT: nothing ingresses, nothing egresses, and origin is frozen. Fix the remote URL or wire the credential the git transport needs for it. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\"}"
mtime_ms: 1786249691066
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


