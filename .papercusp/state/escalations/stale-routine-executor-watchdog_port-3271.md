---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-19409061552037718':60A '-3271':8A,14A '0e588':33A '1':27A '1786656811094':86A '2':16A '2h':22A '9c07dd7e04':45A 'acf03':34A 'agehour':15A 'boot':31A,52A 'checkout':37A 'code':28A,68A 'commit':32A,50A 'current':67A 'dbos':25A,80A 'detail':17A 'ei':59A 'emit':84A 'executor':5A 'fix':49A 'har':9A 'head':40A 'host':63A 'ident':12A 'kind':1A 'load':29A,55A 'longer':73A 'move':43A 'need':74A 'papercusp':11A,24A,79A 'pick':65A 'port':7A,13A 'process':19A,58A 'restart':61A 'routin':4A,26A,48A,77A,81A 'run':21A,76A 'schedul':47A 'scheduled-routin':46A 'sinc':42A,51A 'slug':10A 'stale':3A 'stale-routine-executor-watchdog':2A 'tree':39A 'unset':78A 'watchdog':6A"
escalation: "{\"kind\":\"stale-routine-executor-watchdog:port-3271\",\"harness_slug\":\"papercusp\",\"identity\":\"port-3271\",\"ageHours\":2,\"detail\":\"this process has run 2h with PAPERCUSP_DBOS_ROUTINES=1, code loaded at boot commit 0e588acf03, while this checkout's tree HEAD has since moved to 9c07dd7e04 — scheduled-routine fixes committed since boot are not loaded by this process (EI-19409061552037718). Restart this host to pick up current code, or, if it no longer needs to run routines, unset PAPERCUSP_DBOS_ROUTINES on it.\",\"emitted_at\":1786656811094}"
mtime_ms: 1786656811094
phase: "stale-routine-executor-watchdog:port-3271"
risk_tier: null
supervisor_notes: null
---


