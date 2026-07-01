---
authority: null
body_embedding: null
body_tsv: "'-01':18A '-07':17A '/engine':98A '0':24A '04.208':21A '1782879707595':29A '18':20A '2026':16A 'auto':63A 'auto-commit':62A 'bg':96A 'bg-host':95A 'cancel':53A 'cannot':76A 'check':108A 'checkout':67A 'commit':64A,82A,116A 'commitstal':9A 'common':84A 'dbos':44A,48A,87A 'deploy':77A,79A 'detail':30A 'edit':72A 'emit':27A 'error':110A 'errorstal':13A 'executor':51A,88A 'fals':10A,12A 'fault':43A 'fire':56A,94A 'firestal':11A 'first':106A 'fix':104A 'git':3A,32A,38A,92A 'git-sync':31A,37A,91A 'git-sync-watchdog':2A 'har':6A 'head':83A 'headunchangedhr':23A 'host':97A 'kind':1A 'land':70A 'lastfiredat':15A 'laststatus':25A 'lock/restart':101A 'metadata.last':109A 'move':107A 'oper':49A 'output':50A 'papercusp':8A 'produc':46A 'reap':89A 'reaper':52A 'record':41A 'requeu':58A 'rescu':115A 'rescue-commit':114A 'root':85A 'routin':60A,113A 'routinefir':45A 'ship':80A 'silent':34A 'slug':7A 'stall':35A 'strand':73A,118A 'stuck':55A,90A 'sync':4A,26A,33A,39A,93A 't04':19A 'tree':119A 'true':14A 'uncommit':74A 'urgent':121A 'watchdog':5A,36A 'wedg':99A 'won':102A 'z':22A"
escalation: "{\"kind\":\"git-sync-watchdog\",\"harness_slug\":\"papercusp\",\"commitStale\":false,\"fireStale\":false,\"errorStall\":true,\"lastFiredAt\":\"2026-07-01T04:18:04.208Z\",\"headUnchangedHrs\":0,\"lastStatus\":\"synced\",\"emitted_at\":1782879707595,\"detail\":\"git-sync silent stall (watchdog): git-sync is recording a FAULT: \\\"DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine\\\". The auto-commit of this checkout is not landing, so edits strand uncommitted and CANNOT deploy (a deploy ships only committed HEAD). Common root: a DBOS executor reaping stuck git-sync fires (bg-host/engine wedge — a lock/restart won't fix it). First moves: check metadata.last_error on the routine; rescue-commit the stranded tree if urgent.\"}"
mtime_ms: 1782879707595
phase: "git-sync-watchdog"
risk_tier: null
supervisor_notes: null
---


