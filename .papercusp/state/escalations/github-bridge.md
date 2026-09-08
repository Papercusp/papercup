---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-4':104A '/papercusp/papercup.git':21A,32A '1':116A '1788859232450':43A 'alert':107A 'auth':62A 'bad':26A 'branch':22A,58A 'bridg':4A,15A,47A,66A 'bridge-remote-unreach':14A 'canon':99A 'caus':111A 'contact':55A 'could':52A 'credenti':84A 'detail':44A 'diverg':5A,48A 'egress':72A 'emit':41A 'error':24A 'fals':40A,108A 'fatal':25A 'fix':77A 'forc':95A 'force-push':94A 'found':61A 'frozen':76A 'git':86A 'github':3A,46A,50A 'github-bridg':45A 'github-bridge-diverg':2A 'github.com':20A,31A 'github.com/papercusp/papercup.git':19A,30A 'har':6A 'hive':98A 'inert':68A 'ingress':70A 'kind':1A,13A 'main':23A 'necessari':37A 'need':9A,88A,105A,109A,113A 'nerror':29A 'network':64A 'never':93A 'noth':69A,71A 'null':112A 'object':27A,38A 'origin':74A,91A 'owner':10A,106A,110A,114A 'papercusp':8A 'push':96A 'ref':100A 'refs/namespaces/5cf02cbeca35a8429b4b38ac35b8d22d8cdfcf8d8ec68e0747089b0a43cb4082/refs/rad/sigrefs':28A 'refus':63A 'remot':16A,51A,79A 'remoteurl':18A 'repo':59A 'send':35A 'signal':12A 'slug':7A 'sweep':115A 'transient':39A 'transport':87A 'true':11A 'unchang':102A 'unreach':17A 'url':80A 'wire':82A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":true,\"signals\":[{\"kind\":\"bridge-remote-unreachable\",\"remoteUrl\":\"https://github.com/Papercusp/papercup.git\",\"branches\":[\"main\"],\"errors\":[\"fatal: bad object refs/namespaces/5cf02cbeca35a8429b4b38ac35b8d22d8cdfcf8d8ec68e0747089b0a43cb4082/refs/rad/sigrefs\\nerror: https://github.com/Papercusp/papercup.git did not send all necessary objects\"],\"transient\":false}],\"emitted_at\":1788859232450,\"detail\":\"github-bridge divergence: the GitHub remote could not be contacted for ANY branch (repo not found / auth refused / network) — the bridge is INERT: nothing ingresses, nothing egresses, and origin is frozen. Fix the remote URL or wire the credential the git transport needs for it. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":1}"
mtime_ms: 1788859232450
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


