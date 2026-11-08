---
rel_path: "verification/EI-28187155667576367/copy-independent-20261108/original-helper-negative.log"
updated_at: 1794110704611
_body: "content"
---


 RUN  v4.1.8 /tmp/latency-copy-test-20261108-r1/packages/operator-core

 ❯ lib/sidecar-pinned-deps.test.ts (87 tests | 1 failed | 86 skipped) 1585ms
   ↓ runs maintained verifier source producer regressions
     ↓ preserves spawnSync timeout diagnostics
     ↓ isolates fixture snapshots from the host-wide copy lock
     ↓ copies an omitted desktop install under its own reader with independent bytes and its CLI shim
     ↓ refuses a different donor lock before copying or taking an install reader
     ↓ refuses a present desktop tree whose executable CLI is missing
       ↓ finds dependency trees at the depths a workspace install reaches
       ↓ EXCLUDES the generated sidecar output dir — D-187, which cost a release
       ↓ EXCLUDES nested trees under a node_modules — they are reached through the parent
       ↓ EXCLUDES agent scratch under .papercusp — it is not build input
       ↓ a fresh worktree with no dependencies is an ANSWER, not an error
       ↓ WI-41095 shares the full-depth tracked-repository boundary
       ↓ excludes exact npm-retired executable shims from a hardlink snapshot without changing the donor
       ↓ excludes exact npm-retired executable shims from a copy snapshot without changing the donor
       ↓ still rejects broken active executables beside an exact npm-retired shim
       ↓ does not classify a retirement-shaped name with the wrong npm hash as disposable
       ↓ refuses dangling .bin links before allocating a snapshot
       ↓ refuses absolute dependency links before allocation
       ↓ refuses escape dependency links before allocation
       ↓ refuses the donor self-link created by relinking a prepared host output
       ↓ requires workspace link targets in the declared source population
       ↓ rechecks the donor after entering its install mutex
       ↓ preserves workspace executable closure in a complete hardlink verifier and a nested snapshot
       ↓ preserves workspace executable closure in a complete copy verifier and a nested snapshot
       ↓ refuses an incomplete copied workspace closure instead of stamping donor validity
       ↓ refuses workspace output when the frozen manifest differs from its donor
       ↓ preserves hardlink identity when the donor is given as a relative path
       ↓ refuses an actual hardlink failure before copying even when device numbers agree
       ↓ removes disposable caches from a retained completed copy
       ↓ removes disposable caches from a retained staging copy
       ↓ excludes mutable tool caches from hardlink snapshots
       ↓ excludes mutable tool caches from copy snapshots
       ↓ excludes absolute cache entry symlinks from hardlink snapshots
       ↓ excludes absolute cache entry symlinks from copy snapshots
       ↓ excludes Bun cache index links from hardlink snapshots without changing installed packages
       ↓ excludes Bun cache index links from copy snapshots without changing installed packages
       ↓ keeps Bun cache churn outside dependency generation identity (portable=0)
       ↓ keeps Bun cache churn outside dependency generation identity (portable=1)
       ↓ does not validate disposable cache links as package dependencies
       ↓ reports completed small trees for hardlink publication and verified reuse
       ↓ reports completed small trees for copy publication and verified reuse
       ↓ preserves the failed copy diagnostic and refuses both fresh and stale success receipts
       ↓ survives an npm-style REPLACE of a donor package (the r14 killer)
       ↓ survives the donor DELETING a package outright
       ↓ is a HARDLINK farm, not a copy — the whole cost argument rests on this
       ↓ preserves relative symlink TEXT, so workspace packages resolve at the MOUNTPOINT
       ↓ copy mode survives in-place writes on both sides with independent inodes
       ↓ refuses an unaffordable independent copy before touching retained progress, then releases its lease
       ↓ independent snapshots honor the shared physical-copy lease
       ↓ refuses unmeasured destination capacity while preserving forensic staging
       ↓ retains an interrupted copy, invalidates the old stamp and reuses verified completed files
       ↓ checksum-verifies legacy partials despite equal size/mtime and removes stale paths and links
       ↓ breaks retained donor hardlinks and donor aliases into independently writable files
       × copies internal donor aliases through strict independence validation and reuses the completed copy 1578ms
       ↓ refuses ambiguous or symlinked staging without deleting retained progress or stamping success
       ↓ refuses an unknown snapshot mode before producing a dependency stamp
       ↓ mirrors the donor layout rather than flattening it, so a lowerdir is prefix-checkable
       ↓ stamps the snapshot with its donor, tree count and time
       ↓ keeps snapshot metadata clean without hiding untracked source from the real provenance producer
       ↓ REFUSES to snapshot THROUGH a symlinked tree — cp -al would reproduce the link
       ↓ refuses a donor that is not a directory rather than stamping an empty snapshot
       ↓ queues for physical copy capacity before entering the donor install reader
       ↓ rejects an invalid copy admission mode without publishing a snapshot
       ↓ drops the reader and bounds retries when a copy wins the admission race
       ↓ REFUSES when the donor install mutex is unreachable; never snapshots unlocked
       ↓ takes the lock through npm-install-safe --exec-under-lock, not a second implementation
       ↓ does NOT fall back to an unlocked snapshot on any path
       ↓ PASSES a tree that owns its dependencies (satisfiable by construction)
       ↓ PASSES a tree with no dependencies at all
       ↓ REFUSES writable dependency files hard-linked to a donor inside the pinned tree
       ↓ REFUSES writable hardlinks through a confined declared snapshot root
       ↓ REFUSES an overlay whose lower layer is a foreign tree — the r14 shape
       ↓ ACCEPTS an overlay whose lower layer is the DECLARED snapshot root
       ↓ checks EVERY lowerdir in a stacked overlay, not just the first
       ↓ REFUSES a bind mount from a foreign tree, caught by the same pass
       ↓ IGNORES mounts outside the tree and mounts that are not dependency trees
       ↓ REFUSES a node_modules that is a SYMLINK out of the tree
       ↓ ACCEPTS a symlink into the declared snapshot root
       ↓ says what to do about it — a refusal with no repair gets bypassed, not obeyed
       ↓ reports the mount axis as skipped rather than silently passing it
       ↓ sources lib/pinned-deps.sh
       ↓ calls the assertion under vm-release
       ↓ a refusal EXITS, rather than being logged and ignored
       ↓ passes exactly the repo root and the declared snapshot root — never a mountinfo override
       ↓ runs AFTER the source-clean gate — both are entry gates, before any toolchain work
       ↓ does not re-implement the dependency-generation fingerprint
       ↓ builds beside the destination and swaps, never mutating a live lower layer in place

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/sidecar-pinned-deps.test.ts > EI-21832562420831737 — a pinned cut owns its dependencies > papercusp_pinned_deps_snapshot — the floor the overlay stands on > copies internal donor aliases through strict independence validation and reuses the completed copy
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 2

 ❯ lib/sidecar-pinned-deps.test.ts:951:38
    949|       const twin = join(snap, 'node_modules/p/twin.js');
    950|       const inode = statSync(copied).ino;
    951|       expect(statSync(copied).nlink).toBe(1);
       |                                      ^
    952|       expect(statSync(twin).nlink).toBe(1);
    953|       expect(statSync(twin).ino).not.toBe(inode);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 86 skipped (87)
   Start at  23:04:24
   Duration  6.07s (transform 471ms, setup 701ms, import 108ms, tests 1.59s, environment 0ms)

JSON report written to /tmp/latency-copy-test-20261108-r1/original-helper-negative.json

