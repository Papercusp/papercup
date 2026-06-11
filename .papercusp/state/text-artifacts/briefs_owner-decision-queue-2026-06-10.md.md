---
rel_path: "briefs/owner-decision-queue-2026-06-10.md"
updated_at: 1781137426880
_body: "content"
---

# Owner decision queue — consolidated 2026-06-10 (brief 15-D, su-3aeec)

Every needs-human / owner-gated item fleet-wide, one line each: the decision, the
recommended default, what it unblocks. Cross-checked against `plans:items
{ needsHuman: true }` + the brief-15 §D roster + the garden-sweep findings.
**Rev 2 (evening):** added the asks briefs 05/10/14 handed to this queue at
their closeouts; moved conversations P-001 to resolved (owner ratified it
interactively); refreshed items the 18:30Z green deploy changed.

## A. Credentials / keys / spend (flag, don't hunt)

1. **production-readiness P-001 — add the `SUBMODULES_PAT` repo secret.**
   Recommend: do this first — until then CI checks out zero submodules and runs
   zero tests. Unblocks the ~858-test CI gate; then the plan flips shipped.
2. **hive-inference-gateway P-004/P-018 — paste `claude setup-token` output**
   (one for the bound account, more for per-machine accounts). Headless login is
   proven infeasible (D-010). Unblocks the OAuth provider + pool scale-out.
