# DESIGN — P-105 foreign-work isolation: the sandbox spec

Plan: `p2p-work-distribution-2026-07-02` · Item: P-105 · Author: su-29cd4 (fleet
`backlog-clearance`) · 2026-07-03
Status: **SPEC RATIFIED (via D-015: independent 5th-round audit X1-X15 ALL
ACCEPTED) — BUILD NOT STARTED.** This doc formalizes the already-accepted
design into one reference so a future build lane doesn't have to reconstruct
it from the plan-item prose. It authorizes no code changes.

## 0. Why this is a doc, not a build, right now

P-105 bundles five axes of OS-level, security-critical isolation (git object
store, compute cgroups, network egress, the local loopback boundary, and
on-disk credential isolation) that reach into infrastructure the **entire
fleet** depends on every second: the inference gateway (`:8788`, pooled
account credentials), Postgres (`:5432`), and the operator API
(`:3070`/`:3170`). A wrong netns/credential change here doesn't fail one
work-item — it can sever gateway/PG access for every concurrent agent on the
shared dev box. That is exactly the shape of work P-109 (`DESIGN-p2p-P109-…`)
went through: **design doc landed → leader ratification → a dedicated,
tracked build lane (lane D, su-4d6de → su-16e4c274) spanning multiple
claim/reclaim cycles before all four legs landed.** P-105 has cleared the
first of those steps (D-015 already ratifies the design) but has never been
assigned a build lane. Attempting the OS-level build ad hoc, inside a single
backlog-clearance turn, would repeat the exact mistake the X4 finding in this
same audit called out (a worktree-based shortcut that looked reversible but
silently poisoned the shared, federated ODB) — the isolation problem is
precisely "looks safe, isn't." This doc's job is to leave the ratified spec in
one place so that lane, when assigned, starts from decisions, not prose.

Sibling boundaries (already established in the P-109 doc, restated here for a
single reader): **P-105 owns the OS-level sandbox** (quota volume, cgroups,
netns, OS user); P-108 owns the foreign-ref visibility decision; P-104 owns
spawn/session lifecycle (**status: DONE** — `offer-executor.ts` H9
fence→D-007 gate→provision→C2 envelope→launch seam→bind→H11 ledgers); P-109
owns the git plumbing built ON TOP of P-105's clone/ODB decision (**status:
DONE**, all four legs landed). P-105 itself has never had a build lane opened.

## 1. GIT axis (X4) — full clone, private ODB, quota volume

