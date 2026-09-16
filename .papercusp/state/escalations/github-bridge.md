---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'-4':83A '1':48A,95A '12902':27A '1789525672410':42A '5000':29A '975a3e8a':25A '975a3e8ae08dfc285df55a204df42beaf690001a':18A 'admiss':15A,57A 'admission-block':14A 'alert':86A 'author':59A 'baselin':35A 'basi':19A 'block':16A,54A 'blockedauthor':21A 'bridg':4A,46A 'c26586dd':24A 'canon':78A 'cap':39A 'caus':90A 'close':62A 'commit':28A 'consum':68A 'contribut':56A 'detail':43A 'diverg':5A,47A 'emit':40A 'error':20A,22A,63A 'fail':61A 'fail-clos':60A 'fals':87A 'forc':74A 'force-push':73A 'github':3A,45A,50A 'github-bridg':44A 'github-bridge-diverg':2A 'github-origin':49A 'har':6A 'head':17A,52A 'hive':77A 'integr':65A 'judg':32A 'kind':1A,13A 'must':66A 'need':9A,84A,88A,92A 'never':72A 'null':91A 'origin':51A,70A 'owner':10A,85A,89A,93A 'papercusp':8A 'push':75A 'rais':37A 'rang':23A 're':34A 're-baselin':33A 'ref':79A 'refus':30A 'revok':58A 'signal':12A 'slug':7A 'sweep':94A 'true':11A 'unchang':81A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":true,\"signals\":[{\"kind\":\"admission-blocked\",\"head\":\"975a3e8ae08dfc285df55a204df42beaf690001a\",\"basis\":\"error\",\"blockedAuthors\":[],\"errors\":[\"range c26586dd..975a3e8a has 12902 commits (> 5000) — refusing to judge; re-baseline or raise the cap\"]}],\"emitted_at\":1789525672410,\"detail\":\"github-bridge divergence: 1 github-origin head(s) blocked by contribution admission (revoked author / fail-closed error — the integrator must not consume them). Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":1}"
mtime_ms: 1789525672410
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


