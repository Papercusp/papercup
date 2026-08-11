---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-19409061552037718':73A '-3271':8A,14A '1':27A '1786414412714':99A '2':16A '2h':22A '6e34':44A 'a5486d9f6b':33A 'agehour':15A 'appli':57A 'boot':31A,53A 'checkout':36A 'claimdueroutin':63A 'code':28A,71A,81A 'commit':32A,51A 'current':80A 'd3ddfd':45A 'dbos':25A,93A 'detail':17A 'ei':72A 'emit':97A 'everi':46A 'executor':5A 'fix':50A 'frozen':70A 'half':56A 'half-appli':55A 'har':9A 'head':39A 'host':76A 'ident':12A 'keep':61A 'kind':1A 'load':29A 'longer':86A 'move':42A 'need':87A 'papercusp':11A,24A,92A 'per':66A 'per-tick':65A 'pick':78A 'port':7A,13A 'process':19A,60A 'race':68A 'restart':74A 'routin':4A,26A,49A,90A,94A 'run':21A,89A 'schedul':48A 'scheduled-routin':47A 'sinc':41A,52A 'slug':10A 'stale':3A 'stale-routine-executor-watchdog':2A 'tick':67A 'tree':38A 'unset':91A 'watchdog':6A 'win':62A"
escalation: "{\"kind\":\"stale-routine-executor-watchdog:port-3271\",\"harness_slug\":\"papercusp\",\"identity\":\"port-3271\",\"ageHours\":2,\"detail\":\"this process has run 2h with PAPERCUSP_DBOS_ROUTINES=1, code loaded at boot commit a5486d9f6b, while this checkout's tree HEAD has since moved to 6e34d3ddfd — every scheduled-routine fix committed since boot is HALF-APPLIED while this process keeps winning claimDueRoutine's per-tick race with frozen code (EI-19409061552037718). Restart this host to pick up current code, or, if it no longer needs to run routines, unset PAPERCUSP_DBOS_ROUTINES on it.\",\"emitted_at\":1786414412714}"
mtime_ms: 1786414412714
phase: "stale-routine-executor-watchdog:port-3271"
risk_tier: null
supervisor_notes: null
---


