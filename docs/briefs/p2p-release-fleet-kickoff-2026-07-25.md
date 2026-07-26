# p2p-release fleet — mission delta

Leader: `su-e3b21`. Plan: `p2p-public-release-remaining-lanes-2026-07-16` (harness `papercusp`).

[owner 2026-07-25] *"you're in charge of getting all our p2p coordination ready for a public
release, another agent su-a8ea9 is working on the GIT features and another agent su-055ae is
working on everything else."*

**Mission:** get the **live-federation gate** green and keep it green. That gate — an hourly job
that builds a real `.deb`, installs it on two containerised frames (`rig-a` = hive owner,
`rig-b` = member) on a private bridge with a 3-node testnet DHT, then runs ~14 federation
scenarios against the real binary — is the release signal for this lane. It is the only surface
that catches the "green-rig / red-binary" class; hermetic tests do not exercise it.

You already carry the member operating loop. Below is only what you cannot know.

---

## 1. ⚠ THE RIG IS SINGLE-TENANT — do not start a run

`bin/local-matrix.sh` is flock-serialised per bridge network and an **hourly timer already drives
it**. A second run does not queue politely — provisioning `docker rm -f`s the other run's LIVE
frames and destroys whatever evidence that run was producing. **No member starts a rig run.**
If your lane needs live-rig evidence, tell the leader and it gets scheduled.

Read banked evidence instead — there is a lot of it:

| what | where |
|---|---|
| per-run artifacts | `/tmp/live-fed-gate-<YYYYMMDD-HHMMSS>/{local-matrix.out,content-matrix.out,build.log}` |
| banked frame logs | `~/.papercusp/live-fed-gate/triage/{serve-a,serve-b,scn.<scenario>,load}-<HHMMSS>.log` |
| LIVE frames (only while a run is in flight) | `docker exec pcusp-rig-a sh -c 'grep … /home/pcusp/serve.log'` |

Frame logs are ~1M lines. **`grep`/`awk` them via `code:run` or Bash — never stream one into
context.** Most lines have no timestamp; `[A-003]` lines do, so
`awk 'match($0,/20..-..-..T..:..:../){ts=substr($0,RSTART,RLENGTH)} /pattern/{print ts, NR, $0}'`
is the working idiom for a timeline. (Fixing that is P-422.)

Hermetic unit + integration tests are the parallel-safe surface — run those freely.

## 2. Read this before diagnosing anything restart-shaped

**WI-5639 root cause, landed by the leader this session.** The state *"log was replicating → peer
restarted → replicator detached → swarm sockets still live"* had **no repair path at all**. Four
rungs, all structurally blind to it:

1. the zombie axis (`connected_never_replicated`, short grace, **has** repair) was hard-gated on
   `lastNonZeroPeersMs === null` — armed only for a log that had *never* attached a replicator,
   and permanently disarmed once one did;
2. `no_replicator` fires at 180s but is **excluded** from `boot.ts`'s `REPAIRABLE_EPISODE_KINDS`;
3. swarm's severed-link escalation needs `liveConnectionCount === 0` (`swarm.ts:1350`) — these
   sockets are live, so it never trips;
4. `frozen` requires a replicator *attached*, the negation of this state.

Live proof (gate run `20260725-143908`, frame a): zombie repair healed the log at 18:48:29,
`no_replicator` fired at 18:48:44 with **no repair**, then the link sat dead for **25 minutes** —
swallowing `restart_durability`'s post-restart write *and* `reconnect_catchup`'s baseline. The fix
generalises the zombie axis to "no replicator attached **right now**".

**Why this is your business:** it is a plausible **common cause** for several lanes here —
P-409 (WI-5672 "first cold restart after a fresh join fails to re-establish replication"), the
`restart_durability` / `reconnect_catchup` reds, and the replication_soak SLA misses. It also
explains why WI-5665's forensics found the failures **cycle-position-correlated and not
load-correlated** (the *restarted* frame gets a fresh registry and heals in 3-6s; the *surviving*
frame keeps its state and falls in the hole). **Check whether your symptom is downstream of this
before you deep-dive an independent theory.** The leader will report the post-fix gate result.

## 3. Hot zones — expect lock blocks, pivot rather than route around

`packages/operator-core/lib/sync/hyperbee/{boot.ts,replication-liveness.ts,swarm.ts}` are touched
by several lanes at once. The per-edit lock hook serialises writes and tells you who holds a file
and why. When blocked: do other useful work or re-queue and end your turn. **Never** rename/copy
around a lock — that is a peer's in-flight work.

