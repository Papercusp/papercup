---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'-4':85A '1':50A,97A '13180':29A '1789655149924':44A '2881e9':18A,26A '5000':31A 'admiss':15A,59A 'admission-block':14A 'alert':88A 'author':61A 'b5':27A 'b577f82ddeefcdefe68154cf0ddd2ca831':19A 'baselin':37A 'basi':20A 'block':16A,56A 'blockedauthor':22A 'bridg':4A,48A 'c26586dd':25A 'canon':80A 'cap':41A 'caus':92A 'close':64A 'commit':30A 'consum':70A 'contribut':58A 'detail':45A 'diverg':5A,49A 'emit':42A 'error':21A,23A,65A 'fail':63A 'fail-clos':62A 'fals':89A 'forc':76A 'force-push':75A 'github':3A,47A,52A 'github-bridg':46A 'github-bridge-diverg':2A 'github-origin':51A 'har':6A 'head':17A,54A 'hive':79A 'integr':67A 'judg':34A 'kind':1A,13A 'must':68A 'need':9A,86A,90A,94A 'never':74A 'null':93A 'origin':53A,72A 'owner':10A,87A,91A,95A 'papercusp':8A 'push':77A 'rais':39A 'rang':24A 're':36A 're-baselin':35A 'ref':81A 'refus':32A 'revok':60A 'signal':12A 'slug':7A 'sweep':96A 'true':11A 'unchang':83A"
escalation: "{\"kind\":\"github-bridge-divergence\",\"harness_slug\":\"papercusp\",\"needs_owner\":true,\"signals\":[{\"kind\":\"admission-blocked\",\"head\":\"2881e9b577f82ddeefcdefe68154cf0ddd2ca831\",\"basis\":\"error\",\"blockedAuthors\":[],\"errors\":[\"range c26586dd..2881e9b5 has 13180 commits (> 5000) — refusing to judge; re-baseline or raise the cap\"]}],\"emitted_at\":1789655149924,\"detail\":\"github-bridge divergence: 1 github-origin head(s) blocked by contribution admission (revoked author / fail-closed error — the integrator must not consume them). Origin was never force-pushed and hive canonical refs are unchanged (S-4).\",\"needs_owner_alerted\":false,\"needs_owner_cause\":null,\"needs_owner_sweeps\":1}"
mtime_ms: 1789655149924
phase: "github-bridge"
risk_tier: null
supervisor_notes: null
---


