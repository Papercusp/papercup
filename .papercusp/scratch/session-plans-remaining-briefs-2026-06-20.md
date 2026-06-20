# Other session plans — REMAINING work + parallel SU briefs (2026-06-20)

Companion to `code-execution-remaining-briefs-2026-06-20.md`. Covers the OTHER plans created/managed
this session that didn't reach completion. **Handoff GATED on the owner's greenlight** (do not
dispatch yet). After greenlight I hand off via coord, arm a 2-min monitoring loop, and wake the fleet.

**VERIFY-FIRST:** the fleet has been quiet ~1h (loops off) and git-sync appears to have just recovered
(last commit ~5m ago; P-005 swept). Several of these were handed off earlier and may be partly/fully
done. **Each brief's first step is: confirm current state (coord + code + plans) and complete only the
open residue** — do not redo landed work. Full context for each lives in the original brief docs cited.

**Cross-cutting gate:** the **deploy-freeze** (live :3070 operator runs frozen old code) still blocks
the "deploy + live-verify" tails. **B-DEPLOY-FIX (brief 9) is the keystone** — it unblocks 7 & 8.

---

## GROUP A — Gateway live-control + Rayobyte egress
*(source: `gateway-live-control-and-egress-plan-2026-06-20.md` + `gateway-live-control-briefs-2026-06-20.md`; D-001 Rayobyte, D-002 DB-pool source-of-truth, D-003 poll+/admin/reload, D-004 accounts:* vs gateway: split, D-005 dryRun/verify/audit/revert, D-007 closed-loop default-off)*

### B-GW-HOT — hot-config core + `gateway:*` control tools  [HIGH]
Verify-then-complete B-HOT-1/B-HOT-2/B-GWCTL: the gateway reads its live config from the **DB pool as
source of truth**, hot-reloads via **poll + `/admin/reload`** (no restart), and exposes the
`gateway:*` definetool control surface (status/reload/dryRun/verify/audit/revert per D-005).
**Done:** a config change applies live (no restart) + a `gateway:*` tool round-trips, full
inference-gateway suite green.

### B-GW-EGRESS — Rayobyte egress dispatchers + ACTIVATION  [HIGH]
B-EGRESS: per-account egress dispatchers (undici `ProxyAgent`) wired to the **8 registered Rayobyte
IPs** (already registered via `accounts:register` w/ `egress.proxyUrl`; box outbound `38.229.109.7`
whitelisted). **ACTIVATE** (gateway hot-reload via B-GW-HOT, or restart) and **verify each account
exits its own dedicated IP** (per-IP throttle → per-account). **Done:** all 8 accounts egress through
their mapped proxy IP, confirmed live; falls back cleanly if a proxy is down.

### B-GW-ACCT — `accounts:*` control split + provider surface  [MED]
B-ACCT/B-PROV: finish the `accounts:*` (register/status/remove/reset-rate/session-override) surface
split from `gateway:*` (D-004) + the provider abstraction. **Done:** the accounts control surface is
coherent + tested; `accounts:status` reflects egress mapping.

---

## GROUP B — Token tracking (the owner's usage-crisis plan)
*(source: `token-tracking-plan-and-briefs-2026-06-20.md`; key bug: `load-spend.ts` sums input+output ONLY → excludes cache_read/cache_creation → ~5× UNDERCOUNT)*

### B-TOK-FIX — cache-undercount fix + attribution + migration  [HIGH — the user's core concern]
B-TOK-2: fix `load-spend.ts` to include `cache_read` + `cache_creation` tokens (the ~5× undercount);
land per-role/run/model/harness attribution on `agent_usage_samples`; confirm migration 330 (was
stranded — verify committed at `385…`/`904…` or re-land). **Done:** spend numbers include cache and
reconcile against the raw account usage; attribution columns populated + queryable.

