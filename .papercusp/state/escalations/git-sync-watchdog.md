---
authority: null
body_embedding_mode: "gemma"
body_embedding_profile: null
body_tsv: "'-07':4B '-11':5B '-9410':20B '/hono-host.mjs':38B '/su-caa79b4f/su-ac887684':18B '/wi-3992':21B '0':78B '20':60B '2026':3B '22':61B '34':7B '43.629':8B '45':62B '78d15da0':17B 'activ':58B 'alarm':23B 'bg':33B 'bg-host':32B 'bundl':39B 'bundle-host.sh':55B 'caus':12B,28B 'commit':69B 'consecut':75B 'dist':36B 'dist-host':35B 'edt':63B 'ei':19B 'error':76B 'f675845e':72B 'fals':26B 'fix':13B 'git':47B,67B 'git-sync':46B,66B 'head':71B 'host':34B,37B 'human':1B 'issidecarenabledfromenv':43B 'live':65B 'metadata':74B 'normal':70B 'papercup-bg-host.service':57B 'path':52B 'posit':27B 'rebuilt':53B 'referenceerror':44B 'respons':2B 'restart':56B 'root':11B 'root-caus':10B 'routin':73B 'runtim':42B 'sidecar':50B 'sidecar-spawn':49B 'sinc':59B 'spawn':51B 'stale':31B 'su':16B 'su-78d15da0':15B 'sync':48B,68B 't00':6B 'throw':40B 'tick':77B 'verifi':64B 'via':54B 'watchdog':22B 'z':9B"
escalation: null
mtime_ms: 1789837334066
phase: "git-sync-watchdog"
risk_tier: null
supervisor_notes: "\n## Human response 2026-07-11T00:34:43.629Z\n\nRoot-caused + fixed by su-78d15da0/su-caa79b4f/su-ac887684 (EI-9410/WI-3992): watchdog alarm was a false positive caused by a stale bg-host dist-host/hono-host.mjs bundle throwing a runtime isSidecarEnabledFromEnv ReferenceError on git-sync sidecar-spawn path. Rebuilt via bundle-host.sh + restarted papercup-bg-host.service (active since 20:22:45 EDT). Verified live: git-sync committing normally (HEAD f675845e), routine metadata consecutive_error_ticks:0.\n"
---


