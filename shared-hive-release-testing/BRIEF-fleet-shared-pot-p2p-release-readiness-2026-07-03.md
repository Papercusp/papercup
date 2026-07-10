# Fleet brief — shared-pot P2P → public-release readiness (LOCAL-ONLY)

**Fleet:** `shared-pot-p2p-release` · **Plan:** `shared-pot-p2p-release-readiness-2026-07-03` (harness `papercusp`)
**Leader:** su-17c98026-49d8-4520-a856-6e55f00fcaad · **Date:** 2026-07-03

## Mission

Owner directive: get shared-pot P2P **fully working and ready for PUBLIC release**.
**We no longer have Hetzner access — every proof must run locally** (plan decision D-001).
Your job is VERIFICATION + the fixes it forces: drive every open release criterion to
green-with-evidence on the local rigs, and feed the final GO/NO-GO
(`shared-hive-release-testing/RELEASE-READINESS.md`).

## First move (each member)

1. `coord:orient { intent, planSlug:'shared-pot-p2p-release-readiness-2026-07-03', planItems:[…] }` —
   claim ONE open item as your lane. Priority order: **P-003 (URGENT) → P-001 → P-002 → P-004**,
   then unblocked Phase-3/4/5 items.
2. `plan_items:convert` your item (mints your work-item) before editing anything.
3. Read the plan (`plans:get`, mode sections) — your item text carries the acceptance criteria.

## Ground truth (2026-07-03, verify before trusting — live system)

- **Substrate min-bar MET**: `federation-release-hardening-relaunch-2026-07-01` — 13 briefs done,
  regression matrix 8/8 green on the **containerized 2-node rig** (run `m1783013203`).
- **Alpha gate complete**: `shared-pot-public-release-2026-06-22` — shipped in alpha.2.
- **OPEN blocker (P-003 lane)**: `cross-machine-coord-parity-and-trust-2026-07-01` P-059 —
  tower↔libvirt-VM fed_event replication dead BOTH directions despite healthy network + swarm
  connects. Suspect: scope-cores/corestore replication; likely VM core-key regen on restart.
- **Unrun**: LIVE-2 drill (`p2p-work-distribution-2026-07-02` P-305), P-003 attestation,
  moderation witness (WI-283, `MODERATION_PROBE=1`), 3-node matrix.
- **Missing**: replication-liveness detector (WI-183 class — connected-but-dead replication is
  silent today).
- **Stale**: `RELEASE-READINESS.md` (06-20/30) — P-001 rewrites it into the GO/NO-GO ledger.

## Rig inventory (all local)

| Rig | What | Where |
|---|---|---|
| Containerized 2-node | matrix runner; frames = local sshd containers | `papercusp-desktop/bin/deb-hetzner-matrix.sh` + `bin/lib/deb-hetzner-rig.sh` with `RIG_FRAME_IPS` pre-provisioned hosts; scenarios in `bin/lib/scenarios/` |
| Tower↔libvirt VM | true kernel/network boundary (P-059 drill) | macbr0; VM driver `/tmp/vmcall.sh` (port auto-discovery); probes `/tmp/p059-e1c.sh`, `/tmp/p059-rev2.sh` — P-002 moves these into the repo |
| Single-box 2-instance | fast smokes | `papercusp-desktop/bin/two-instance-*-smoke.sh`, `live-federation-gate.sh` |
| Mac VM | cross-platform + dogfood (papercusp pot) | **owned by su-a1a71** — coordinate, don't duplicate (P-012) |

Drive the tower operator federated:
`PAPERCUSP_HONO_PORT=3070 node scripts/mcp-call.mjs <ns:verb> '<json>' --harness papercusp --workspace papercusp-workspace`
(`--harness papercusp` REQUIRED else `ambiguous_hive_scope`).

## Coordination boundaries (do NOT collide)

- **su-16e4c274** owns the ACTIVE P-108 scope-federation lane: `lib/**/scope-*.ts`,
  `scope-federation.ts`. The P-003 lane COORDINATES with them (`coord:send`, wake if needed) —
  verify-after or joint-debug; no unilateral edits to those files while their lane is live.
- **p2p-pot-git fleet** (leader su-35c3b; members su-80b66, su-754bf, su-c2428, su-d1985) is
  finishing work-distribution build items (P-301/P-303/P-201). The LIVE-2 drill (our P-007)
  VERIFIES their build — file findings to them, fix jointly.
- **su-a1a71** owns the mac-VM dogfood lane (also fixing mac blank-page bugs).
- File-locks are enforced by hook; when blocked, pivot or queue — never route around.

## Rules

- **Local only. Never provision cloud VMs.** Hetzner creds are gone; the `deb-hetzner-*`
  cloud paths are retired (keep the code, use `RIG_FRAME_IPS`/local modes).
- Canonical tree ONLY (`~/papercupai-workspace/papercup`); no manual git add/commit/push.
- Evidence-first: a criterion is green only with a pointed-at artifact (matrix line, log,
  PG row, CI test). *In-process green ≠ live green* — this program exists because of that rule.
- Every bug found: `work_items:create` (bug) with repro + evidence; fix root cause where it's
  yours; hand off loudly (verify `woken≥1`) where it isn't.
- Tests ship with fixes, in the project's framework; pin every closed bug class with a
  regression scenario (matrix scenario or hermetic test).
- Progress: `plans:set-status` + heartbeats; substantive state changes → `plans:set-now`
  (leader also sweeps). Findings that change the release verdict → update the P-001 ledger row.
- Blocked >30min on another lane: `coord:send` the owner directly (wake:'required'), don't idle.

## Definition of done (fleet)

P-014 GO/NO-GO written: every readiness row green-with-evidence or explicitly owner-waived,
standing local gate (P-013) armed and green, and the owner can read the verdict in 2 minutes.
