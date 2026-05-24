---
title: Papercusp dogfood — Phase 10 (Hyperdrive peer-mirror — optional opt-in)
slug: papercusp-dogfood-phase10-hyperdrive-peer-mirror-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 10 (Hyperdrive peer-mirror)

## Now

**State:** **draft execution plan.** Phase 10 is **explicitly optional** per v5 — it ships the Path B git peer-mirror (D-008) as an opt-in toggle per harness. M-sized. Defer indefinitely if other priorities surface. The cuts-engineer-to-engineer-code-latency win from ~5s → <1s is real but rarely the bottleneck; only worth it when the team feels git-fetch latency.

**Next action:** assess whether Phase 10 is justified by post-Phase-11 dogfood signal. If the team consistently says "I'm waiting on Bob's last commit," ship Phase 10. Otherwise defer.

## Background

Phase 10 implements `## Phase 10 — Path B Hyperdrive peer-mirror (optional opt-in) [M]` from v5 (~line 1284). The Hyperdrive primitives are bundled by Phase 0 P-001 and available regardless; Phase 10 just wires them into a per-harness toggle that mirrors git refs peer-to-peer.

**Default OFF** per D-008. Per-harness toggle; engineers opt in deliberately when they want sub-second code propagation.

**Gate:** Phase 5a complete (Hypercore primitives live, which Hyperdrive builds on). Phase 0 must have verified Hyperdrive specifically in Tauri bundle.

## Phase tasks

### P-056 — Per-peer bare-mirror + post-commit hook [M]

v5: every contributing peer maintains a local bare-mirror at `.papercusp/git-mirror/` and installs a `post-commit` hook that pushes there.

**Files:**
- `apps/operator/lib/harness/peer-mirror/bare-mirror.ts` (new) — `ensureBareMirror(harness)`, `installPostCommitHook(harness)`.
- `apps/operator/app/harness/PeerMirrorSettings.tsx` (new) — per-harness toggle.

**Sub-acceptances:**
- **P-056a** — On toggle-on: bare-mirror initialized at `.papercusp/git-mirror/<harness_slug>.git/`; `post-commit` hook installed in user's worktree that pushes to the bare-mirror.
- **P-056b** — On toggle-off: post-commit hook removed; bare-mirror remains on disk (don't auto-delete user state).
- **P-056c** — Idempotent: re-toggling doesn't duplicate hooks or break existing ones (cooperate with other hooks via append-not-replace pattern).
- **P-056d** — Hook performance: post-commit adds <50ms to commit time.

### P-057 — Hyperdrive replication [M]

v5: Hyperdrive instance per harness peer-mirror; replicates over the harness Hyperswarm topic.

**Files:**
- `apps/operator/lib/harness/peer-mirror/hyperdrive-replicate.ts` (new) — wraps each peer's bare-mirror in a Hyperdrive; joins the harness topic; replicates.

**Sub-acceptances:**
- **P-057a** — Peer A commits → bare-mirror updates → Hyperdrive sees it → broadcasts to topic → Peer B's Hyperdrive receives → Peer B's mirror updates. End-to-end within 1s on healthy mesh (matches v5 §6 claim).
- **P-057b** — Replication survives peer offline + reconnect (Hyperdrive's native replay).
- **P-057c** — Memory + disk footprint: log per-harness sizes to LOCAL; surface in P-056's settings UI.

### P-058 — Auto-`git fetch` on Hyperdrive update event [S]

v5: when Bob's commit arrives via Hyperdrive, Alice's operator runs `git fetch <bob-mirror>` automatically; surfaces "Bob has new commits on F-042" notification.

**Files:**
- `apps/operator/lib/harness/peer-mirror/auto-fetch.ts` (new).
- Notification routing into the existing toast/notification system.

**Sub-acceptances:**
- **P-058a** — On Hyperdrive new-commit event, auto-fetch from that peer's mirror runs within 200ms.
- **P-058b** — Notification appears in operator UI: "@bob pushed N commits on F-042" with click → diff view.
- **P-058c** — Idempotent: re-fetching the same SHA is a no-op.

### P-059 — Per-harness branch-pattern filter [S]

v5: default `^(user/|feature/|fix/|chore/|docs/|refactor/|test/)`; `wip/*` never mirrored.

**Files:** patch to P-056's bare-mirror push step + P-057's Hyperdrive ref filter.

**Sub-acceptances:**
- **P-059a** — Default pattern matches the listed prefixes; `wip/*` always excluded regardless of pattern.
- **P-059b** — Per-harness override via settings; pattern validated as a regex on save.
- **P-059c** — Branches matching no pattern stay local-only; no mirror, no Hyperdrive broadcast.

### P-060 — Privacy-purge tool [M]

v5: guided `git filter-repo` + Hyperdrive cache wipe (best-effort).

**Files:**
- `apps/operator/lib/harness/peer-mirror/privacy-purge.ts` (new) — wraps `git filter-repo` with input-validation; emits warnings about Hyperdrive's append-only nature.
- `apps/operator/app/harness/PrivacyPurgeDialog.tsx` (new) — guided UI with strong warnings.

**Sub-acceptances:**
- **P-060a** — Filter-repo wrapper accepts patterns to remove + a target branch range; warns about rewrite consequences.
- **P-060b** — Hyperdrive cache wipe runs on local peer; warns clearly that other peers still have the data (append-only) until they manually purge too.
- **P-060c** — Guide-text explains "this is best-effort, not a delete — assume the data still exists on some peer."

## Decisions

(None yet.)

## Named fallback rollout

Phase 10 has no substrate fallback — it's optional itself. If Hyperdrive primitives bundle fine in Phase 0 but turn out to be unreliable at scale, Phase 10 stays disabled by default and the toggle is removed from the settings UI in a follow-up.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 10`, `### §14 — Path B`, D-008.
- Prereq plans: `phase5a`, `phase0`.

## Open questions

### Q-1 — Default OFF — when do we propose making it default ON?

After enough harnesses have the toggle ON and report no issues. Suggested threshold: 5+ harnesses, 30+ days, zero reported correctness bugs. Until then, stays off-by-default.

### Q-2 — Should the privacy-purge tool refuse to run if branch protection on the remote prevents push?

Likely yes — purging locally only is misleading. Surface "remote rejects force-push; talk to maintainer" before running.

### Q-3 — Disk footprint warning threshold?

10GB per harness suggested in Phase 5a Q-3. Same threshold here; bigger because Hyperdrive carries blob data.

## For the next agent (Phase 11)

Phase 10 is OPTIONAL — Phase 11 (multi-engineer dogfood) doesn't depend on it. Skip Phase 10 unless dogfood signal explicitly demands sub-second code propagation.

If Phase 10 ships before Phase 11: Phase 11's stress test should include Hyperdrive-on AND Hyperdrive-off comparison runs.
