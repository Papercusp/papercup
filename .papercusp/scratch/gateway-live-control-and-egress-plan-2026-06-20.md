# Gateway live-control + per-account egress (Rayobyte) — plan (2026-06-20)

## Why
The overnight gateway incident exposed two coupled gaps:

1. **No per-account egress capacity.** All 8 Claude Max accounts share ONE egress IP, so
   Anthropic's per-IP opus throttle caps the *whole pool* — live evidence: all 8 accounts
   paused/penalized simultaneously during the incident. B-GW-3 already wired the per-account
   undici dispatcher end-to-end; the IPs were just never provisioned.
2. **No live control.** The gateway resolves its entire config once at boot and holds it for
   its lifetime. Every adjustment — exclude a flagged account, change an egress, retune
   AIMD/admission — needs a code edit + a restart. Tonight a human (me) had to restart the
   gateway by hand just to deploy AIMD. Agents cannot self-correct the gateway.

This plan closes both: make the gateway **hot-reconfigurable** (the linchpin), expose
**agent-callable control tools** over it (the "definetool" interfaces), **provision
per-account egress IPs via Rayobyte**, and **wrap the egress provider behind a swappable
interface** — so the gateway becomes self-correcting and capacity scales per-account.

Builds directly on this session's shipped work: B-GW-1 (AIMD), B-GW-3 (egress dispatcher),
B-GW-5 (wedge/throttle observability). This is the *actuator* half of B-GW-5's *sensor* half.

## Decisions (locked)
- **D-001 — Egress provider = Rayobyte.** Static-residential/ISP, dedicated IPs, **unlimited
  bandwidth**, **diverse ASN**, IP-whitelist auth, REST API + scale-up. Best fit for "8 stable
  dedicated IPs, programmatically managed, no bandwidth ceiling." (Bright Data is the fallback
  if Rayobyte pool reputation underperforms in verify — see B-PROV-1's provider abstraction.)
- **D-002 — DB pool stays the single source of truth.** `harness_shared.operator_account_pool`
  (single-row JSONB) remains canonical; every tool writes there (durable, restart-safe). The
  live gateway is a *mirror* that re-resolves from the DB. One source of truth → no drift
  between "running config" and "what a restart would resolve."
- **D-003 — Reload = poll + trigger (belt-and-suspenders).** Gateway polls a config-version
  counter every few seconds AND exposes a localhost-only authed `POST /admin/reload` for
  immediate apply. A missed trigger falls back to the poll.
- **D-004 — Tools split by SCOPE, not feature.** Per-account facets (egress, exclude, pause,
  rate-reset) EXTEND the existing `accounts:*` family (reuse-first — don't fork; mirrors the
  agents-reuse-first-default principle). Pool-wide/runtime facets (admission, AIMD, status,
  reload) are a new `gateway:*` family.
- **D-005 — Every mutating tool: dryRun + post-apply verify + audit + one-call revert +
  persist-and-apply atomically.** Non-negotiable — the whole point is *unsupervised* agent
  self-correction, which needs preview, proof, and undo.
- **D-006 — HTTP CONNECT egress now; native SOCKS later (WI-284).** Rayobyte HTTP/HTTPS proxy
  endpoints + IP whitelist (no user:pass on the wire).
- **D-007 — Closed-loop auto-correction is gated + default-OFF.** Phase 3's "react to a wedge
  signature automatically" ships behind a flag, off until trust is built; until then control
  is agent/human-in-the-loop.

## Phase 0 — Hot config core (the linchpin) [FOUNDATIONAL — nothing else works without it]
Make the gateway re-resolve + **atomically swap** its runtime config with no process restart.
- Promote boot-resolved config (account pool + per-account egress + AIMD floor/thresholds +
  maxConcurrent/maxQueued + per-account exclude/pause overrides) into a mutable runtime config
  object behind an interface; atomic swap so readers never see a half-applied pool.
- `resolveAccountPool` becomes re-runnable at runtime; add a config-version counter to the DB
  pool; gateway polls it (cheap) + re-resolves on bump.
- `POST /admin/reload` (localhost-bound, token-authed, sibling of /stats) → immediate
  re-resolve. `GET /admin/config` → current effective runtime config (for verify).
- The per-account undici dispatcher cache already keys on `accountId|proxyUrl|localAddress`, so
  an egress change rebuilds the dispatcher naturally — add explicit **close of the stale
  dispatcher** on swap (avoid socket leak).
- Make AIMD floor/threshold/increase + admission maxConcurrent/maxQueued **runtime-settable**
  (currently boot constants).
- **Acceptance:** changing any config field via DB+reload takes effect on the next request with
  zero restart; /admin/config reflects it; atomic swap holds under concurrent load; egress
  change rebuilds + closes the old dispatcher.

## Phase 1 — Per-account control tools (`accounts:*`, highest immediate payoff)
- `accounts:set-egress {id, proxyUrl|localAddress, dryRun?}` — set egress LIVE (extends
  accounts:register{egress}, now hot). Writes DB → reload → verify.
- `accounts:clear-egress {id}` — revert to default egress.
- `accounts:test-egress {id}` — spin the throwaway gateway pinned to the account → **ipify
  echo** → return the actual exit IP, PLUS an **IP-reputation lookup** (flagged proxy/hosting?)
  + a **distinct-ASN/subnet check** vs the other accounts. The "is this IP clean + distinct
  before I pin it" gate (more important than the brand — see Why/egress).
- `accounts:exclude {id}` / `accounts:include {id}` — pull/restore an account from rotation
  LIVE (flagged/banned account, or drain before maintenance).
