---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-8':35A '0x00':23A '1':24A,30A,81A,93A '172':27A '1786232841713':87A 'almost':60A 'alway':61A 'auto':101A 'auto-commit':100A 'b':69A 'binari':38A 'broken':94A 'byte':18A,22A,76A,114A 'clean':106A 'commit':102A 'compil':49A 'composit':63A 'consecut':77A 'content':5A,78A,108A 'content-fix':107A 'detail':88A 'detector':15A 'dispatch':110A 'emit':85A 'error':6A,19A,79A 'escap':70A 'exclud':97A 'fals':84A 'file':10A,13A,29A,95A 'fixer':109A 'gate':58A 'git':3A,90A 'git-sync':89A 'git-sync-content-error':2A 'grep':41A 'har':7A 'human':83A 'instead':71A 'invis':54A 'key':65A 'kind':1A 'line':26A 'liter':20A 'make':28A,40A 'map':64A 'need':82A 'nul':17A,21A,75A,113A 'nul-byt':16A,112A 'packages/operator-core/lib/pot/cup-spawn-health-watchdog.ts':14A 'papercusp':9A 'quarantin':92A 'raw':74A 'red':59A 'refus':42A 'report':31A 'scope':11A 'search':44A 'share':57A 'slug':8A 'sourc':36A 'stage':104A 'stay':105A 'still':48A 'superproject':12A 'superproject/packages/operator-core/lib/pot/cup-spawn-health-watchdog.ts':111A 'sync':4A,91A 'tick':80A 'tsc/esbuild':47A 'utf':34A 'valid':33A 'write':66A 'x00':68A"
escalation: "{\"kind\":\"git-sync-content-error\",\"harness_slug\":\"papercusp\",\"files\":[{\"scope\":\"superproject\",\"file\":\"packages/operator-core/lib/pot/cup-spawn-health-watchdog.ts\",\"detector\":\"nul-bytes\",\"error\":\"literal NUL byte (0x00) ×1 at line 172 — makes file(1) report this valid UTF-8 source as BINARY and makes grep refuse to search it, while tsc/esbuild still compile it (so it is invisible until the shared gate reds). Almost always a composite map key: write `${a}\\\\x00${b}` (escape) instead of a raw NUL byte.\"}],\"consecutive_content_error_ticks\":1,\"needs_human\":false,\"emitted_at\":1786232841713,\"detail\":\"git-sync quarantined 1 broken file(s) (excluded from the auto-commit so staging stays clean); content-fixer dispatched: superproject/packages/operator-core/lib/pot/cup-spawn-health-watchdog.ts [nul-bytes].\"}"
mtime_ms: 1786232841713
phase: "git-sync-content"
risk_tier: null
supervisor_notes: null
---