3. **INFERENCE_GATEWAY flag flip** — reroutes the WHOLE fleet through one
   account. Recommend: hold until the bound account has the aggregate 5h budget
   + the systemd service is deployed (plan's own gate).
4. **hive-inference-gateway P-016 — gen-0 baseline through the gateway** (real
   opus spend, isolated recipe D-011). NOTE: the apiary gen-0 baseline itself
   already ran 2026-06-10 ($6.06/$50, mean 5.950) — decide whether the
   gateway-routed re-run is still wanted or P-016 is overtaken.
5. **search-core-rerank — provision `ZEROENTROPY_API_KEY`** (wiring is a no-op
   without it). Recommend: provision if rerank is wanted now; else close the
   plan as dormant-by-design. Unblocks cross-encoder rerank at 3 search sites.
6. **mobile-apps — APNs .p8 + Key ID + Team ID** (needs Apple Developer
   enrollment) and **picovoice access key** (Android wake-word). Everything
   else on both platforms is done + E2E-verified.
7. **voice-realtime-tui P-010 — set `fullAgentEngine` + `elevenLabsAgentId`**
   in /settings/voice, then press V in the pui. Unblocks the live EL session
   leg; all engineering smoked to the credential boundary.

## B. Arm / flip decisions

8. **learning-system-audit P-001 + P-012 — arm the implement lane (D-002):**
   set `PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS`, flip `IMPROVEMENT_AUTO_IMPLEMENT`,
   re-run the seeder `--arm-implement`. Bug-only, protected paths enforced,
   resolve back-edge evidence-gates closure. Recommend: yes, with a dedicated
   runner harness; watch the first 10 dispatches. This is the consume edge of
   the whole self-improvement loop (close-the-self-improvement-loop is now
   superseded into it).
9. **learning-system-audit D-004 / P-060 + self-improvement-stack-reconciliation
   a/b/c — the eval-engine fork.** One decision settles both plans. Recommend:
   (a) eval-battery lib stays the engine; tests tab is the UI (D-004's own
   recommendation). Brief 14's closeout confirms this is now the LAST gate:
   all non-gated reconciliation work is done; the deferred reconciliation
   P-004 sweep + the apiary `runBattery` repoint wait on this fork (+ su-b19a0's
   live gen-0 run finishing).
10. **audit P-069 — flags default audit vs the alpha default-ON policy**
    (ORACLE / HARNESS_PHASES / DESIGN + the false-default batch,
    libs/flags/src/types.ts:71-100). Recommend: flip each to ON per policy
    unless genuinely unsafe; confirm per flag.
11. **inboxDurableEscalations flag** — inbox-cards Phase D shipped complete but
    dark (default-OFF was human-greenlit at the time). Recommend: enable per
    the default-ON policy now that it's been stable.
12. **Unsupervised overnight Hive** — start-hive-wake-orchestration shipped,
    but its P-016 gate stands: don't leave the Hive running unattended until
    autoloop-pot-operator-rebuild P-005 `dispatch:` caps (concurrency/costCap/
    safetyCeiling) are real. Recommend: build the caps next; Pause-gate is the
    interim net.

## C. Ratifications / design sign-offs

13. **audit D-007 — approve the auth-tier model + the Wave-1 rule** ("mutating
    routes → loopback, with named exceptions", EI-100). Handed to this queue by
    brief 05's closeout; unblocks audit P-032, the mass route-gate flip.
    Recommend: approve — brief 05 shipped 8/9 hardening items with 137 tests on
    this design.
14. **coord-e2e P-002 residual — the watermark same-ts cursor-skip hazard.**
    Brief 10 pinned it with a test; the structural fix is widening the cursor
    to (ts, msg_id) — an ordering-contract change, owner call. Recommend:
    approve the (ts,msg_id) cursor as its own small plan.
15. **cloud-deployment-layer P-005 — ratify D-006..D-009** (orchestrator-on-
    frame, embedded-pg-per-frame, Queen placement, Hive/Swarm naming).
    Unblocks Phase 3/5 design.
16. **swarm-coordination Phase 0 — ratify the two open forks:** soft shared
    throughput-pool vs hard per-Swarm leases; the compact budget primitive's
    shape. Unblocks single-hive build sequencing.
17. **the-hive-lexicon EI-230 — wordmark:** ratify "THE SWARM" as the sub-brand
    (then update D-005/D-007) or repoint HIVE_TITLE to "The Hive". Then that
    plan flips shipped. Recommend: "The Hive" (consistent with D-005 +
    Swarm=deployment-unit naming).
18. **collaborative-plans-initiatives + plans-harness-scoped — sign-off pair**
    (collab model D-001..D-004, then the blocked-by). Both now truthfully
    read draft/ready. Recommend: park until collab work has a driver.
19. **psu-wrappers-and-plan-tracked-launch — confirm phase ordering.** Caveat
    from the sweep: agent-launch-unification has since shipped ONE launch
    implementation for every agent — verify this plan isn't overtaken before
    investing. Recommend: triage-first.
20. **unify-agent-launches P-009 — three deferrals:** (1) D-005 scanner
    teardown after the scheduled `scan` blueprint is live-verified; (2) D-003
    audit→`review` convergence (changes the user-protection gate — needs
    gate-owner sign-off, D-006); (3) finalizer executor schema. Plus a
    supervised live smoke of each converted launch on next :3070 restart.
21. **release-pipeline P-010 — desktop devUrl/:3070 conflict** (desktop `npm
    run dev` loads the green release, not the working tree). Deferred per
    owner — needs your running desktop to verify. Recommend: give the
    desktop's spawned dev operator its own port.
22. **hive-agent-tabs P-004 — the live attach verify** in the dock (colony
    driver renders roster + 🐝 `claude --resume` panes; between/after-turn
    takeover is the known unknown). Per the Queen's 18:30Z note, this can now
    run directly against the deployed green :3070.

## D. Reviews / small triage calls

23. **app-wide-test-coverage** — flip shipped, or keep active as the standing
    campaign anchor (D-003 watch list: papergrid, pubsub-substrate, the 06-09
    harness components, post-churn re-audit). Recommend: keep as anchor.
24. **watchdog-audit-2026-06-09 D-004 + D-005** — review backfill-dropped +
    auto-implement-stays-dark (the robustness plan itself is now shipped).
25. **apiary gen-0 baseline numbers** — review when convenient (mean 5.950).
    The two noise caveats are now FIXED: repeats support landed (mig 217,
    EI-164) and the fix-injected-bug corpus is self-contained (EI-162) —
    a cleaner re-run is cheap when wanted.
26. **papercusp-dogfood-phase4 — confirm the P-026 de-gate** (or ask for the
    formal single-engineer run). The registry-drift 404 it flagged is now
    verified FIXED at HEAD (b1ab60518; papercup /prompts 200 on :3170).
27. **fs-watcher-retirement — resume or drop.** Verified at HEAD: the chokidar
    watcher is still wired (host-bootstrap + 4 consumers); conflicts with the
    PG-by-default storage policy but has had no driver for 3 weeks. (Related
    signal from brief 02: ~23k live FSWatchers found while heap-profiling →
    EI-255.)
28. **docs-and-memory P-006 — mem0 revive-vs-retire: likely OVERTAKEN.**
    memory:* is live + populated, the hybrid backend shipped + benchmarked
    (T3 judged 3.92/5 beats both legs; T4 boot-recall proven live).
    Recommend: close as revived-by-events; confirm.
29. **docs-and-memory P-005 — Starlight big-bang:** D-007 owner reconcile
    already kept ONLY the additive subset (now shipped). Recommend: close
    P-005 as declined, consistent with the prior decline.
30. **un-hardcode-plan — (a) resume full consolidation vs (b) accept current
    state.** Recommend: (b) — no current driver; shrink the plan.
31. **host-architecture-v2** — Phase 2/3a/6a + route-migration audit remain;
    resume-or-park call.
32. **operator-core-headless-serve** — ship-with-residue (browser-glue
    impurity accepted) or keep open for the untested Windows/WSL live pass.
33. **proxy-witness-pattern** — keep as future-design draft (demoted from
    ready in the sweep) or archive outright.
34. **dogfood May-24 corpus labeling** — overview + execution-plan-index + 2
    unaccepted design memos (+ v5 itself as live-reference): label as
    reference-archive or keep listed as plans. Recommend: reference-archive.
35. **native-terminal** — macOS SwiftTerm / Windows ConPTY embeds need their
    platform toolchains (seam ready). Convenience: restart the desktop to get
    the 3-pane dock.
36. **frame-bootstrap residue (brief 05 flag):** harness_app / harness_zero
    passwords are still baked in (P-031 randomized only the superuser
    harness_admin). Decide whether to randomize those two as a follow-up.

## In-flight owner work — left alone (per 00-COMMON)

- promote-policy P-016 (live Tier-1 apply) · universal-schema P-007 (Tier-1
  run = booting the restart harness fleet; EI-124 fixed) ·
  token-usage-reduction P-013 (calendar-gated) · su-b19a0's live gen-0 run.
- Brief 12 (su-8f376) delivers prepare-only runbooks + one-line asks for:
  shared-hive P-008/P-009 (real-metal), coord P-010 (two-box sweep),
  holepunch P-014 (voice mesh bench fleet) — see
  `briefs/brief12-owner-runbooks-2026-06-10.md`.

## Resolved (formal close only)

- **conversations-tab-simplify P-001 — RATIFIED** by the owner interactively
  2026-06-10 (all of D-009); brief 13 (su-b6c7f) is executing the post-gate
  items. Was item 14 in rev 1 of this queue.
- tui-glyph P-001 — owner approval was already recorded on the item; plan
  flipped shipped.
- learning-system-audit D-005 (scout observability) — satisfied in substance
  (scout_ticks live).
- apiary pre-run open questions (solver model / repeats / spend cap / trigger)
  — settled by the executed baseline run; the repeats + fixture caveats are
  now fixed (mig 217 / EI-164; self-contained corpus / EI-162).
- official-blueprints P-003 — all 16 concrete blueprints verified live on the
  prod Cupboard (papercupai-attested); plan shipped.