### B-TOK-UI — Insights → Overview + Tokens subtabs  [MED]
B-TOK-1: split the Insights tab into an **Overview** subtab (current content) + a new **Tokens**
subtab (nuqs `?insightView=overview|tokens`, pattern from `LearningTab.tsx`'s `?lview`). Tokens
dashboard surfaces spend by model/role/account/time from the corrected query (`load-tokens.ts`).
Files: `apps/operator/app/harness/insights/InsightsTab.tsx`. **Done:** both subtabs render; Tokens
shows live, cache-inclusive spend.

### B-TOK-ROLL — rollups + pricing + coordination-token attribution  [MED]
B-TOK-3/B-TOK-4: pricing table (per-model $/token incl. cache rates) + time rollups; **coordination
token attribution** — crack the 327K/24h `coord:wake-queue` mystery (cheap polling vs expensive
context-injection) and attribute coord-system token cost by kind. **Done:** $ cost per
model/role/coord-kind is queryable; the coord-poll cost is quantified.

---

## GROUP C — Queen/bee operational + loop finish + the systemic blocker
*(source: `queenbee-operational-and-loop-finish-briefs-2026-06-20.md`. Already DONE: B-QB-2 survey, B-LOOP-FIN-1 prompt-sweep, B-LOOP-FIN-3 tasks 1-2 — do NOT redo.)*

### B-QB-DEPLOY — EI-1758 bee fire-path deploy + bee-fire verification  [HIGH · deploy-gated]
B-QB-1 (keystone): deploy su-53b3f's EI-1758 launch-mechanics fix (built green, NOT deployed — bees
boot but make 0 tool calls). Then run the spawn protocol: a fresh bee on a seeded item → assert
boots-clean / real tool calls in `activity:recent` / claims+completes. **Done:** a bee demonstrably
executes a work item end-to-end, fleet-wide. **Gated on B-DEPLOY-FIX.**

### B-LOOP-FIN — loop e2e + wakeup-template + deploy-verify  [MED · partly deploy-gated]
B-LOOP-FIN-2 + FIN-3-task3: prove a warm session loops end-to-end (`arm` → engine fire → warm
coord-wake → next turn N sec after the prior settles); finalize the wakeup-prompt template;
post-deploy verify the loop engine + `arm`/`end`/`status` verbs go live. **Done:** one demonstrated
end-to-end warm loop + verbs live post-deploy.

### B-DEPLOY-FIX — durable deploy-freeze / git-sync ENOENT root fix + deploy  [HIGH · keystone]
su-0ad97 diagnosed the ~10h freeze: a `spawn('node') ENOENT` in the invoke path
(`harness-invoke-once.ts:264`, `command:'node'`) wedges git-sync/deploys; **restart is insufficient
(proven) — it needs the root fix** (`command: process.execPath`, watching the packaged-desktop
electron edge; the codebase already does this in `plugin-spawn-impl.ts`). Apply + verify the fix so
git-sync/deploys don't re-wedge, then **execute the deploy** so the live :3070 operator runs current
code. **Done:** spawn no longer ENOENTs; git-sync stable; the deploy lands → unblocks B-QB-DEPLOY +
B-LOOP-FIN. (If git-sync has already self-recovered, the brief still lands the *durable root fix* so
it doesn't recur, + drives the actual deploy.)

---

## Parallelism / sequencing (for the waker)
- **Keystone first:** B-DEPLOY-FIX (9) unblocks the deploy-gated tails (B-QB-DEPLOY, B-LOOP-FIN).
- **Run-now-parallel (no deploy dep):** B-GW-HOT, B-GW-EGRESS (+activation), B-GW-ACCT, B-TOK-FIX,
  B-TOK-UI, B-TOK-ROLL — all buildable/verifiable locally now that git-sync looks recovered.
- **Shared-file caution:** GROUP A all touch the inference-gateway + `accounts/*` — serialize via
  coord locks. GROUP B touches `insights/*` + the spend queries.
- **Owners TBD** — assign live at handoff; verify-first per brief (don't redo landed work).
- Total across both docs: **17 briefs** (8 code-execution + 9 here). The owner may trim/prioritize.
