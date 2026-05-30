---
title: Papercusp dogfood — Phase 11 (multi-engineer dogfood)
slug: papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26
created: 2026-05-26
updated: 2026-05-30
status: active
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 11 (multi-engineer dogfood)

## Now

**State:** Substrate cross-machine replication wiring SHIPPED 2026-05-26 (`728901c3`). P-078 boot-side wiring also SHIPPED 2026-05-26: `boot-all.ts` now reads `.harness/shared.json` from each harness's project dir on boot and synthesizes a `{ kind: 'gh', github_repository_id }` `swarmBinding` automatically. Commits `cb875057` (loader) + `aa9f566e` (boot-all wire). Tests: 10 (loader) + 5 added to boot-all (18 total). Optional refinement remains: `join-shared-harness.ts` step 4 could short-circuit-pass the binding without waiting for the next boot, but that's redundant — once shared.json is written, the next boot picks it up. P-079 (2-instance cross-machine smoke test) is now the verification gate.

**Next:** P-079 — run the 2-engineer cross-machine smoke test (Q-2's same-laptop surrogate is acceptable first pass). Requires opening ShareWizard on the papercup harness (P-077) so a `.harness/shared.json` actually exists. Bravo (second instance) then joins via Entry 4 and the swarm should pair automatically through the boot-all wiring shipped today.

## Background

Phase 11 closes the dogfood loop: Papercusp's own engineering team uses Papercusp to ship Papercusp, with 2+ engineers, on the substrate, cross-machine, daily.

It depends on **every** prior phase:
- **Phases 0-3:** substrate gates, identity, completion_ref, reactivity. ✅ All shipped.
- **Phase 4:** single-engineer dogfood on `state: private`. ⚠️ P-026 blocked on registry-substrate drift (see phase4 plan rev 1).
- **Phase 5a:** Hyperbee substrate + projections + Hyperswarm replication. ✅ As of `728901c3`. Native macOS/Tauri-bundle verification (P-030/P-031) deferred per user direction.
- **Phase 5b:** UI integration + clobber-toast. ✅ All 4 tasks + write-side stack live.
- **Phase 6:** orchestrator distributed claim + manual "set active". ✅ End-to-end.
- **Phase 7:** PR lifecycle. ✅ (P-041 auto-rebase deferred — not blocking).
- **Phase 8:** sidebar Insights + identity UI. ✅ All shipped 2026-05-25/26.
- **Phase 9:** Cupboard + Discord + sync-with-main. ✅ Cupboard live at `https://cupboard.papercusp.com` since 2026-05-26.

Phase 11 is the validation milestone. Its deliverable is *not code* — it's "two engineers on different machines used Papercusp to ship a real Papercusp feature, with the substrate federating across them, for a calendar week."

## Phase tasks

### P-077 — Bind Papercusp's own repo as the first shared harness [S]

The dogfood seed. Take the existing papercup harness (registered in Phase 4 P-024 as `state: private` in `papercusp-workspace`), run it through the §5 ShareWizard, pick `shared-private` (NOT shared-public — keep Cupboard publish out of the loop until the team is comfortable).

**Files:** None — this is a behavioral commitment via the existing wizard.

**Sub-acceptances:**
- **P-077a** — Wizard step 1-8 succeeds: device attestation, contributor binding, user branch + worktree provisioned, contributor row published to Hyperbee.
- **P-077b** — `harness_registry.state` for papercup flips from `private` → `shared-private`. Confirm via PG read.
- **P-077c** — `harness_shared.contributors` has the publisher's row with `binding_status: 'verified'`.
- **P-077d** — Substrate diagnostic at `/admin/dogfood-substrate` shows the swarm peer-count for papercup ≥ 0 (i.e. swarm join didn't fail).

**Decision rule:** PASS when P-077a-d done. Should take <15 min.

### P-078 — Wire swarmBinding through ShareWizard + boot path [M]

`bootHarnessSubstrate` now accepts a `swarmBinding` opt (shipped `728901c3`). But ShareWizard step 4 (bootstrap_hyperbee) doesn't yet pass it. Plumb it.

**Files:**
- `apps/operator/lib/harness/join-shared-harness.ts` — step 4 + step 8 should resolve `github_repository_id` from the harness link / contributor row + pass as `swarmBinding: { kind: 'gh', github_repository_id }`. Pre-binding (the bootstrap peer creating the harness) uses `{ kind: 'local', workspace_id, harness_slug }`.
- `apps/operator/bin/host-bootstrap.ts` (or wherever the all-harnesses boot loop lives) — for already-registered shared harnesses, resolve the binding from `harness_registry` columns + pass on boot.
- `apps/operator/lib/sync/hyperbee/boot-all.ts` — its iterator may need the binding plumbed too.

**Sub-acceptances:**
- **P-078a** — A freshly-shared harness sees its `swarm` handle non-null on boot (visible via the booted-harnesses substrate dashboard).
- **P-078b** — A `state: private` harness sees `swarm: null` (no swarm join — the existing comment is honored).
- **P-078c** — Boot-event `peer_connected` fires when a second machine joins the same topic. Verified by tailing `boot_history` while running P-079.

### P-079 — Two-engineer cross-machine smoke test [M]

The validation event. Two laptops (call them Alpha + Bravo), both with Papercusp installed, both running the same papercup harness as `shared-private`.

**Acceptance walk-through:**
1. **Alpha** creates the harness (or already has it post-P-077) and goes through `ShareWizard` → `shared-private`. Confirms peer-count is 0 (nobody else joined yet).
2. **Bravo** opens Papercusp, hits Entry 4 (link-paste), pastes the harness link Alpha shares (`papercusp://join?token=...`).
3. **Bravo's** join flow runs all 10 steps: oauth/clone/swarm-join/bootstrap-hyperbee/seed-pg/user-branch/contributor-file-push/publish-binding/verify-binding/route-insights.
4. **Alpha** observes Bravo's `contributor_publisher` event arriving (visible as Bravo's row in the Contributors tab + a `peer_connected` boot event in the Bravo entry).
5. **Bravo** sees Alpha's features in his Features tab (same content as PG via the projection).
6. **Bravo** clicks "Pull into my queue" on F-DOGFOOD-002. **Alpha's** Features tab shows Bravo's avatar in the queue cluster on F-DOGFOOD-002 within 30s.
7. **Alpha** clicks "Start working" on F-DOGFOOD-003. **Bravo's** UI shows the feature as "Taken" within 30s.

**Likely friction points:**
- Hyperswarm DHT bootstrapping — first connect can take 30-60s as peers discover.
- Firewall / NAT — Hyperswarm UDP hole-punching may fail on hostile networks. Document workaround (named-fallback rollout below).
- Schema-version skew if Alpha + Bravo are on different commits.

**Decision rule:** P-079 PASSES when 5+ of the 7 walkthrough steps land within 30s of the user action. Each step that fails is recorded as a P-027-style observation on F-DOGFOOD-001.

### P-080 — Daily-use commitment (calendar week) [M]

P-079 is a single 30-min test. P-080 is the soak: Alpha + Bravo each use Papercusp for at least 5 consecutive working days on the papercup harness, with their actual papercup work (no parallel queue-shadowing).

**Sub-acceptances:**
- **P-080a** — At least 3 features ship through the substrate (feature filed → claimed → worked → PR → merged → completion_ref stamped).
- **P-080b** — At least one feature is worked by both engineers via the trust-list / PR-reviewer flow (Phase 8 P-049).
- **P-080c** — At least one clobber-toast fires under real contention (Phase 5b P-035 — both engineers write the same row within the 60s window). Records the wall-clock + which engineer "won."
- **P-080d** — No engineer bypassed Papercusp for the entire week. "Bypass" means `git push` from outside the substrate UI on the user-branch, or merging without an open PR Papercusp tracked.

**Decision rule:** P-080 PASSES with all 4 sub-acceptances. PARTIAL is acceptable if 3 of 4 land + the failure is a known follow-up.

### P-081 — Decision gate + handoff to public dogfood [S]

End-of-Phase-11 verdict. Either:
- **PROCEED to Phase 12+** — public-facing dogfood (third engineer outside the team; Cupboard listing; etc).
- **PAUSE for fix arc** — list the named blockers from P-080's friction log.

**Sub-acceptances:**
- **P-081a** — Verdict recorded as `D-001` in this plan.
- **P-081b** — F-DOGFOOD-001 observations triaged into `must-fix`, `track`, `wontfix` per Phase 4 P-028's pattern.


## Substrate wiring (2026-05-30)

- **P-001** `todo` ✅ SHIPPED (`409681ff`): Hyperbee→PG read-loop (Phase 5a P-031 read side). startHyperbeeReadLoop replays each harness's merged Autobase view op-log into PG via applyHyperbeeOpToPg (which had ZERO runtime callers — substrate was write-only). Driven by the 'update' event + 1s polled fallback; idempotent op-replay; wired into bootHarnessSubstrate start+close. read-loop 7/7, boot/boot-all 31/31, tsc clean.


## Substrate wiring (2026-05-30)

- **P-002** `todo` ✅ SHIPPED (`a3f6c812`): ShareWizard finalize route (P-077 backend). POST /api/harness/:slug/share/finalize → finalizeShare() writes a valid .harness/shared.json (SharedHarnessConfig: topic/github_remote/github_repository_id/privacy/claim_status/created_at/schema_version) via writeSharedConfig + flips registry state to shared-{private,public} via setHarnessState. boot-all's defaultResolveSwarmBinding keys the swarm on github_repository_id, so this is what lets a harness actually join the swarm. Core logic deps-injected; registered in routes/index.ts (mirrors join-link). share-finalize 9/9, tsc clean.


## Substrate wiring (2026-05-30)

- **P-003** `todo` TODO (P-077 frontend, NOT done): point ShareWizard.tsx's finalize action at POST /api/harness/:slug/share/finalize (it currently no-ops / doesn't call the route), passing {github_remote, github_repository_id, privacy, discord_channel_url?}. NOTE: the github-facts/binding step must supply a real numeric github_repository_id (boot keys the swarm on it; 0/null → swarm stays null). Also needs a substrate RE-BOOT trigger: writing shared.json does not retroactively swarm-join an already-booted harness (bootHarnessSubstrate created it with swarm:null) — finalize should rebootHarness or it joins on next operator restart. Blocked this session: ShareWizard.tsx (649 lines) was unreadable via Read/grep/sed (tool-output unreliability) so I did not edit it blind.

