---
authority: null
body_embedding_mode: null
body_embedding_profile: null
body_tsv: "'-4':107A '/papercusp/papercup':21A,34A '1':119A '1790614295425':45A '7e23':29A 'alert':110A 'auth':64A 'blob':27A 'branch':22A,60A 'bridg':4A,15A,49A,69A 'bridge-remote-unreach':14A 'canon':102A 'caus':114A 'contact':57A 'could':54A 'credenti':87A 'detail':46A 'diverg':5A,50A 'ed16b2743691fc685d652a9513ff61251db6':30A 'egress':75A 'emit':43A 'error':24A 'fals':42A,111A 'fatal':25A 'fix':80A 'forc':98A 'force-push':97A 'found':63A 'frozen':79A 'git':89A 'github':3A,48A,52A 'github-bridg':47A 'github-bridge-diverg':2A 'github.com':20A,33A 'github.com/papercusp/papercup':19A,32A 'har':6A 'hive':101A 'inert':71A 'ingress':73A 'kind':1A,13A 'main':23A 'miss':26A 'necessari':39A 'need':9A,91A,108A,112A,116A 'nerror':31A 'network':66A 'never':96A 'noth':72A,74A 'null':115A 'object':28A,40A 'origin':77A,94A 'owner':10A,109A,113A,117A 'papercusp':8A 'push':99A 'ref':103A 'refus':65A 'remot':16A,53A,82A 'remoteurl':18A 'repo':61A 'send':37A 'signal':12A 'slug':7A 'sweep':118A 'transient':41A 'transport':90A 'true':11A 'unchang':105A 'unreach':17A 'url':83A 'wire':85A '—':67A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":true,\"signals\":[{\"kind\":\"bridge-remote-unreachable\",\"remoteUrl\":\"https://github.com/Papercusp/papercup\",\"branches\":[\"main\"],\"errors\":[\"fatal: missing blob object '7e23ed16b2743691fc685d652a9513ff61251db6'\\nerror: https://github.com/Papercusp/papercup did not send all necessary objects\"],\"transient\":false}],\"emitted_at\":1790614295425,\"detail\":\"github-bridge divergence: the GitHub remote could not be contacted for ANY branch (repo not found / auth refused / network) — the bridge is INERT: nothing ingresses, nothing egresses, and origin is frozen. Fix the remote URL or wire the credential the git transport needs for it. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":1}"
mtime_ms: 1790614295425
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


