---
rel_path: "b13-closeout/baseline-2026-06-12T0755Z.json"
updated_at: 1781251212742
_body: "content"
---

{
  "purpose": "B-13 close-out baseline for plan self-improvement-consume-edges-2026-06-12 (P-013). Pre-gate snapshot to diff against at supervision + reconciliation time. Recorded by su-e9bc8 at 2026-06-12T07:55Z, before any of the three gates (consume-edges:spawn-fixed / ledger-landed / B-05:done) fired and before the wedge-triad fix deploy train.",
  "digest": {
    "headline": "173 captured (173 open) — 78 auto-eligible, 95 human, 2 likely-dup clusters",
    "byKind": { "bug": 120, "change": 52, "feature": 1 },
    "bySeverity": { "major": 98, "minor": 71, "critical": 4 },
    "triageDecision": { "gate": 163, "untriaged": 10 },
    "ideaType": { "process": 173 },
    "note": "P-021 'before' snapshot: 100% process / gate-or-untriaged — the EI-364 degeneracy, must be non-degenerate after B-07 re-triage."
  },
  "implementLane": {
    "inFlightAssigneeImprovementRunner": 49,
    "attemptsGt0": 52,
    "backfilledAssignedAt": "2026-06-12 03:21:25 -04 (su-6fa1f wedge backfill; 2h stale-claim window ⇒ pool re-entry ~09:21Z, post-deploy)",
    "inFlightIds": ["EI-105","EI-109","EI-111","EI-115","EI-116","EI-12","EI-122","EI-127","EI-147","EI-148","EI-151","EI-174","EI-175","EI-177","EI-178","EI-187","EI-20","EI-201","EI-202","EI-207","EI-208","EI-210","EI-225","EI-227","EI-233","EI-234","EI-248","EI-249","EI-261","EI-265","EI-287","EI-302","EI-35","EI-39","EI-44","EI-49","EI-50","EI-52","EI-62","EI-71","EI-72","EI-75","EI-77","EI-80","EI-83","EI-86","EI-9","EI-98","EI-99"],
    "watchItem": "journal 'skipped: N in-flight' must plateau ~4-5 post-deploy, not grow (su-6fa1f)"
  },
  "watchdogTick0345Local": {
    "knownOpenKeys": ["repeated-tool-error:plans:set-status:caller","repeated-tool-error:chat:ask_choice:caller","repeated-tool-error:locks:acquire:caller","repeated-tool-error:fleet:spawn:structural","repeated-tool-error:memory:search:structural","service-down:shop","expired-lease:expired-leases","fire-circuit-open:circuit:gymloopharness:gym-cycle","stalled-feature:stalled:hive-canary","insight-staleness:attention-push-delivery","insight-staleness:dbos-durable-execution-gotchas","insight-staleness:desktop-ipc-transport-map","insight-staleness:dogfood-bootstrap","insight-staleness:dogfood-go-live-runbook"],
    "knownOpenPrefilteredLast5Ticks": 70,
    "expectations": "B-02 clears repeated-tool-error:fleet:spawn:structural; B-01 clears fire-circuit-open:circuit:gymloopharness:gym-cycle"
  },
  "planReferencedEIs": {
    "open": {
      "EI-233": {"tier":"auto","attempts":1,"assignee":"improvement-runner","note":"llm-test cannot run, meridian down"},
      "EI-237": {"tier":"human","attempts":0,"note":"llm-test auth 401"},
      "EI-261": {"tier":"auto","attempts":1,"assignee":"improvement-runner","note":"meridian :3456 vs :3458"},
      "EI-265": {"tier":"auto","attempts":1,"assignee":"improvement-runner","note":"gym fire-path error-backoff"},
      "EI-315": {"tier":"human","attempts":0,"note":"llm-testing starved under fleet load"},
      "EI-334": {"tier":"human","attempts":1,"note":"fleet:spawn structural error (B-02)"},
      "EI-340": {"tier":"human","attempts":0,"note":"flat needs-human queue (B-08)"},
      "EI-352": {"tier":"human","attempts":0,"note":"flat queue blocking-impact (B-08)"},
      "EI-353": {"tier":"human","attempts":0,"assignee":"su-c9999","note":"db:next-migration handed out taken number"},
      "EI-363": {"tier":"human","attempts":0,"note":"known-open prefilter no aging escalation (B-06)"},
      "EI-364": {"tier":"human","attempts":0,"note":"degenerate triage (B-07)"},
      "EI-365": {"tier":"human","attempts":0,"note":"auto-implement black hole (B-04/B-05)"},
      "EI-366": {"tier":"auto","attempts":0,"note":"COMPOUND fragment pollution (B-10)"},
      "EI-368": {"tier":"human","attempts":0,"note":"gym-operator boot Napi crash (B-01)"},
      "EI-370": {"tier":"human","attempts":0,"note":"swarm-full-loop.integration red — captured today, NOT plan-referenced, check at reconciliation"}
    },
    "notInOpenSet": { "EI-268": "absent from open digest — already resolved/closed before baseline; plan only said 'EI-268-class symptoms'" }
  },
  "gates": { "consume-edges:spawn-fixed": "await 850", "consume-edges:ledger-landed": "await 851", "consume-edges:B-05:done": "await 852", "registeredAt": "2026-06-12T07:49Z", "timeout": "4h wake" }
}
