# SELF-BRIEF — git-plan lead (post-compaction pickup)

> **STALE SNAPSHOT of a live multi-agent system.** Before acting on any fleet /
> claim / liveness statement below, re-run `coord:orient` (via the mcp-call
> fallback — MCP is dropped) and reconcile. A separate agent is actively editing
> the COORDINATION files in parallel; don't assume those are as you left them.

## Identity / session (structured)
- **su-id:** `su-3700bc41-26db-4549-afb7-3dcf8fd072dc` (su-3700b)
- **workspace:** `papercusp-workspace` · **harness:** `papercusp`
- **canonical tree (edit ONLY here):** `/home/marsh-office/papercupai-workspace/papercusp`
  — the `…-staging` sibling is blocked by a worktree guard.
- **MCP `papercusp-su` is DROPPED.** Drive it via:
  `node scripts/mcp-call.mjs <tool> '<json>' --client su-3700bc41-26db-4549-afb7-3dcf8fd072dc`
  (colon tool names; `plans:set-status {slug,itemId,status}`; `plans:edit {slug,old_string,new_string,rationale}` is CAS on the plan markdown; `plans:add-item {slug,phase,items:[{text,importance}]}`).
- **AUTO mode: ON** (D-007). **No fleet created yet** → not leading a live fleet, **no monitor loop armed**. (Leading a fleet later auto-enters AUTO + obliges `loop:arm`.)

## What this project is
ONE plan, `cross-machine-coord-parity-and-trust-2026-07-01` (papercusp harness),
split across two agents:
- **ME (su-3700b) = the GIT plan:** Phase 7 (`G-*`, p2p git transport) + Phase 8
  (`DG-*`, distributed test gate). **I am responsible for driving it to a
  production-ready release.**
- **A separate Opus agent = the COORDINATION remainder:** Phase 9 hardening +
  P-021. Handed off via **D-015** / `docs/plans/HANDOFF-coordination-phase9-2026-07-01.md`.
  It is LIVE and editing `presence-gossip.ts`, `coord-message.ts`, `projections/presence.ts`,
  `authority/lock-authority.ts`, etc. **Those files are SHARED — `coord:send` before touching.**

