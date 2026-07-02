# p2p-dist fleet — launch brief (2026-07-02, leader su-3700b)

You are a member of the `p2p-dist` fleet working plan **`p2p-work-distribution-2026-07-02`**
(harness papercusp). The plan is CONSOLIDATED v3: **items are the spec** — every binding
amendment from 5 audit rounds (D-011..D-015) is absorbed into item text. Read your lane's
items IN FULL before writing anything; the decisions section is provenance/rationale only.
If an item and a decision conflict, the item wins — flag the conflict to the leader.

## Non-negotiables (from the audits — do not relearn these live)
- Receiver-enforced, LOUD refusals everywhere (D-004). No silent drops.
- New hive-scoped tables MUST thread the hive-home workspace via the shared resolver +
  regression test asserting write/capture/drain agree (C3 — WI-1564 class).
- Grant/revocation enforcement reads BYPASS cache tiers (C6 — WI-1547 class).
- Revocation/dangerous paths gate on EPOCHS, never wall-clock (X6).
- Identity keys = GitHub NUMERIC user-id; logins display-only (X9).
- tsc discipline: `npx tsc --noEmit -p .` directly; ~333-error pre-existing baseline in
  operator-core — grep YOUR files only.
- Commit to the canonical staging tree; the green gate is yours to keep green.

## Lanes (claim your lane's items via plans:set-status in_progress; coord:send the leader on start/finish/blockers)
- **Lane A — grants core:** P-001 (p2p_peer_grants schema, epochs, rate-caps, device
  exclusions, C3 test) then P-004 (refusal receipts + p2p:trace skeleton, M21 offer-id
  threading).
- **Lane B — surface + rollout:** P-002 (settings page, kill-switch wind-down + X13 hard
  deadline, starter profile, live foreign-work view) then P-005 (tier flag,
  GITHUB_BRIDGE-pattern default-ON, tiers 1/2/3 wiring).
- **Lane C — substrate design:** P-006 (per-fleet selective federation scope — DESIGN DOC +
  decision proposal; consumers P-101/P-108/P-206) then P-108 (results channel: pick option
  (a) nested executor-namespace vs (b) per-fleet visibility — write the trade-off, recommend,
  DO NOT build until the leader ratifies the decision).
- **Lane D — git plumbing + admission:** P-110 (canonical-merge admission check for
  foreign-marked refs — the github-ingress-admission dual; buildable NOW, pattern is landed
  code) then P-109 (foreign-worktree plumbing DESIGN: worktree-guard exemption, commit lane,
  mirror lane, X4 clone/ODB choice — design doc first, it is the largest Phase-1 item).

## Gates you do NOT own (leader-held)
- P-003 is LIVE-1-gated (WI-1585 chain). Do not start it.
- Phase 1 BUILD (beyond P-110 and design docs) waits for: C2 capability-profile design,
  C4 publisher-stamped-assignment design, P-105 loopback-boundary spec.
- Design decisions (P-006 choice, P-108 (a)/(b), P-109 policy surface) need leader
  ratification before implementation — send a decision proposal, keep moving on the rest.

Leader: su-3700bc41-26db-4549-afb7-3dcf8fd072dc (audience `@fleet-leader:p2p-dist`).
Report cadence: on lane start, on each item done (with evidence: tests, tsc, file paths),
and immediately on any blocker. Unverified claims stay claims — say so explicitly.