## Decisions

(Recorded at P-081 time. None yet.)

## Named fallback rollout

If P-079 / P-080 surface that Hyperswarm replication is unreliable on the user's network (NAT-blocked / corporate firewall / etc), the named-fallback rollout is:

1. **First fallback — DHT bootstrap node**: spin up a single always-online Papercusp instance on a public IP (Hetzner, a Cupboard worker neighbor, etc) that joins every harness's topic + acts as a relay. Hyperswarm will route through it. Documented by Hyperswarm; minimal extra code.
2. **Second fallback — explicit peer addresses**: per-harness `peers: ['ip:port', ...]` in the wizard. Bypasses DHT discovery entirely. Code change: extend `joinHarnessSwarm` to accept a peer list + dial directly.
3. **Last resort — Cupboard-mediated sync**: tunnel ops through the Cupboard worker as a relay. This breaks the P2P promise but keeps the substrate functional in hostile networks. Document as a tier-3 fallback.

Choose the first fallback that works for the actual environment. Don't preemptively wire all three — the named-fallback rollout exists so we have an escape hatch, not a complexity budget.

## Cross-references

- Master: `papercusp-dogfood-v5-2026-05-23.md` `## Phase 11` (~line 1290).
- Prereq plans: every prior phase. Especially:
  - `phase4` — single-engineer dogfood (P-026 must pass first per spec; in practice we may proceed to Phase 11 with P-026 blocked as a known issue if the registry drift is a quick fix).
  - `phase5a` — substrate + replication wiring.
  - `phase5b` — UI integration + clobber-toast.
  - `phase6` — orchestrator claim + working-set.
  - `phase9` — Cupboard (not required for shared-private, but useful for the public-dogfood handoff).
