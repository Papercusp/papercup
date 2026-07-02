# Resume brief — su-3700b (git-plan + github-bridge leader) — post-compaction

**Identity:** su-3700bc41-26db-4549-afb7-3dcf8fd072dc · fleet LEADER of `git-plan`
AND `github-bridge` (registry-level dual leadership; presence label shows only
the newest — the audience-host union fix I landed makes @fleet: delivery reach
me anyway). Harness papercusp · canonical tree `/home/marsh-office/papercupai-workspace/papercusp`
(edit ONLY here). MCP dropped → `node scripts/mcp-call.mjs <tool> '<json>'
--client su-3700bc41-26db-4549-afb7-3dcf8fd072dc --harness papercusp` from the
canonical tree. AUTO mode ON; loop:arm 1800s active.

## PRIMARY TASK ON RESUME (owner-directed): begin `p2p-work-distribution-2026-07-02`
The plan is FULLY DESIGNED + 4x audited (D-001..D-010 skeleton, D-011..D-014
audit amendments ~45, ALL BINDING). Owner is having an INDEPENDENT agent do a
final audit. First unit of work = **M23 CONSOLIDATION PASS**: rewrite the plan
items so each absorbs its D-011..D-014 amendments (implementers must not need
to cross-reference decisions), then hand off to the independent auditor. Read
the plan's Decisions section FIRST — it is the real spec.
- Buildable BEFORE LIVE-1 closes: Phase 0 P-001 schema design + P-002 settings
  page (attestation-independent) with C3 (WI-1564 workspace threading + test)
  baked in. Phase 1+ implementation GATED on C1/C2 designs + LIVE-1.
- Sibling plans: `github-bridge-hive-egress-2026-07-02` (2-member fleet
  launched, working); `local-concurrent-inference-2026-07-02` (other team;
  our P-207 depends on its requester-tag deltas — relayed, fail-closed if late).

## STILL OPEN (secondary, loop-monitored): LIVE-1 endgame (P-059, plan cross-machine-coord-parity)
- Deploy 346eb44c LANDED (both WI-1585 halves: attestation-merge + VM join fix).
- AWAITING: iMac device attested on tower (check: hive_members.aviynw
  device_attestations LIKE '%lWfY6T6R%') + VM hive_members non-empty + the two
  D5 probes cross-materialize. 1c2e7 = verification lane (armed); 89b88 = fixer.
- THEN: D2 (send+receipt), D4 (coord:wake), D3 full-loop, D6 PRESENCE_GOSSIP
  writer flip + 30-min soak → P-059 done → plan complete.
- Runbook = docs/plans/LIVE-1-rig-runbook-2026-07-02.md (drill log + gotchas).

## Access + gotchas (hard-won, do not rediscover)
- iMac = QEMU VM ON this tower: `ssh aviweiss@172.31.44.2` (NEVER Avis-iMac.local
  — stale 169.254.x). VM coord: `PAPERCUSP_HONO_PORT=$(port from
  ~/.papercusp/endpoint-ipc.json) '/Applications/Papercusp Server.app/Contents/Resources/sidecar/bin/node'
  /tmp/mcp-call.mjs <tool> ... --client su-live1-imac-probe --workspace
  papercusp-workspace --harness papercusp` (port CHANGES per app restart). VM
  PG: tunnel to port in ~/.papercusp/embedded-pg.json, harness_app/harness_app_pwd.
  VM zsh: quote `===` separators. Mem0: avis-imac-is-local-qemu-vm.
- Tower PG: password from DATABASE_URL in env of any live operator process
  (`sudo -n cat /proc/<pid>/environ`), harness_admin@localhost:5432/papercusp.
- Tool arg shapes: plans:set-now {slug,state,next}; plans:new {slug,title,
  content,force}; plans:set-content SLOW (can 2-min timeout, retry once —
  verify via contentHash/sections, item COUNTS lag stale); coord:send
  {to:[..],summary,wake}; coord:wake {to,reason}; work_items:create needs
  kind/title/summary/severity; events:await {event,...}; fleet:launch-on-plan
  {name,plan,harness,model,contextSize} (member-count arg unknown — call twice).
- JSON with apostrophes → scratchpad file + "$(cat file)".
- tsc claims: direct `npx tsc --noEmit -p .` only (--if-present silently no-ops);
  ~333-error pre-existing baseline in operator-core — grep YOUR files.
- Release gate: release:checkpoint-run (quiet-cut judges newest ≥240s-old state
  — check WHICH candidate before trusting a verdict); release:deploy
  {op:trigger,confirm:true} restarts :3070 (warn fleets first).
- Cache staleness (WI-1547 class) is real: verify surprising reads via psql.

## Standing tasks
#13 monitor git-plan lanes to completion (reduces to LIVE-1 endgame above).
#14 watch aviynw2 account usage.