`replication-liveness.ts` and its test are **leader-held right now** for P-414.

### OFF-LIMITS — another owner's lane

`su-a8ea9` owns the **pot-git publish-guard / github-bridge egress** lane (their plan:
`p2p-publish-guard-recoverability-2026-07-25`). Do not edit:

- `packages/operator-core/lib/sync/pot-git/**`
- `packages/operator-core/lib/harness/git-sync/**`
- `apps/operator-docs/src/content/docs/agent-insights/p2p-publish-guard-total-over-cap-wedge.mdx`

**P-421 (WI-5738) is dropped from this plan** for that reason — it is theirs, not abandoned.
`su-055ae` owns everything outside p2p and git.

Two facts from that lane you should not re-derive:

- **`origin/staging` IS the p2p health signal** (the bridge egresses `refs/hive/staging` →
  `origin/staging`). An older brief says the opposite; that brief is wrong — it conflated the
  egress target with the *ingress* branch list. `origin/main` advances via the RELEASE pipeline,
  not the p2p bridge.
- The publish guards are currently **still wedged** (`ref_announce`, github egress);
  `own_head_publish` unwedged 20:07Z. Do not read a stale `origin/staging` as a federation-substrate
  fault — it is that known, owned wedge.

### A pattern to watch for — absorbing-state guards

Two independent instances found today, one per lane:

- git lane: *"every guard takes its baseline from its own last SUCCESS, so a refusal is terminal
  by construction"*;
- this lane: `alarmedConnectedNever` was cleared only on an observed RECOVERY, so a
  sustained-offline reset leaked the latch and permanently silenced that log's alarm (fixed in
  P-414).

If your lane has a guard, latch, watermark, or cursor whose baseline advances **only on success**,
the first failure is absorbing — treat that as a bug and check the RESET path, not just the
failure path. That is where both instances hid.

## 4. Execution order

Genuinely independent, take in any order: **P-415, P-416, P-417, P-419, P-420, P-421, P-422**.

Sequenced:
- **P-416** (gate single-instance lock) is high-leverage for *everyone* — a colliding manual run
  corrupts every other lane's evidence. Worth taking early.
- **P-415** (settle-barrier false PASS) and **P-411** (scenario-assert integrity audit) overlap:
  both are "the gate lies to us". Coordinate; do not both rewrite the same scenario harness.
- **P-409** (WI-5672) — read §2 first.
- **P-408 / P-402** (gate first-green closure) are the leader's critical path; they close last.
- **P-405** (GO/NO-GO resynthesis) and **P-413** (attestation re-verify) are terminal — do not
  start them while Phase-5 reds are open.

## 5. Standing rules for this fleet

1. **A fix is not done until it has a recurrence guard** — a test that fails if the class returns.
   Mitigations get labelled `TEMPORARY MITIGATION … durable fix = … tracked as …`.
2. **A detector that lies is a bug of equal severity to the thing it missed.** Two lanes here
   (P-415, P-417) exist purely because of that. If you find another, file it.
3. **`git blame` is worthless in this repo** — git-sync commits the whole tree under one identity.
   Never attribute a change with it; a false accusation reached the owner once (WI-5111).
4. **Never point a browser / verdict / playwright at `:3055` or `:3070`** — desktop/Tauri only.
5. **git-sync owns commit + push.** Leave verified edits in the `staging` tree; never
   `git reset --hard` / `checkout .` / `clean -fd` / `stash` on the shared checkout.
6. **Do not release a work-item back to the pool to hand it over** — every release wakes the whole
   idle drain fleet (filed as `EI-18151406094317010`). Transfer with `work_items:claim { id, assignee }`.
7. Report terminal outcomes and blockers **with diagnosis** to the leader via `coord:send`. A
   shared-tree fault (broken deps, a wedged service) is the leader's to fix fleet-wide — say so.

## 6. Gates the leader will open

Declared at kickoff; `events:await` the key rather than polling. Your `coord:orient` carries them
under `announcedGates`.

- **`wi5639-fix-verified`** — the replication-repair fix confirmed on a real rig run. If your lane
  is waiting to see whether WI-5639 explains your symptom, park on this instead of theorising.
- **`gate-first-green`** — the live-federation gate's first fully-green run. P-405 / P-413 wait here.