- pause/resume + rate-reset already exist (`accounts:reset-rate`, `set-session-override`) —
  make them apply LIVE via Phase 0.
- **Acceptance:** set-egress on a live gateway routes that account via the new IP (proven by
  echo) with no restart; exclude removes it from routing within one reload; test-egress returns
  IP + reputation + ASN.

## Phase 2 — Pool-wide control tools (`gateway:*`)
- `gateway:status` — rich live view (effective config, per-account state:
  egress/excluded/paused/utilization, AIMD state, queue depth). The control-plane counterpart
  to /stats.
- `gateway:set-admission {maxConcurrent?, maxQueued?}` — live admission sizing.
- `gateway:set-aimd {floor?, decreaseThreshold?, increaseEvery?, cap?}` — live AIMD tuning
  (pin floor≥cap to effectively disable).
- `gateway:reload` — force re-resolve.
- **Acceptance:** each tunes the live gateway with no restart; gateway:status reflects it and
  matches /admin/config.

## Phase 3 — EgressProvider abstraction + provisioning + (gated) closed loop
- **`EgressProvider` interface** (pluggable): `allocate(accountId) → {proxyUrl|localAddress}`,
  `release(id)`, `list()`, `healthcheck(id) → {reachable, exitIp}`. Backends:
  `RayobyteProvider` (REST: order/list/whitelist dedicated ISP IPs), `StaticListProvider`
  (manual IP list), future `BrightDataProvider` (the D-001 fallback path).
- `egress:provision {provider, accountId}` — allocate an IP from the provider → auto-register
  via accounts:set-egress → test-egress-verify, in one call. `egress:list` / `egress:release`
  / `egress:health`.
- **Rayobyte specifics:** REST API to order/list dedicated ISP IPs; IP-whitelist the gateway's
  outbound IP (so no proxy user:pass on the wire, D-006); confirm distinct ASN/subnet across
  the 8; confirm the unlimited-bandwidth plan.
- **Closed loop (gated, D-007):** an optional routine mapping B-GW-5 wedge/throttle signatures
  → a control action (exclude the throttled account / reset its rate / re-check its egress),
  behind a default-off flag, with audit + revert. This is what makes the gateway
  self-correcting without a human in the chair — the lesson of tonight's manual restart.
- **Acceptance:** egress:provision allocates + registers + verifies an IP end-to-end against
  Rayobyte; the 8 accounts each egress from a distinct, clean IP (proven by per-account echo).

## Cross-cutting (every mutating tool — D-005)
dryRun preview · post-apply verify (echo / route-check) · audit log (who/what/prev/ts) ·
one-call revert · write-DB-and-apply-live atomically (no drift). Build this as a shared harness
the tools compose, not per-tool.

## Build sequence & deps
- **Phase 0 first** — the linchpin; nothing else functions without hot config.
- **Phase 1 next** — highest payoff: plug the egress IPs in live + pull a flagged account
  instantly.
- **Phase 2** — parallelizable with late Phase 1.
- **Phase 3** — after 1+2 (needs set-egress + test-egress).
- **Owner-task (parallel, OWNER-gated):** set up the Rayobyte account + order 8 dedicated ISP
  IPs + IP-whitelist the box's outbound; Phase 1's test-egress verifies them before pinning.

## Open decisions for owner
- **Closed-loop aggressiveness (Phase 3):** how far does auto-correction act on its own?
  (Default: off, agent-in-the-loop.)
- **Admin endpoint auth:** localhost-bind + a shared token is assumed sufficient (same box) —
  confirm you don't want it reachable off-box.

## Brief decomposition (handoff-able — expand to full goal/files/acceptance/deps on request)
- **B-HOT-1** — Phase 0 hot-config core: runtime config object + atomic swap + re-resolvable
  pool + version counter. FOUNDATIONAL.
- **B-HOT-2** — `/admin/reload` + `/admin/config` (localhost+token) + poll loop +
  dispatcher-close-on-swap. (deps: B-HOT-1)
- **B-TOOL-1** — `accounts:set-egress` / `clear-egress` (live). (deps: B-HOT-1/2)
- **B-TOOL-2** — `accounts:test-egress` (echo + reputation + distinct-ASN).
- **B-TOOL-3** — `accounts:exclude` / `include` (live rotation pull). (deps: B-HOT-1/2)
- **B-TOOL-4** — `gateway:status` + `gateway:reload`. (deps: B-HOT-1/2)
- **B-TOOL-5** — `gateway:set-admission` + `gateway:set-aimd` (live tuning). (deps: B-HOT-1)
- **B-PROV-1** — `EgressProvider` interface + `StaticListProvider` + `RayobyteProvider` (REST).
- **B-PROV-2** — `egress:provision/list/release/health` + Rayobyte runbook addendum to
  `inference-gateway-per-account-egress-ips.mdx`. (deps: B-TOOL-1/2, B-PROV-1)
- **B-CL-1** — (gated) closed-loop routine tying B-GW-5 signatures → control actions
  (flag default-off). (deps: B-TOOL-3/5)
- **B-X-1** — shared cross-cutting harness (dryRun / verify / audit / revert) used by all tools.
  FOUNDATIONAL alongside B-HOT-1.

## Wave plan
- **Wave 1 (start immediately):** B-HOT-1, B-X-1 (the two foundations) + the Rayobyte
  owner-task.
- **Wave 2 (after B-HOT-1):** B-HOT-2, B-TOOL-1/2/3/4/5.
- **Wave 3 (after tools):** B-PROV-1/2, then B-CL-1.
