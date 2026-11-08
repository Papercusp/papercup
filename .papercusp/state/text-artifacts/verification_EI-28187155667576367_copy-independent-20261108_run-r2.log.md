---
rel_path: "verification/EI-28187155667576367/copy-independent-20261108/run-r2.log"
updated_at: 1794110704611
_body: "content"
---


 RUN  v4.1.8 /tmp/latency-copy-test-20261108-r1/packages/operator-core

 ✓ lib/sidecar-pinned-deps.test.ts (87 tests) 57034ms
   ✓ runs maintained verifier source producer regressions  3115ms
     ✓ isolates fixture snapshots from the host-wide copy lock  995ms
     ✓ copies an omitted desktop install under its own reader with independent bytes and its CLI shim  1978ms
       ✓ EXCLUDES nested trees under a node_modules — they are reached through the parent  418ms
       ✓ excludes exact npm-retired executable shims from a hardlink snapshot without changing the donor  1110ms
       ✓ excludes exact npm-retired executable shims from a copy snapshot without changing the donor  1651ms
       ✓ requires workspace link targets in the declared source population  435ms
       ✓ preserves workspace executable closure in a complete hardlink verifier and a nested snapshot  1572ms
       ✓ preserves workspace executable closure in a complete copy verifier and a nested snapshot  1765ms
       ✓ refuses an incomplete copied workspace closure instead of stamping donor validity  1524ms
       ✓ refuses workspace output when the frozen manifest differs from its donor  700ms
       ✓ preserves hardlink identity when the donor is given as a relative path  619ms
       ✓ refuses an actual hardlink failure before copying even when device numbers agree  572ms
       ✓ removes disposable caches from a retained completed copy  1421ms
       ✓ removes disposable caches from a retained staging copy  1442ms
       ✓ excludes mutable tool caches from hardlink snapshots  505ms
       ✓ excludes mutable tool caches from copy snapshots  722ms
       ✓ excludes absolute cache entry symlinks from hardlink snapshots  768ms
       ✓ excludes absolute cache entry symlinks from copy snapshots  669ms
       ✓ excludes Bun cache index links from hardlink snapshots without changing installed packages  1361ms
       ✓ excludes Bun cache index links from copy snapshots without changing installed packages  840ms
       ✓ keeps Bun cache churn outside dependency generation identity (portable=1)  336ms
       ✓ does not validate disposable cache links as package dependencies  625ms
       ✓ reports completed small trees for hardlink publication and verified reuse  660ms
       ✓ reports completed small trees for copy publication and verified reuse  1583ms
       ✓ preserves the failed copy diagnostic and refuses both fresh and stale success receipts  598ms
       ✓ survives an npm-style REPLACE of a donor package (the r14 killer)  583ms
       ✓ survives the donor DELETING a package outright  471ms
       ✓ is a HARDLINK farm, not a copy — the whole cost argument rests on this  517ms
       ✓ preserves relative symlink TEXT, so workspace packages resolve at the MOUNTPOINT  592ms
       ✓ copy mode survives in-place writes on both sides with independent inodes  703ms
       ✓ refuses an unaffordable independent copy before touching retained progress, then releases its lease  1786ms
       ✓ independent snapshots honor the shared physical-copy lease  995ms
       ✓ refuses unmeasured destination capacity while preserving forensic staging  567ms
       ✓ retains an interrupted copy, invalidates the old stamp and reuses verified completed files  2914ms
       ✓ checksum-verifies legacy partials despite equal size/mtime and removes stale paths and links  664ms
       ✓ breaks retained donor hardlinks and donor aliases into independently writable files  718ms
       ✓ copies internal donor aliases through strict independence validation and reuses the completed copy  1880ms
       ✓ refuses ambiguous or symlinked staging without deleting retained progress or stamping success  905ms
       ✓ mirrors the donor layout rather than flattening it, so a lowerdir is prefix-checkable  579ms
       ✓ stamps the snapshot with its donor, tree count and time  439ms
       ✓ keeps snapshot metadata clean without hiding untracked source from the real provenance producer  777ms
       ✓ queues for physical copy capacity before entering the donor install reader  1052ms
       ✓ drops the reader and bounds retries when a copy wins the admission race  2777ms
       ✓ PASSES a tree that owns its dependencies (satisfiable by construction)  349ms
       ✓ PASSES a tree with no dependencies at all  398ms
       ✓ REFUSES writable dependency files hard-linked to a donor inside the pinned tree  400ms
       ✓ REFUSES writable hardlinks through a confined declared snapshot root  998ms
       ✓ REFUSES an overlay whose lower layer is a foreign tree — the r14 shape  605ms
       ✓ ACCEPTS an overlay whose lower layer is the DECLARED snapshot root  335ms
       ✓ checks EVERY lowerdir in a stacked overlay, not just the first  315ms
       ✓ REFUSES a bind mount from a foreign tree, caught by the same pass  301ms
       ✓ IGNORES mounts outside the tree and mounts that are not dependency trees  312ms
       ✓ REFUSES a node_modules that is a SYMLINK out of the tree  419ms
       ✓ ACCEPTS a symlink into the declared snapshot root  632ms
       ✓ says what to do about it — a refusal with no repair gets bypassed, not obeyed  463ms
       ✓ reports the mount axis as skipped rather than silently passing it  622ms

 Test Files  1 passed (1)
      Tests  87 passed (87)
   Start at  23:02:23
   Duration  61.12s (transform 337ms, setup 468ms, import 68ms, tests 57.03s, environment 0ms)

JSON report written to /tmp/latency-copy-test-20261108-r1/result-r2.json

