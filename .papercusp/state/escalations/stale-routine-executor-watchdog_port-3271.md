---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'-19409061552037718':59A '-3271':8A,14A '1':27A '1786863512664':85A '2':16A '2h':22A '30178a6efe':44A '6fcc2419da':33A 'agehour':15A 'boot':31A,51A 'checkout':36A 'code':28A,67A 'commit':32A,49A 'current':66A 'dbos':25A,79A 'detail':17A 'ei':58A 'emit':83A 'executor':5A 'fix':48A 'har':9A 'head':39A 'host':62A 'ident':12A 'kind':1A 'load':29A,54A 'longer':72A 'move':42A 'need':73A 'papercusp':11A,24A,78A 'pick':64A 'port':7A,13A 'process':19A,57A 'restart':60A 'routin':4A,26A,47A,76A,80A 'run':21A,75A 'schedul':46A 'scheduled-routin':45A 'sinc':41A,50A 'slug':10A 'stale':3A 'stale-routine-executor-watchdog':2A 'tree':38A 'unset':77A 'watchdog':6A"
escalation: "{\"kind\":\"stale-routine-executor-watchdog:port-3271\",\"harness_slug\":\"papercusp\",\"identity\":\"port-3271\",\"ageHours\":2,\"detail\":\"this process has run 2h with PAPERCUSP_DBOS_ROUTINES=1, code loaded at boot commit 6fcc2419da, while this checkout's tree HEAD has since moved to 30178a6efe — scheduled-routine fixes committed since boot are not loaded by this process (EI-19409061552037718). Restart this host to pick up current code, or, if it no longer needs to run routines, unset PAPERCUSP_DBOS_ROUTINES on it.\",\"emitted_at\":1786863512664}"
mtime_ms: 1786863512664
phase: "stale-routine-executor-watchdog:port-3271"
risk_tier: null
supervisor_notes: null
---