## Durable docs (read these, don't re-derive)
- `docs/plans/p2p-git-research-2026-07-01.md` — Radicle/Heartwood research → the architecture.
- `docs/plans/FLEET-git-briefs-2026-07-01.md` — the 4 sonnet5 member briefs (shared preamble §0 + lanes A–D). **Launch material.**
- `docs/plans/HANDOFF-coordination-phase9-2026-07-01.md` — what the other agent owns (so I don't collide).
- The plan + decisions **D-009…D-016** (`plans:get`).

## Decisions map
- D-009 p2p-first (skip GitHub transport, owner directive) · D-010 p2p git architecture
  (per-device namespaces + COMPUTED canonical refs + native v2 fetch, NOT bundles/loose-objects)
  · D-011 hole-review fixes + distributed-gate design · D-012 no queen election (P-018)
  · D-013 audit findings · D-014 **honest completion matrix** · D-015 coordination handoff
  · D-016 git fleet plan (4 sonnet5).

## GIT PLAN STATUS
**G-1 storage — DONE + green (I built it this session).** `sync/hive-git/storage.ts`
+ `storage.integration.test.ts` (7 tests, real bare repo). Key seams the rest build on:
- `deviceNamespaceKey(base64→hex)` = THE device→namespace mapping (never re-encode).
- `hiveGitRepoPath(hiveHomeSlug, repoKey)` (one bare repo per (hive, repo)); root =
  `~/.papercusp/hive-git` (env `PAPERCUSP_HIVE_GIT_ROOT`).
- `ensureHiveGitRepo`, `writeNamespaceRef`/`readNamespaceRef`/`deleteNamespaceRef` (CAS on write),
  `listNamespaces`/`listNamespaceRefs`, `RunGit` seam + `defaultRunGit`.
- (Was a PHANTOM-DONE — plan said done, no code existed; reconciled + genuinely done now.)

**LEADER-HELD serial spine (mine, build in order):**
- **G-2 fetch transport (P-026) — NEXT.** `papercusp/hive-git` Protomux channel on the
  EXISTING hive-swarm connections; native git protocol-v2 fetch (spawn `git-upload-pack`
  with `GIT_PROTOCOL=version=2`, or a remote helper with the `connect` capability) piped
  over the duplex stream; multiplexed concurrent fetches. Reuse the `createTopicGossip`
  chassis pattern (`sync/hyperbee/topic-gossip.ts`) for channel wiring.
- G-3 announcements (P-027): `{device, sigrefsOid}` as **P-009 federated events** → fetch trigger.
- G-5 integrator (P-029) + G-5b two-speed gate (P-034) + **G-5d epoch fencing (P-038, hole)**:
  lock-authority-lease holder computes `staging` canonical ref (merge member namespace heads →
  green gate → publish in own namespace, signed `(epoch,seq)`; ff-only accept).
- G-7 worktree bridge (P-031) + G-7b safety (P-036) + **G-7c ff-only never-reset (P-040, hole)**.
- G-8 cold-clone bootstrap (P-032).
- **G-0 sha-token lock handoff (P-033) + G-0b park protocol (P-037)** — **COLLIDES with
  `authority/lock-authority.ts` (the coord agent's P-021). Keep it myself + coordinate.**

**FLEET LANES (members; briefs written; NOT started — waiting on su-cfd1b):**
- A Sigrefs: G-4 (P-028) + G-4b rollback (P-039)
- B Policy/rules: G-6 (P-030) + G-5c integration-requests queue (P-035)
- C Guards/GC: G-10 secrets guard (P-043) + G-9 GC (P-042) + G-1b (P-041)
- D Dist-gate seed: DG-1 verdict facts (P-044) + DG-2 inputsHash/manifest (P-045)
- Later DG: DG-3 scheduling (P-046), DG-4 gate-trust+spot-checks (P-047), DG-5 aggregator (P-048), DG-6 hermeticity (P-049).

## THE BLOCKER + FLEET LAUNCH
**Waiting on `su-cfd1b` to finish token-savings** before launching the fleet (else sonnet5
members hit their cap turn one). On launch: **`fleet:launch-on-plan`** (desktop wrapper, NOT
hand-rolled capability:terminal), **4× sonnet5 @ high**, **default system account** (ANNOUNCE
account + model — disclosure required), worktree-isolated, assign lanes A–D from the briefs,
**`loop:arm` a monitor loop + AUTO** the moment the fleet is created (I lead + review every
merged diff; sonnet5 = weaker = close review).

## OPEN QUESTIONS TO OWNER (unanswered — resolve on pickup)
1. **Account routing** — I'm defaulting the fleet to the **system account**; owner may want
   a pool pin or `auto` gateway routing. (Disclosed, awaiting steer.)
2. **Build G-2 now vs pause all git work until the fleet launches together?** My inclination:
   **keep building G-2** (it's mine regardless + de-risks members' integration points).

## CONVENTIONS / GOTCHAS (hard-won)
- New federated table = the **6-surface recipe** (`agent-insights/retire-or-add-a-federated-table`)
  **+ the `stamp_local_federated_write` BEFORE trigger** in the migration (the M7 trap; the
  `stamp-trigger-coverage.integration.test.ts` guard catches an omission — run it).
- Reserve migs with `db:next-migration`; **strip `BEGIN;/COMMIT;`** when `sql.unsafe()`-applying
  a mig in a test (pooled conn rejects). If `Edit` won't match a line with `—`/`…`/NUL → python heredoc.
- Tests: `cd packages/operator-core`; unit `npx vitest run <path>`; integration (real PG/git)
  `npx vitest run --config vitest.integration.config.ts <path>`.
- **Fail-soft on every network/merge/apply path** (try/catch, never throw on the hot path).
- Reuse: device-signing idiom (`presence-gossip.ts`/`hive-announce.ts`: raw-32 b64 pubkey →
  SPKI rebuild → verify, fixed-field-order signing bytes, freshness window); the **P-009
  federated-event rail** for announcements; `federated-wake-rate.ts` for per-author budgets;
  `topic-gossip.ts createTopicGossip` for a new Protomux channel family.

## COORDINATION PLAN CONTEXT (not mine — awareness only; see D-014 for the matrix)
Phases 0–3 + P-016/17/18/19/20/22/24/25 DONE. Audit (D-013) fixes: **M4/M5a/M7 LANDED by me**;
**M5b/M8/L9 + H1–H3/M6 + LIVE-1 are the other agent's** (Phase 9). **Two standing headlines
(D-014):** (a) the whole parity layer is **UNPROVEN-LIVE** — in-process green ≠ live green;
LIVE-1 (a 2-machine rig) is the feature-done GATE. (b) SU-to-SU parity is **FLAG-DARK**
(`PRESENCE_GOSSIP` writer off → remote agents not addressable in prod yet). The multi-owner
security holes (H1–H3, M6) BLOCK multi-owner enablement; same-owner dogfood unaffected.

## NEXT CONCRETE ACTION (on pickup)
1. `coord:orient` (mcp-call) — reconcile live state; check inbox for owner answers to the 2 open Qs.
2. Check if **su-cfd1b** token-savings shipped (`coord:presence`/ask). If YES → launch the
   4-member fleet (D-016 mechanics + briefs). If NO → continue **G-2** (per my inclination,
   unless the owner answered Q2 otherwise).
3. Whatever git work: SHARED-file discipline (coord:send before `lock-authority.ts`/`coord-message.ts`/`hive-policy-schema.ts`), tests green, `plans:set-status` + `plans:edit` evidence, keep D-014/`## Now` honest.
