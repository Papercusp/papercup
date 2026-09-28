---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'-09':19A '-28':20A '02.491':23A '1':26A '1790610943148':31A '1h':48A '2026':18A '3070':80A '51':22A 'activ':53A 'advanc':46A 'claim':107A 'code':59A 'commit':55A,72A,85A,122A 'commitstal':9A 'common':87A 'conflict':28A 'dbos':90A 'deploy':64A,69A 'detail':34A 'edit':76A 'emit':29A 'engin':98A 'error':111A 'errorstal':13A 'executor':91A 'fals':12A,14A,16A 'fire':97A 'firestal':11A 'fix':105A 'git':3A,36A,83A,95A,116A 'git-sync':35A,82A,94A,115A 'git-sync-watchdog':2A 'har':6A 'head':43A,73A 'headunchangedhr':25A 'inspect':109A 'kind':1A 'land':58A 'lastfiredat':17A 'laststatus':27A 'lock/restart':102A 'matter':67A 'metadata.last':110A 'papercusp':8A,114A 'persistentreap':15A 'reach':79A 'reap':92A 'rescu':121A 'rescue-commit':120A 'root':88A 'routin':51A,118A 'ship':70A 'silent':38A 'slug':7A 'stall':39A 'strand':32A,60A,75A,127A 'stuck':93A 'sync':4A,37A,84A,96A,117A 't15':21A 'tree':42A,124A 'true':10A,33A 'un':63A 'un-deploy':62A 'uncommit':61A 'urgent':129A 'watchdog':5A,40A 'wedg':99A 'won':103A 'z':24A '—':54A,100A"
escalation: "{\"kind\":\"git-sync-watchdog\",\"harness_slug\":\"papercusp\",\"commitStale\":true,\"fireStale\":false,\"errorStall\":false,\"persistentReap\":false,\"lastFiredAt\":\"2026-09-28T15:51:02.491Z\",\"headUnchangedHrs\":1,\"lastStatus\":\"conflict\",\"emitted_at\":1790610943148,\"stranding\":true,\"detail\":\"git-sync silent stall (watchdog): the tree HEAD has not advanced in ~1h while the routine is active — commits are NOT landing (code strands uncommitted + un-deployable). Why it matters: a deploy ships only COMMITTED HEAD, so stranded edits can't reach :3070 until git-sync commits them. Common root: a DBOS executor reaping stuck git-sync fires (engine wedge — a lock/restart won't fix it). Claim it: inspect metadata.last_error on the papercusp git-sync routine, and rescue-commit the tree if the strand is urgent.\"}"
mtime_ms: 1790610943148
phase: "git-sync-watchdog"
risk_tier: null
supervisor_notes: null
---


