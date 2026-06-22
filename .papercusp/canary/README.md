# .papercusp/canary/ — hive loop-proof canaries

Isolated, self-contained heartbeat files seeded by **WI-322** (plan
`hive-coordination-test-loop-2026-06-20` P-006) to exercise the papercusp-hive
coordination loop end-to-end: observe -> scout -> queen -> place -> bee ->
`work_items:complete` -> git-sync.

Each `loop-canary-*.md` corresponds to a `LOOP-CANARY-*` work-item. Completing a
canary work-item appends a timestamped heartbeat line here; git-sync then carries
the file to `origin/staging`. These paths are deliberately **disjoint** from all
su-fleet source edits (no infra/rename/scaling/gateway files) so canary runs never
collide with real work.

Safe to ignore. Not wired into any build, test, or runtime path.
