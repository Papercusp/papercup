# Gateway live-control + egress (Rayobyte) — parallel briefs (2026-06-20)

8 handoff-able briefs from `.papercusp/scratch/gateway-live-control-and-egress-plan-2026-06-20.md`
(read it first for D-001..D-007 + the phases). Same fleet as the loop+gateway set.
Each is self-contained: goal · files · do · acceptance · deps.

**Waves:** W1 (start now, independent) = B-HOT-1, B-X-1, B-PROV(interface part).
W2 (after B-HOT-1) = B-HOT-2, B-EGRESS, B-ACCT, B-GWCTL. W3 = B-CL + B-PROV(provision wiring).
**⚠ Coordinate gateway.ts edits** (B-HOT-1/2 + B-GWCTL touch it) via locks + append-style — same as the last gateway briefs.
**Reuse-first (D-004):** per-account tools EXTEND the existing `accounts:*` family; don't fork.

---

## B-HOT-1 — Hot-config core (Phase 0) · W1 · FOUNDATIONAL
**Goal:** the gateway re-resolves + ATOMICALLY swaps its runtime config with NO process restart.
**Files:** `inference-gateway/gateway.ts` (boot-resolve path), `account-resolver.ts`
(`resolveAccountPool`), `deployment/account-pool.ts` (version counter on the JSONB pool).
**Do:** promote boot-resolved config (pool + per-account egress + AIMD params +
maxConcurrent/maxQueued + per-account exclude/pause overrides) into a mutable runtime config
object behind an interface; **atomic swap** (readers never see a half-applied pool). Make
`resolveAccountPool` re-runnable at runtime. Add a **config-version counter** to the DB pool;
the gateway polls it (every few s) + re-resolves on bump. Make AIMD floor/threshold/increase +
admission maxConcurrent/maxQueued **runtime-settable** (currently boot constants).
**Acceptance:** a config field changed in the DB pool + version-bumped takes effect on the next
request with no restart; atomic swap holds under concurrent load; unit + integration tests.
**Deps:** none (foundational). ⚠ coordinate gateway.ts with B-HOT-2 / B-GWCTL.

## B-HOT-2 — Admin control surface + dispatcher hygiene · W2
**Goal:** immediate-reload endpoint + config introspection + no socket leak on egress change.
**Files:** `inference-gateway/gateway.ts` (HTTP routing — sibling of /stats /healthz), `bin.ts`.
**Do:** `POST /admin/reload` (localhost-bound + token-authed) → immediate re-resolve.
`GET /admin/config` → current effective runtime config (for tool verify). On a swap that changes
an account's egress, explicitly **close the stale undici dispatcher** (cache keys on
`accountId|proxyUrl|localAddress` so a new one is built — close the old to avoid a socket leak).
**Acceptance:** POST /admin/reload applies a pending DB change instantly; GET /admin/config
matches; repeated egress changes don't leak dispatchers; tests.
**Deps:** B-HOT-1 (runtime config + reload primitive). ⚠ coordinate gateway.ts.

## B-X-1 — Cross-cutting tool harness · W1 · FOUNDATIONAL
**Goal:** the shared dryRun/verify/audit/revert harness every control tool composes (D-005).
**Files:** new `operator-core/lib/gateway-control/` helper module.
**Do:** a reusable harness — dryRun preview, post-apply verify hook, audit-log write
(who/what/prev/ts) to a control-audit store, one-call revert (replays prev value). Define the
audit record shape + the revert contract; **lock + announce the interface early** so B-EGRESS /
B-ACCT / B-GWCTL build against it.
**Acceptance:** a sample mutation previews (dryRun) → applies → audits → reverts cleanly; tests.
**Deps:** none (foundational). Publishes the contract the tool briefs consume.

## B-EGRESS — Per-account egress tools · W2
**Goal:** set/clear/verify an account's egress LIVE + the clean-IP gate.
**Files:** `agent-tools/accounts/` (extend the existing `accounts:*` family — D-004); reuse the
B-GW-3 dispatcher + the ipify-echo rig from your runbook.
**Do:** `accounts:set-egress {id, proxyUrl|localAddress, dryRun?}` — DB write + version-bump/reload
+ verify (extends `accounts:register{egress}`, now hot). `accounts:clear-egress {id}`.
`accounts:test-egress {id}` — throwaway gateway pinned to the account → **ipify echo** (exit IP) +
**IP-reputation lookup** (flagged proxy/hosting?) + **distinct-ASN/subnet check** vs the other
accounts. All composed through B-X-1's harness.
**Acceptance:** set-egress routes the account via the new IP (proven by echo) with no restart;
test-egress returns `{exitIp, reputation, asn, distinctFromOthers}`; tests.
**Deps:** B-HOT-1/2 (live reload), B-X-1 (harness). (Egress lane owner = B-GW-3 + runbook author.)

