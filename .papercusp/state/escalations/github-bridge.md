---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-4':115A '/papercusp/papercup.git':24A '/papercusp/papercup.git''':54A '14035f62f3e995cbf34e39f778f461d4ce77b49b':28A '1786540301929':59A 'account/credential':93A 'allow':32A 'app':35A 'box':100A 'bridg':4A,15A,63A 'bridge-egress-unreach':14A 'canon':110A 'confirm':88A 'contact':71A 'could':69A 'creat':37A 'destin':95A 'detail':60A 'diverg':5A,64A 'egress':16A,67A,89A 'emit':57A 'error':18A 'exampl':78A 'expect':97A 'fail':46A 'fals':56A 'fix':90A 'forc':106A 'force-push':105A 'frozen':84A 'github':3A,62A,66A 'github-bridg':61A 'github-bridge-diverg':2A 'github.com':23A,53A 'github.com/papercusp/papercup.git':22A 'github.com/papercusp/papercup.git''':52A 'github/workflows/test.yml':41A 'har':6A 'hive':109A 'kind':1A,13A 'last':87A 'n':25A 'need':9A 'nerror':45A 'never':104A 'oauth':34A 'off-box':98A 'origin':82A,102A 'owner':10A 'papercusp':8A 'progress':101A 'publish':73A 'push':19A,48A,81A,107A 'ref':50A,111A 'refs/heads/staging':20A 'refus':30A 'reject':27A,80A 'remot':26A,76A,92A 'scope':44A 'signal':12A 'slug':7A 'stage':29A 'transient':55A 'transport':68A 'true':11A 'unchang':113A 'unreach':17A 'updat':39A 'without':42A 'workflow':40A,43A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":true,\"signals\":[{\"kind\":\"bridge-egress-unreachable\",\"errors\":[\"push refs/heads/staging: To https://github.com/Papercusp/papercup.git\\n ! [remote rejected]       14035f62f3e995cbf34e39f778f461d4ce77b49b -> staging (refusing to allow an OAuth App to create or update workflow `.github/workflows/test.yml` without `workflow` scope)\\nerror: failed to push some refs to 'https://github.com/Papercusp/papercup.git'\"],\"transient\":false}],\"emitted_at\":1786540301929,\"detail\":\"github-bridge divergence: the GitHub egress transport could not contact or publish to the remote (for example, a rejected push) — origin is frozen at the last confirmed egress; fix the remote account/credential or destination before expecting off-box progress. Origin was never force-pushed and hive canonical refs are unchanged (S-4).\"}"
mtime_ms: 1786540301929
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


