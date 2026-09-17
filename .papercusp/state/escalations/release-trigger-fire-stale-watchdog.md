---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'15min':39A '1789630900833':88A '219':12A,26A '31m':24A 'activ':18A,59A 'appear':44A 'cadenc':37A 'check':63A 'commit':28A 'confirm':78A 'deploy':31A,75A 'deployedbehindgreenpin':11A 'detail':13A 'differ':53A 'document':36A 'drive':49A 'emit':86A 'engin':43A 'expedit':80A 'failur':54A 'fire':5A,22A 'green':27A 'har':8A 'health':73A 'inventori':65A 'kind':1A 'list':67A 'live':34A 'op':76A 'papercusp':10A 'paus':57A 'releas':3A,15A,70A,74A 'release-trigg':14A,69A 'release-trigger-fire-stale-watchdog':2A 'routin':51A,58A,66A 'schedul':64A 'scheduler/tick':42A 'silent':47A 'slug':9A 'stale':6A 'still':61A 'stop':48A 'tick':84A 'trigger':4A,16A,71A,77A 'true':62A,79A 'watchdog':7A"
escalation: "{\"kind\":\"release-trigger-fire-stale-watchdog\",\"harness_slug\":\"papercusp\",\"deployedBehindGreenPin\":219,\"detail\":\"release-trigger is ACTIVE but has not FIRED in ~31m while 219 green commit(s) are deployable but not live — the documented cadence is <=15min, so the scheduler/tick engine appears to have silently stopped driving this routine (a DIFFERENT failure than a PAUSED routine — active is still true). Check schedule:inventory / routines:list for release-trigger's health; release:deploy { op:'trigger', confirm:true } expedites once it's ticking again.\",\"emitted_at\":1789630900833}"
mtime_ms: 1789630900833
phase: "release-trigger-fire-stale-watchdog"
risk_tier: null
supervisor_notes: null
---


