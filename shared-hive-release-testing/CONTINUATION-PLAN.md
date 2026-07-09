# Shared-Pot Release Testing — Continuation Wave (briefs H–N)

**Why this wave exists.** The original 7-lane program (briefs A–G) ran an
adversarial pass and *converged* to a 🔴 verdict (see `RELEASE-READINESS.md`).
A host restart then killed the live fleet mid-stream. On **2026-06-19 (su-9140a)**
the live federation proof was re-established on a fresh boot, which both
re-confirmed the GREEN core **and** re-witnessed the live blockers. The testing is
NOT "done" — the converged findings now have **owners + fix paths**, and those fixes
need to be *built and re-verified*, plus several dimensions were never driven live.
This wave turns the converged findings into parallel, ownable lanes.

These briefs are **parallel lanes**, same model as A–G: read this file first
(shared context + fresh-boot state + rules), then your brief.

---

## Fresh-boot live baseline (2026-06-19, what is TRUE right now)

Re-ran `papercusp-desktop/bin/two-instance-content-matrix-smoke.sh` with
`SKIP_INVITE=1` on the bootable `Papercusp_0.0.2_amd64.deb`
(`/home/marsh-office/.cargo-target/release/bundle/deb/`, 05:33, luxon bundled),
headless Xvfb `:154`, 2 real peers (A=papercupai owner, B=aviynw joiner).

**GREEN (re-confirmed on the real binary, fresh boot):**
- **A-001 boot** — both real binaries booted; luxon is bundled in the artifact.
- **negative-isolation PASS** — a non-joiner sees zero pot content.
- **topic-equal PASS** (`75e49c5c…`) — the joiner-resolves-its-own-topic path.
- **8/11 content types federate bidirectionally** — features, conversations,
  messages, threads, thread-posts, plans, plan-parts, item-assignments — in
  **backfill + incremental A→B + incremental B→A** (all three phases).

**RED/known (re-witnessed live this run):**
- **A-003** — `pot-settings` (outbox 3–4) + `pot-members` (outbox 1) **never
  cross to the joiner**, in backfill AND both incremental directions. The outbox
  IS populated (capture works) but the joiner never applies them. Live, not rig.
- **presence** — does not cross via raw-INSERT (separate announce wire,
  `wire-presence.ts`) — **by design, NOT a fail**; don't re-file it.
- **D-001** (`convergence-fuzz` / `lww-hlc-fedts-divergence`) — the 2 `it.fails`
  S0 markers still reproduce (restart-independent). Unchanged.

**Live pair status:** LEFT RUNNING after the smoke. Ports in
`~/.papercusp-shared-pot-retest/instances.env` (A/B sidecar + embedded-PG ports,
DHT bootstrap, `DISPLAY=:154`). Teardown: `~/.papercusp-shared-pot-retest/stop.sh`
(path-scoped `pkill -f <WORK>` — safe; never name-pattern the binary).

---

## Lane table

| Brief | Dimension | Sev | Gate | Disjoint area |
|------|-----------|-----|------|---------------|
| **H** | A-002 multi-pot federation stall | S1 | engineering | `swarm.ts` announce channel |
| **I** | A-003 member/settings → joiner (+ revocation) | S1→S0 | engineering | projections / `register-all.ts` / boot admission |
| **J** | D-001 LWW convergence under skew | **S0** | engineering + migration | `projection.ts` / `hlc-stamp.ts` / new migration |
| **K** | C-001/E-001 read-plane revocation | S1→S0 | **product decision** | authority / `swarm.ts` replicate gate / re-key |
| **L** | pot-from-repo + invite-join honesty (G-001/G-002) | S1/S2 | build a fix-`.deb` | discovery/join + `pot-publish.ts` + build scripts |
| **M** | desktop UI: share flow + G-004 live status surface | S2 | implement-or-document | `ShareHiveDialog.tsx` / operator-vite |
| **N** | N-peer (3+) scale, churn, backfill-at-size | S1 | integration | rigs (`composition-rig`, `_cross-peer-rig`) |

**Edge overlaps (locks serialize; don't fight them):** H & K both touch `swarm.ts`;
H, I, J each touch a *different function* in `boot.ts`. Claim files via `locks:*`
before editing; `coord:declare-intent` your brief letter + items first.

---

## Rules (inherited from the A–G program — unchanged)

- **One framework per test:** Vitest (`*.test.ts` / `*.integration.test.ts`),
  Playwright (`apps/operator/e2e/*.spec.ts`), Cargo, or LLM scenarios. **No new
  `.mjs`/tsx/bash smoke drivers** (CI lint P-038 fails). The existing
  `two-instance-*.sh` are ops harnesses, not the place for new assertions.
- **Teeth-verify every new test:** green → neuter the invariant → confirm RED →
  restore → confirm GREEN. A test that can't go red proves nothing.
- **The rigs bypass `defaultResolveSwarmBinding`** (they wire matching topics
  directly) — so no integration test exercises the real joiner-resolves-own-topic
  path. Any federation brief MUST cover the joiner path explicitly (live pair, or
  the binding resolver directly), not assume the rigs cover it.
- **Work on `staging` directly** — no branches/worktrees/stashes. **git-sync owns
  commit+push — you do neither.**
- **Live lanes (H, K, L, M) share the 2-instance harness** — one fixed-`.deb` pair
  at a time. Coordinate via the `shared-pot-live-instances` lock (or `coord:*` if
  the named resource isn't registered). The pair from this run is UP and reusable.
- **NEVER drive `DISPLAY=:0`** (the owner's real screen — fleet-halt in force).
  Start your OWN Xvfb (`:1xx`) or reuse the smoke's `:154`. Desktop UI = the Tauri
  shell per `/internal/docs/testing/agent-e2e`, headless — never a browser at
  `:3055`/`:3070`.
- **Verify federation via each peer's embedded PG `origin` column**
  (`postgresql://harness_admin:harness_admin_pwd@localhost:<pg>/papercusp`,
  `harness_shared.*`). `origin='remote'` on the peer = it crossed.

## Deliverables (every brief)

1. New tests (right framework, teeth-verified) closing the gap.
2. `findings-<X>.md` — every bug (repro + severity), gap closed, gap left open (why).
3. A release-readiness verdict for the dimension: GREEN / YELLOW (caveats) / RED.
4. Fix in-scope low-risk bugs; `coord:*` the owner + file an EI for cross-cutting ones.

## Severity rubric
- **S0:** data loss/corruption, privacy leak, unauthorized write, non-convergence, crash/hang.
- **S1:** a feature silently doesn't federate, revocation not enforced, recovery fails.
- **S2:** UX/honesty, slow path, recoverable-but-noisy.
