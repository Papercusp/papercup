# BUILD STATUS — P-105 foreign-work isolation sandbox (2026-07-09)

Plan: `p2p-parity-parallel-lanes-2026-07-09` · Item: P-004 · Author: su-95401
(fleet `p2p-parity-lanes`) · Spec: `DESIGN-p2p-P105-foreign-work-isolation-sandbox-spec-2026-07-02`

This doc records what P-004 actually built against the RATIFIED P-105 spec,
so the eventual WI-1937 spawn-leg build lane (owner-sign-off-gated) starts
from working, tested primitives instead of re-deriving them.

## What this item built

New module: `packages/operator-core/lib/p2p/sandbox/` — one file per axis,
each split into (a) PURE decision/config-generation logic (unit-tested, no
root/Linux dependency) and (b) the REAL privileged mechanism (used only by
the drill; **not wired into any production spawn path** — see Scope below).

| Axis | Module | Pure logic | Real mechanism |
|---|---|---|---|
| §3.1 gateway attribution | `gateway-attribution.ts` | credential issuance + admission decision | — (no live gateway wiring; see Scope) |
| §3.2 PG credential isolation | `pg-credential-isolation.ts` | admin-PG-env scan + strip | — (v1 = no-PG-access posture, no replacement credential to wire) |
| §3.3 loopback port-filter | `network-egress.ts` | egress allow/deny decision + nft ruleset render | `applyNetnsPortFilter` (real `ip netns` + `nft`) |
| §4 credential isolation | `os-user-isolation.ts` | credential-path readability check | `provisionIsolationPrincipal` (real `useradd`/`unshare`) |
| §2 compute limits | `cgroup-limits.ts` | limit spec + cgroup v2 file render + over-limit decision | `applyCgroupLimits` (real cgroup v2 controller-file write) |
| §1 quota (remainder) | `quota-volume.ts` | recursive disk-usage walk + quota decision | — (walk itself IS the real mechanism; no privilege needed) |
| §5 enforcement | `enforcement-kill.ts` | grace-expiry kill decision | `killForeignSessionProcess` (real SIGKILL / cgroup-freeze-kill) |

**Tests:** 58 unit tests across 7 files, all green
(`npx vitest run --config apps/operator/vitest.config.ts packages/operator-core/lib/p2p/sandbox/`).
Zero new `tsc` errors (`packages/operator-core`: 212 pre-existing, unrelated).

**Drill:** `packages/operator-core/lib/p2p/sandbox/drill.ts`
(`npx tsx packages/operator-core/lib/p2p/sandbox/drill.ts`) — exercises every
axis for real (real temp files, a real spawned+SIGKILLed process, a real disk
walk over a real over-quota directory); OS-privileged legs (netns/nft,
useradd, cgroup v2 write) SKIP-with-reason on a non-root/non-Linux box rather
than silently passing — SKIP-census convention matches
`papercusp-desktop/bin/work-distribution-drill.sh`. Run on this dev box
(unprivileged, non-root): **7 PASS / 3 SKIP (root+Linux required) / 0 FAIL.**
Re-run as root on Linux with cgroup v2 delegated to flip the 3 SKIPs to PASS
with zero re-authoring — the drill's job is exactly that (per the sibling
drill's own convention: "the SKIP census IS the release evidence… as the
owning lanes wire each leg, its SKIP flips to a live assert").

## Scope boundary (deliberately not done here)

Per the P-004 plan-item text: **"Scope STOPS before wiring the WI-1937 spawn
leg — the owner sign-off (fact `wi-1937-spawn-leg-owner-signoff`) is
CONTINGENT on the sandbox existing with its isolation axes VERIFIED by tests
+ drill first; the spawn-leg wiring happens after and is NOT this item."**

Concretely, NONE of the following were touched or modified by this item:
- `packages/operator-core/lib/inference-gateway/gateway.ts` (no attribution wiring)
- `packages/operator-core/lib/p2p/foreign-clone.ts` (no quota-enforcement call added to `provisionForeignClone`)
- `packages/operator-core/lib/p2p/foreign-supervision.ts` (no enforced-kill call added to the wind-down sweep)
- Any spawn/offer-executor path (P-104's lifecycle, `foreign-supervision.ts`) — unmodified

The new `sandbox/` module is entirely additive and dormant: it exists,
compiles, and is tested, but nothing in the live system calls it yet. This
keeps the live fleet's gateway/PG/operator access completely unaffected —
per the ratified spec's own warning, "a wrong netns/credential change here
doesn't fail one work-item — it can sever gateway/PG access for every
concurrent agent on the shared dev box."

## Recommended next build lane (unchanged from the ratified spec, §7)

Sequence once WI-1937 clears owner sign-off: §3 (loopback boundary — wire
`decideGatewayAdmission` into the gateway's admission chokepoint; wire
`buildForeignProcessEnv` into the foreign-session spawn env; wire
`applyNetnsPortFilter` into session provisioning) → §4 (credential isolation,
naturally combined with §3's netns work — wire `provisionIsolationPrincipal`)
→ §2 (cgroups — wire `applyCgroupLimits` at spawn, poll `decideOverLimit` from
a periodic sweep) → §1 (wire `enforceForeignWorkspaceQuota` into
`provisionForeignClone` post-clone, and into a periodic sweep) → §5
(enforcement — wire `decideEnforcedKill` + `killForeignSessionProcess` into
`foreign-supervision.ts`'s wind-down sweep, now that §2 exists to supply a
real `cgroupPath`).

Poison-screening stays explicitly out of scope for v1 (per the ratified
spec's §6) — this is blast-radius CONTROL, not content detection.