## B-ACCT — Per-account rotation control · W2
**Goal:** pull/restore an account from rotation live + make pause/resume/rate-reset live.
**Files:** `agent-tools/accounts/` (extend `accounts:*`); the runtime exclude/pause overrides
from B-HOT-1.
**Do:** `accounts:exclude {id}` / `accounts:include {id}` — live add/remove from rotation
(flagged/banned account, or drain). Make the existing `accounts:reset-rate` + pause/resume apply
LIVE (via B-HOT-1's runtime overrides) instead of needing a restart. Through B-X-1's harness.
**Acceptance:** exclude removes the account from routing within one reload (verified — it stops
appearing as the routed-account); include restores it; tests.
**Deps:** B-HOT-1, B-X-1.

## B-GWCTL — Pool-wide gateway control tools · W2
**Goal:** live runtime tuning + a rich status surface.
**Files:** new `agent-tools/gateway/` family; reads /admin/config + writes via the runtime config.
**Do:** `gateway:status` (effective config + per-account state: egress/excluded/paused/utilization
+ AIMD state + queue depth — the control-plane counterpart to /stats). `gateway:reload` (force
re-resolve). `gateway:set-admission {maxConcurrent?, maxQueued?}`. `gateway:set-aimd {floor?,
decreaseThreshold?, increaseEvery?, cap?}` (pin floor≥cap to disable). Mutations via B-X-1.
**Acceptance:** each tunes the LIVE gateway with no restart; gateway:status reflects the change +
matches /admin/config; tests.
**Deps:** B-HOT-1 (runtime-settable params), B-X-1 (harness). ⚠ coordinate the admin-surface read
with B-HOT-2.

## B-PROV — EgressProvider abstraction + Rayobyte + provisioning tools · W1→W3
**Goal:** a swappable provider interface (Rayobyte first) + one-call provision.
**Files:** new `inference-gateway/egress-providers/` module + `agent-tools/egress/`.
**Do:** `EgressProvider` interface — `allocate(accountId)→{proxyUrl|localAddress}`, `release(id)`,
`list()`, `healthcheck(id)→{reachable, exitIp}`. Backends: **RayobyteProvider** (REST:
order/list/IP-whitelist dedicated ISP IPs — D-001), **StaticListProvider** (manual IP list, for
now + tests), stub **BrightDataProvider** (D-001 fallback shape). `egress:provision
{provider, accountId}` → allocate → `accounts:set-egress` → test-egress-verify, in one call.
`egress:list` / `egress:release` / `egress:health`. Append a Rayobyte section to the runbook
(`inference-gateway-per-account-egress-ips.mdx`).
**Acceptance:** against StaticListProvider, provision allocates+registers+verifies end-to-end
(no real IPs needed); RayobyteProvider unit-tested against its REST contract (mock); clean iface.
**Deps:** interface + providers start NOW (W1, independent); `egress:provision` wiring needs
B-EGRESS (W3). Real Rayobyte IPs = the OWNER's parallel task; build on StaticList + mocks.

## B-CL — Gated closed-loop self-correction · W3
**Goal:** tie B-GW-5 wedge/throttle signatures → control actions, behind a default-OFF flag (D-007).
**Files:** new `harness/routines/` entry; reads B-GW-5's `gateway-wedge` detector; calls
B-ACCT / B-GWCTL tools.
**Do:** a routine that, on a sustained wedge/throttle signature for account X, takes a guarded
control action (exclude X / reset X's rate / flag X's egress for re-check) — behind a flag
(**default OFF**), full audit + one-call revert (B-X-1). Agent/human-in-the-loop until enabled.
**Acceptance:** flag off → only logs proposed actions; flag on (test) → acts on a simulated
signature + audits + is revertible; tests.
**Deps:** B-ACCT + B-GWCTL (actuators), B-GW-5 (sensor, already shipped). Last wave.

---

### Proposed routing (the same fleet)
| Brief | Owner | Wave | Why |
|---|---|---|---|
| B-HOT-1 | su-cc236 | W1 | AIMD/gateway-core internals |
| B-X-1 | su-fcbcc | W1 | governor/infra harness |
| B-PROV | su-6b09c | W1→W3 | external-API integration (chaos-harness background) |
| B-HOT-2 | su-840f3 | W2 | gateway HTTP surface (/stats author) |
| B-EGRESS | su-3a9ff | W2 | egress lane owner (B-GW-3 + runbook) |
| B-ACCT | su-15ea2 | W2 | reconcile/state generalist |
| B-GWCTL | su-d5a84 | W2 | loop-engine generalist |
| B-CL | su-fd5c0 | W3 | routine + loop-engine |

(su-1ec26 stays on EI-1873; su-85393 finishing B-LOOP-5 — backup for B-CL.)
