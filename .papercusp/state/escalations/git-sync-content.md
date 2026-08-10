---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-8':36A '0x00':23A '1':31A,82A,94A '1786390089830':88A '2':24A '6465':27A '6467':28A 'almost':61A 'alway':62A 'apps/operator/lib/release/green-checkpoint.ts':14A 'auto':102A 'auto-commit':101A 'b':70A 'binari':39A 'broken':95A 'byte':18A,22A,77A,115A 'clean':107A 'commit':103A 'compil':50A 'composit':64A 'consecut':78A 'content':5A,79A,109A 'content-fix':108A 'detail':89A 'detector':15A 'dispatch':111A 'emit':86A 'error':6A,19A,80A 'escap':71A 'exclud':98A 'fals':85A 'file':10A,13A,30A,96A 'fixer':110A 'gate':59A 'git':3A,91A 'git-sync':90A 'git-sync-content-error':2A 'grep':42A 'har':7A 'human':84A 'instead':72A 'invis':55A 'key':66A 'kind':1A 'line':26A 'liter':20A 'make':29A,41A 'map':65A 'need':83A 'nul':17A,21A,76A,114A 'nul-byt':16A,113A 'papercusp':9A 'quarantin':93A 'raw':75A 'red':60A 'refus':43A 'report':32A 'scope':11A 'search':45A 'share':58A 'slug':8A 'sourc':37A 'stage':105A 'stay':106A 'still':49A 'superproject':12A 'superproject/apps/operator/lib/release/green-checkpoint.ts':112A 'sync':4A,92A 'tick':81A 'tsc/esbuild':48A 'utf':35A 'valid':34A 'write':67A 'x00':69A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"apps/operator/lib/release/green-checkpoint.ts\",\"detector\":\"nul-bytes\",\"error\":\"literal NUL byte (0x00) ×2 at lines 6465, 6467 — makes file(1) report this valid UTF-8 source as BINARY and makes grep refuse to search it, while tsc/esbuild still compile it (so it is invisible until the shared gate reds). Almost always a composite map key: write `${a}\\\\x00${b}` (escape) instead of a raw NUL byte.\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1786390089830,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/apps/operator/lib/release/green-checkpoint.ts [nul-bytes].\"}"
mtime_ms: 1786390089830
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