- D-002 — distributed claim via Autobase merge order.
- D-012 — LWW for clobber-toast.

## Open questions

### Q-1 — Phase 4 P-026 prerequisite — strict or pragmatic?

The v5 spec says Phase 4 must finish before Phase 11. Today Phase 4 P-026 is blocked on registry drift. Two paths:

- **Strict:** fix Phase 4 P-026 first, then Phase 11.
- **Pragmatic:** P-026's real value is "we observed pain at single-engineer scale." We've ALREADY observed substantial pain in this loop (registry drift surfaced, substrate state tracking gaps documented). Proceed to Phase 11 with the Phase 4 finding as the first F-DOGFOOD-001 observation.

Suggested: pragmatic. The registry drift is its own follow-up; Phase 11 doesn't depend on it strictly because Bravo's join flow goes through Entry 4 (clone-fresh), not the locally-registered papercup path.

### Q-2 — Single laptop, two operator instances — valid surrogate for P-079?

Two operator instances on different ports on the same machine COULD smoke-test the cross-peer flow without two real machines. Hyperswarm should still pair them.

Suggested: yes, **first** P-079 as a 2-instance same-laptop test. If that passes, repeat on 2 real laptops to validate NAT / firewall. The same-laptop test catches code bugs; the cross-laptop test catches network bugs.

### Q-3 — When does Papercusp's papercup harness flip to `shared-public`?

After P-080 passes. Going `shared-public` puts the harness in Cupboard (Phase 9), which is a public claim about Papercusp's stability. Wait until the team's confidence is concrete.

## For the next agent

Phase 11 is the milestone — there's no Phase 12 plan yet because we should see what Phase 11 surfaces before designing the next arc. After P-081 PROCEEDs, the natural next direction is *outside Papercusp* — a third engineer who doesn't work on Papercusp uses Papercusp on their own harness. That validates the substrate as a product, not just a self-host.
