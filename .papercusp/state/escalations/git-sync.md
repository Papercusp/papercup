---
authority: null
body_embedding_mode: "gemma"
body_tsv: "'/target/release/bundle/deb/papercusp':39A '13':16A,61A '1787868018479':49A 'add':24A 'attent':55A 'beyond':42A 'commit':64A 'consecut':13A,62A 'desktop':21A 'detail':50A 'emit':47A 'error':5A,14A,17A 'exclud':34A 'fail':26A,60A 'failur':12A,58A 'fatal':32A 'git':3A,23A,52A 'git-sync':51A 'git-sync-error':2A 'har':6A 'kind':1A 'link':45A 'liter':35A 'messag':22A 'need':54A 'origin':67A 'overs':46A 'papercusp':8A,20A 'papercusp-desktop':19A 'pathspec':33A 'push':11A,57A,59A 'push-failur':10A,56A 'reach':66A 'reason':9A 'scope':18A 'server_0.0.18_amd64.deb':40A 'slug':7A 'src':37A 'src-tauri':36A 'strand':30A 'symbol':44A 'sync':4A,53A 'tauri':38A 'tick':15A,63A 'tree':28A 'uncommit':31A 'would':29A"
escalation: "{\"kind\":\"git-sync-error\",\"harness_slug\":\"papercusp\",\"reasons\":[\"push-failure\"],\"consecutive_error_ticks\":13,\"errors\":[{\"scope\":\"papercusp-desktop\",\"message\":\"git add -A failed — the tree would strand uncommitted: fatal: pathspec ':(exclude,literal)src-tauri/target/release/bundle/deb/Papercusp Server_0.0.18_amd64.deb' is beyond a symbolic link\"}],\"oversized\":[],\"emitted_at\":1787868018479,\"detail\":\"git-sync needs attention: push-failure — push failed 13 consecutive ticks (commits NOT reaching origin)\"}"
mtime_ms: 1787868018479
phase: "git-sync"
risk_tier: null
supervisor_notes: null
---


