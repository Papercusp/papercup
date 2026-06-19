# Brief K handoff (su-313d1) — read-plane revocation

## DONE (durable on disk)
- findings-K.md — member-remove read-revocation WITNESSED LIVE on the real .deb.
  - C-001 confirmed: removed member (B, real device key revoked via genuine
    revokeHiveContributor) STILL read A's new content (F-KWIT-POST, origin=remote).
  - Authorized path (resolves E's 403): superuser bearer (<inst>/.papercusp/superuser-token
    + ?superuser=1) elevates unverified-loopback -> trusted.
  - NEW: K-1 hive-scope revoke is live:false (PG-write-only, no h.revoke, no peer-log
    publish); K-2 revocation never federates to joiner (compounds A-003).
  - OBS (inconclusive): B->A content federation didn't flow this run (revoke-log-drop
    vs scale-churn — can't separate). A->B robust.
- RELEASE-READINESS.md §C-001/E-R1 updated (decision = option d; K live witness; K-1/K-2).
- TEST (teeth-verified GREEN->RED->GREEN): packages/operator-core/lib/hive-revoke-contributor.live-gap.test.ts
  (4 tests; guards K-1 live:false/PG-only invariant). Source byte-clean (only the new
  test file added).

## PENDING (MCP timed out — operator :3070 overloaded, load 20+; retry when it dips)
- File the K-1/K-2 EI (body in findings-K.md + the EI draft; kind=bug, sev=major,
  scope harness:papercup, topics shared-hive/federation).
- coord:send wrap-up to su-9140a (pair state), su-d2230 (Brief I: K-2=A-003),
  su-d53bf (Brief M: pair free for read-only render).

## PAIR STATE (~/.papercusp-shared-hive-retest, :154) — LEFT UP per su-9140a
- A=papercupai(gh279242982) :23788/PG17692 owns hive key; B=aviynw(gh1567022) :16553/PG22267.
- A revoked_pubkeys cleared to {} after control. Seeded hive_members rows left as evidence
  (279242982, 1567022 w/ B real device key Z2LOLc/QCz84xIin8yUXgedmgJu7nBgW3bgmErFyZoY=).
- F-KWIT-* feature markers left as evidence.

## VERDICT (C/E/K read-plane dimension): YELLOW — release-honest (option d), not release-clean.
GREEN needs Move 2 (re-key on transition) — roadmap, product-gated, owner already chose d.