**Decision (ratified, and independently re-confirmed live by P-109's build):
foreign workspaces get a FULL CLONE with their own object database on a quota
volume — never a `git worktree`.**

Why: a worktree shares the ODB via `commondir` — a quota on the checkout
alone is void, and a foreign `git add` of a huge/malicious blob lands directly
in the shared, federated ODB (verified independently by the P-105 auditor,
and re-verified by P-109's implementer, who picked `git clone --no-local` for
exactly this reason — see `DESIGN-p2p-P109-…md` §1). An isolated
`GIT_OBJECT_DIRECTORY` env var was also rejected: env-based isolation
evaporates the moment any git invocation drops the env (hooks, sub-tools, a
bare `git` call from inside a hostile foreign shell) and falls back silently
to the enclosing ODB — not isolation.

**Status: this leg is ALREADY BUILT**, as part of P-109 leg (iv)
(`lib/p2p/foreign-clone.ts`, migration 467 `p2p_foreign_workspaces`, private-
ODB verify, 7/7 integration tests green). What remains under P-105
specifically is the **quota enforcement** on that volume (disk-space cap per
foreign workspace, independent of P-109's clone mechanics) — not yet built.
Results leave the clone via P-109's mirror lane by PUSH, with a size/blob-cap
enforced at the results-channel admission (P-108); the foreign session itself
needs zero git network access, which is X1-friendly (see §3).

## 2. COMPUTE axis (C10) — cgroups/ulimits

**Decision: cgroups/ulimits enforce CPU/RAM/disk/bandwidth caps mechanically
on every foreign session — never an allotment-ledger check alone.** Allotments
(inference-token accounting) are inference-myopic: a zero-token build/compile
job (e.g. a `cargo build` or a runaway test loop) can saturate CPU/RAM/disk on
the shared box without ever touching the token ledger the allotment system
tracks. Mechanical enforcement via the kernel (cgroup v2 `cpu.max`,
`memory.max`, `io.max`, plus a `RLIMIT_*` ulimit floor as defense-in-depth) is
the only backstop that doesn't depend on the workload being honest about what
it's doing.

**Status: NOT built.** No cgroup wiring exists for foreign sessions today.

## 3. NETWORK axis (C11 + X1 loopback boundary) — the v1-blocking leg

**Decision: per-fleet egress allowlist + logging (C11) — explicitly NOT an
origin-proxying design** (the host's IP is the host's liability; proxying
foreign egress through the host would make every foreign session's network
traffic indistinguishable from the host's own, defeating attribution).

**Decision (X1, v1-blocking for tier 2): the local loopback boundary is the
hard gate.** Today the inference gateway (`:8788`, pooled account
credentials), Postgres (`:5432`), and the operator API (`:3070`/`:3170`) are
all reachable from ANY shell on the box, foreign or not — meaning a foreign
session bypasses every economic control (allotments, per-fleet spend caps)
simply by calling the gateway directly over loopback. Required, in order:
1. **Per-foreign-session gateway credentials**, with the gateway refusing any
   unattributed loopback call. The storm-circuit client-identification work
   already in the gateway (rate-governor per-account tracking) is the
   starting point — it needs a foreign-session identity added to its
   attribution key, not a new mechanism.
2. **PG credential isolation** — foreign sessions must never inherit
   `DATABASE_URL` / resolve via `getHarnessAdminUrl()`; they need their own,
   scoped credential (or no PG access at all, forcing all state through the
   coord plane per P-104's C2 capability envelope, which already denies
   foreign sessions settings/grants mutation and secrets tools).
3. **Port-filter or netns** for the sandbox tier — the actual mechanism that
   makes (1) and (2) non-bypassable rather than advisory.

**Until this leg exists, tier 1 (P-005, same-owner) is the ONLY safe tier** —
this is the load-bearing constraint on the whole P-105 spec: nothing in tier
2/3 (cross-owner foreign work) should be enabled before X1 ships, no matter
how complete the other axes look.

**Status: NOT built.** This is almost certainly the largest single leg and
should be the first slice a future build lane takes, since every other tier-2
protection is void without it.

## 4. CREDENTIAL axis (D-015 leader strengthening) — on-disk isolation

**Decision: a dedicated OS user or user namespace (userns) for the sandbox
tier — port rules on their own are insufficient.** A foreign session running
as the same host OS user that runs the rest of the fleet can read
`~/.papercusp/superuser-token`, `embedded-pg.json`, and gateway key material
directly off disk, regardless of how tightly the network is filtered — the
network boundary in §3 protects the wire, not the filesystem. This decision
was added by the leader during D-015's audit-of-audit pass specifically
because the original X1 finding covered only the network leg and left this
gap open.

**Status: NOT built.** No dedicated OS user / userns scaffolding exists.
Sequencing note: this leg and the netns/port-filter mechanism in §3.3 are
naturally built together (both want the foreign session to run under a
distinct security principal), so a build lane should likely scope them as one
slice rather than two.

## 5. Enforcement lifecycle (X13) — kill after wind-down grace

**Decision: enforced kill after the wind-down grace period**, not a soft
signal alone. P-104's `foreign-supervision.ts` already implements H12/H13
orphan sweep (origin unreachable for T → park/wind-down foreign sessions +
receipt on reconnect) and an X8 wind-down primitive — X13 is the hard
follow-through: a foreign session that doesn't wind down cleanly inside its
grace window gets mechanically killed (cgroup freeze+kill, not just a coord
message), closing the gap where a wedged foreign session could sit consuming
resources indefinitely after its origin walks away.

**Status: PARTIALLY built** — the grace-period detection (H12/H13) landed
under P-104; the enforced-kill follow-through specific to X13 has not been
independently verified as wired to §2's cgroup mechanism (which doesn't exist
yet), so it cannot be fully built until §2 lands.

## 6. Explicitly out of scope for v1 (per the ratified spec)

**Poison-SCREENING stays post-v1.** P-105 is blast-radius CONTROL (contain
what a foreign session can reach/damage), not detection (inspecting what a
foreign session produces for malicious content). Do not fold poison-screening
into a P-105 build slice; it is a distinct, later initiative.

## 7. Recommendation for the next build lane

None of the five axes above are built except the git leg (already delivered
incidentally by P-109). This is a multi-week, security-critical
infrastructure project touching the shared dev box every concurrent agent
depends on — the same shape of work P-109 required a dedicated, persistently-
claimed lane for. Recommend the plan leader open a named build lane (mirroring
P-109's `lane D`) rather than routing this through backlog-clearance
priority churn, and sequence it §3 (loopback boundary) → §4 (credential
isolation, likely combined with §3's netns work) → §2 (cgroups) → §1 (quota
enforcement, git clone/ODB mechanics already landed) → §5 (enforced kill,
depends on §2). Until §3 lands, tier 1 (same-owner) remains the only safe
tier — this doc changes no behavior and unblocks nothing on its own.
