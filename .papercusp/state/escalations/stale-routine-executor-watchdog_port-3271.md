---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-19409061552037718':72A '-3271':8A,14A '035a3c1ff6':44A '1':27A '1786526476050':98A '2':16A '2h':22A 'agehour':15A 'appli':56A 'boot':31A,52A 'checkout':36A 'claimdueroutin':62A 'code':28A,70A,80A 'commit':32A,50A 'current':79A 'dbos':25A,92A 'detail':17A 'e45512e2ee':33A 'ei':71A 'emit':96A 'everi':45A 'executor':5A 'fix':49A 'frozen':69A 'half':55A 'half-appli':54A 'har':9A 'head':39A 'host':75A 'ident':12A 'keep':60A 'kind':1A 'load':29A 'longer':85A 'move':42A 'need':86A 'papercusp':11A,24A,91A 'per':65A 'per-tick':64A 'pick':77A 'port':7A,13A 'process':19A,59A 'race':67A 'restart':73A 'routin':4A,26A,48A,89A,93A 'run':21A,88A 'schedul':47A 'scheduled-routin':46A 'sinc':41A,51A 'slug':10A 'stale':3A 'stale-routine-executor-watchdog':2A 'tick':66A 'tree':38A 'unset':90A 'watchdog':6A 'win':61A"
escalation: "{\"kind\":\"stale-routine-executor-watchdog:port-3271\",\"harness_slug\":\"papercusp\",\"identity\":\"port-3271\",\"ageHours\":2,\"detail\":\"this process has run 2h with PAPERCUSP_DBOS_ROUTINES=1, code loaded at boot commit e45512e2ee, while this checkout's tree HEAD has since moved to 035a3c1ff6 — every scheduled-routine fix committed since boot is HALF-APPLIED while this process keeps winning claimDueRoutine's per-tick race with frozen code (EI-19409061552037718). Restart this host to pick up current code, or, if it no longer needs to run routines, unset PAPERCUSP_DBOS_ROUTINES on it.\",\"emitted_at\":1786526476050}"
mtime_ms: 1786526476050
phase: "stale-routine-executor-watchdog:port-3271"
risk_tier: null
supervisor_notes: null
---


