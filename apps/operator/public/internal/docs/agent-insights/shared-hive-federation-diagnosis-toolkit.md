# Shared-hive federation — the live-diagnosis toolkit + the two admission paths
URL: /internal/docs/agent-insights/shared-hive-federation-diagnosis-toolkit

When a fresh joiner rosters a hive but receives no content, the cause is almost always upstream of the apply-guard: an ADMISSION decision, not a merge bug. This is the toolkit to read a live fed-a/fed-b rig (fed.sh: ports/sql/api/mcp/ssh self-discovering ports) and the model to interpret it — the SIGNED-announce identity decider (revoked → bad_sig → verifyBinding → admit/pending/binding_invalid) feeding the TWO same-hive SCOPE paths (owner-log bootstrap-admit vs member-set admission+buffer), the registry-gated substrate boot that decides which hives a node even swarms, the boot-history event log (dogfood-substrate-boot-history), and what binding_invalid actually means (gist-less owner → conclusive reject, NOT retried).

## When to read this

You are staring at a live two-machine shared-hive rig (fed-a = owner, fed-b =
joiner). Membership/roster federates (fed-b sees the owner in its roster, epoch
keys decrypt), **but content does not cross** — features/plans/issues written on
one member never materialize on the other, "discovers 0". You are about to suspect
the merge loop or the apply-guard.

**Stop. The merge/apply guard is almost never the live cause.** It is unit-green and
re-proven over real testcontainer-PG + real swarm
(`feature-content-federation.integration.test.ts`). On a live rig the failure is
upstream: the peer's log was never **admitted**, or the node never **swarmed** the
hive at all. This doc gives you (1) the toolkit to read the live state, and (2) the
admission model you need to interpret what you read. It is the synthesis the
public-release diagnosis (`shared-hive-public-release-2026-06-22`, D-005…D-010)
converged on after every mechanical apply hypothesis was refuted.

> Sibling docs, each a different slice — read them too:
> [`shared-hive-live-federation-witnessing`](/internal/docs/agent-insights/shared-hive-live-federation-witnessing)
> (the green-rig/red-binary trap + smoke gotchas),
> [`federation-rig-restart-runbook`](/internal/docs/agent-insights/federation-rig-restart-runbook)
> (recovering a wedged rig / missing gh-auth),
> [`owner-side-cross-member-content-apply-gap`](/internal/docs/agent-insights/owner-side-cross-member-content-apply-gap)
> (the one genuine apply-guard asymmetry),
> [`hive-approval-membership-gate-wiring`](/internal/docs/agent-insights/hive-approval-membership-gate-wiring)
> (the owner-admission approval seam).

## The toolkit — `fed.sh`

`papercusp-desktop/scripts/linux-test-vm/fed.sh` is the versioned, reliable way to
drive either VM. Its whole reason to exist: the packaged app picks a **fresh dynamic
operator + PG port on every boot**, old listeners linger, and the app log's "latest
`[serve] listening on`" line is unreliable (EI-3409 / WI-559 burned hours on exactly
this). So `fed.sh` **self-discovers** the live ports on every call by SSHing in and
probing — operator = the loopback port answering `GET /api/desktop/preflight` 2xx
(other listeners 404 it; dead ones refuse); PG = the port that accepts a
`harness_admin` psql to `papercusp`. Discovered ports are cached per-VM under
`~/.papercusp/fed-rig-ports.<vm>` for `FED_PORT_TTL` (default 600s) and auto-rediscovered
when a target port stops answering. It survives app/VM restarts with **no edits**.

| Subcommand                                      | What it does                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `fed.sh <a\|b> ports`                           | Show the discovered `operator=` / `pg=` ports (pass `1` to force a probe).                   |
| `fed.sh <a\|b> rediscover`                      | Clear the port cache and re-probe. Run this FIRST after any restart.                         |
| `fed.sh <a\|b> sql "<SQL>"`                     | `psql` against the VM's embedded PG as `harness_admin` / `papercusp`.                        |
| `fed.sh <a\|b> api <METHOD> <path> [json-body]` | Superuser HTTP route (Bearer from the operator's actual `$HOME/.papercusp/superuser-token`). |
| `fed.sh <a\|b> mcp <tool> [json-args]`          | Superuser MCP tool over `/api/mcp?superuser=1` (returns just the `data:` SSE payload).       |
| `fed.sh <a\|b> ssh <cmd…>`                      | Raw SSH into the VM (e.g. `ssh 'tail papercusp-app.log'`).                                   |

Two footguns the script already handles, but you must know:

* **`$HOME` is workspace-scoped on a VM whose operator runs workspace-scoped**
  (`HOME=/home/tester/.papercusp-workspaces/default`, D-007). The superuser token
  and `gh` auth live under the operator's *actual* HOME, not `/home/tester`. `fed.sh`
  derives the token from `/proc/$(pgrep -f serve.mjs)/environ`; if `hive:membership_decide`
  returns `no_owner_identity`, the operator's HOME is missing `~/.config/gh` — symlink it.
* **EI-3409 superuser-MCP workspace mismatch.** Superuser MCP resolves
  `ctx.workspaceId='*'` while HTTP routes/queue use `'default'`, so a hive created via
  `mcp` lands in the wrong workspace and routes then return `not_owner_swarm`. For a
  workspace-scoped WRITE tool, set `FED_MCP_WS=default` so `fed.sh` injects
  `workspace:"default"` (OPT-IN — blanket injection breaks READ tools that reject an
  unknown `workspace` key).

## The two-path admission model — the thing you are actually debugging

Content reaches a peer only if that peer **admits the source log**. Admission is two
layers; read them top-to-bottom because the second only runs after the first passes.

### Layer 1 — the SIGNED-announce identity decider (`read-admission.ts`)

Every inbound announce runs `decideAdmission` with fixed precedence:

```
revoked → bad_sig → verifyBinding → admit / pending / binding_invalid
```

`verifyBinding` is 3-state (D-006):

* **`verified`** → channel-2 attestation valid (the announce's `attestation_gist_id`
  is a GitHub gist owned by `github_user_id` containing `device_pubkey`) → **admit**.
* **`pending`** → OUR transient failure (GitHub unreachable / gist-propagation lag) →
  `reason:'pending'`, **RETRYABLE** within the grace window.
* **`fail`** → **`binding_invalid`** — a CONCLUSIVE attestation failure (gist gone,
  owner/pubkey mismatch, bad sig on the binding). **Not retried.**

This is the layer the public-release live witness is stuck on. A **gist-less owner
placeholder** (a hive created without a real GitHub gist, e.g. on a gh-degraded VM)
fails `verifyBinding` → `binding_invalid` → the owner's own log is conclusively
rejected, so nothing it authored can ever be admitted. WI-797 is the structural gap
here: `owner_bootstrap` (Layer 2 below) sits *after* this gist gate, so it cannot
rescue a gist-less owner in the fresh-join window. **`binding_invalid` in the
boot-history means "fix the identity/gist, not the merge."** Distinguish it sharply
from `pending` (transient, will retry) and `revoked` (read-cut, must stay rejected).

### Layer 2 — the same-hive SCOPE widening (`boot.ts` `resolveSameHiveMember`)

Layer 1 admits a peer on *slug* identity. Layer 2 only *widens* scope to cross-member
content within the same hive — it **never bypasses** revocation or the read-cut
(Layer 1 re-checks `revoked` on every retry tick). Inside `resolveSameHiveMember`
there are **two distinct admit paths** — this is "the two-path model":

**Path A — owner-log BOOTSTRAP admit (WI-787 / WI-780, the keystone).** A fresh
joiner's `hive_members` is **empty**, so the owner's own announce would `miss` the
member-set check below and buffer forever — yet the roster that *would* admit the
owner lives **inside the owner's still-un-merged log**. That is a bootstrap deadlock.
It is broken by trusting exactly ONE device: the `owner_device_pubkey` the SIGNED,
gh-verified hive-announce binds to **this joined hive**. The binding is read via
`loadHiveOwnerDevicePubkey(workspaceId, hivePubkey)` — and crucially needs **no new
migration**: it reads the verified `(hivePubkey → ownerDevicePubkey)` binding the P2P
hive-directory offline cache already persists (`hive_directory_cache`, migration 182),
which only records descriptors that passed `verifyHiveAnnounce` (D-010). Admission is
gated on `opts.swarmBinding.hive_pubkey` (the JOINED hive) and matches the **exact**
owner device only — never on `github_user_id` alone, never any other device (that
would hole the WI-259 membership guard). Emits boot event `announce_admitted
owner_bootstrap`.

**Path B — member-set admission (`classifySameHiveMember`).** For every other peer:
admit iff `frame.device_pubkey ∈ loadHiveMembers(hiveHome, github_user_id)` (the
hive's current member device pubkeys). On `admit` → `announce_admitted
same_hive_member`. On **`miss`** (a plausible same-hive cross-member whose
`hive_members` row has not federated to us yet — the asymmetric A→B stall) the frame
is **BUFFERED** for retry, **not** conclusively dropped: a 5s loop re-runs Layer-1
`admit()` + this check each tick, admitting the instant membership federates in, or
dropping after the 30-min grace.

> The merge loop iterates **only `admitted.values()`** (`boot.ts`), and `admitted`
>
> * `admittedIdentities` are populated together from the same announce frame — so for
>   any op that actually merged, the source identity is present. That is why a live
>   "0 rows" is virtually never the apply-guard's `!sourceLogDevicePubkey` drop branch;
>   it is one of the admission outcomes above (binding\_invalid / buffered-miss /
>   never-swarmed), or the genuine owner-home apply asymmetry documented separately in
>   `owner-side-cross-member-content-apply-gap`.

## Registry-gated substrate boot — does the node even swarm this hive?

Before admission can happen at all, the node has to **boot the substrate and join the
hive's swarm topic** for that harness. This is **registry-gated**: `host-bootstrap.ts`
boots substrate only for harnesses returned by `loadHarnessRegistry(workspaceId)`, and
`hive-federation.ts` resolves the swarm binding from that same registry. **A node
swarms only hives it has a local registry entry for — NOT ones it merely rosters.**

This is a real and easily-missed live cause: a joiner can show the hive in its
*roster/directory* yet never have a registry project for it, so it never joins that
hive's topic, never receives the owner's announce, and admission never even gets a
chance to run. When `fed.sh b api GET /api/discovery/hives` shows the hive but content
is 0, check the registry (and the swarm-join log) before touching admission. (See also
[`hive-scoped-federation`](/internal/docs/agent-insights/hive-scoped-federation) and
[`lazy-substrate-boot-and-sidecar`](/internal/docs/agent-insights/lazy-substrate-boot-and-sidecar)
for which harnesses boot substrate and which stay inert.)

## Reading the live state — boot-history is your admission ledger

The admission decisions above all `recordBootEvent` into an in-process ring buffer,
surfaced read-only at:

```
GET /api/admin/dogfood-substrate-boot-history?harness_slug=<slug>&kinds=<csv>&limit=<n>
```

Auth is **verified/trusted admin** (gated per D3; it used to be public). Response:
`{ entries: BootHistoryEntry[], depth }`, each entry `{ ts, workspaceId, harnessSlug,
kind, message }`. Read it through the toolkit:

```bash
fed.sh b api GET '/api/admin/dogfood-substrate-boot-history?harness_slug=<hive-home>&kinds=announce_rejected,announce_pending,announce_admitted&limit=50'
```

The diagnostically-loaded `kind`s (`boot-history.ts` `BootHistoryKind`):

* `announce_admitted` — admission succeeded. The `message` says **which path**:
  `owner_bootstrap …` (Path A), `same_hive_member origin=… hive=…` (Path B).
* `announce_rejected` — Layer-1 conclusive reject. Look at the reason — **`binding_invalid`**
  (gist/identity, fix that — see WI-797), `revoked` (read-cut, correct), `bad_sig`.
* `announce_pending` — Layer-1 transient (`pending`) OR a Layer-2 membership `miss`
  buffered for retry. Will self-resolve if the cause clears; otherwise it ages out at
  30 min.
* `swarm_join_failed` / `peer_connected` / `peer_rejected` / `peer_rate_limited` /
  `peer_capped` / `peer_revoked` — the **transport** layer. No `peer_connected` for the
  hive topic at all ⇒ a swarm/registry/gh-auth problem, **upstream of admission** — go
  back to the registry-gating and `federation-rig-restart-runbook` (missing gh-auth is
  the #1 silent-local-only cause after a VM reset).
* `merge_error`, `rekey_grant_*`, `rekey_boundary_skipped` — apply/re-key layer.

## The diagnostic ladder (use this order)

1. **`fed.sh <a|b> rediscover && fed.sh <a|b> ports`** — confirm you're hitting the
   LIVE operator/PG (stale ports masquerade as "broken federation").
2. **Transport** — boot-history `peer_connected` for the hive topic on both VMs? No ⇒
   registry-gated-boot / swarm / gh-auth. Not admission.
3. **Layer 1 (identity)** — `announce_rejected reason=binding_invalid` ⇒ gist/identity
   (gist-less owner = WI-797); `pending` ⇒ wait/retry; `revoked` ⇒ working as intended.
4. **Layer 2 (scope)** — `announce_pending` membership-miss buffered ⇒ the roster hasn't
   federated yet (is the owner-bootstrap Path A admitting the owner's log? look for
   `announce_admitted owner_bootstrap`). Empty `hive_members` on a fresh joiner is
   EXPECTED until Path A merges the owner log.
5. **Apply** — only now suspect the guard, and only the documented owner-home asymmetry
   (`owner-side-cross-member-content-apply-gap`). Verify with the live PG via `fed.sh sql`,
   remembering `fed_ts` is the LWW key (`testing-federation-set-fed-ts`), not `ts`.

## TL;DR

* A live "rosters but no content" is an **admission** or **swarm-registry** problem,
  not a merge bug — the merge/guard is integration-green.
* `fed.sh` (self-discovering ports) is the access tool: `ports`/`rediscover`/`sql`/`api`/`mcp`/`ssh`.
* Admission = **identity decider** (`revoked→bad_sig→verifyBinding→admit/pending/binding_invalid`)
  feeding **two same-hive scope paths**: **owner-log bootstrap-admit** (trusts the one
  directory-cache-bound owner device to break the empty-member-set deadlock) and
  **member-set admission** (device ∈ `hive_members`, else buffer-and-retry).
* **`binding_invalid` = conclusive identity/gist failure, never retried** — a gist-less /
  fresh-join-window owner used to be the live wall (WI-797): owner-bootstrap sat AFTER the
  gist gate, so the owner's own announce was rejected before the bootstrap could rescue it.
  **FIXED 2026-06-25** (su-ed33c735, A2 su-5394073c): the owner-device bootstrap is now
  hoisted into `admitsAsKnownHiveMember` (the IDENTITY stage, BEFORE the gist gate) —
  `boot.ts` \~1727. Live-proven on the fed-a/fed-b rig: `announce_admitted owner_bootstrap`
  fires and roster+epoch federate owner→joiner `origin=remote`. See WI-797 / plan
  `shared-hive-public-release-2026-06-22` D-011.
* **GOTCHA — a stale `kind=topic` harness on the same hive topic INTERCEPTS the owner
  announce.** A bare `/api/harness/join-link` (vs `/api/discovery/join-hive`) binds the
  member as `swarmBinding.kind=topic` (no `hive_pubkey`). If that junk harness boots FIRST
  on the topic it owns the connection's announce channel and rejects the owner frame
  `binding_invalid`, and the proper `kind=hive` handlers never see it (no per-frame A-003
  trace for them). Symptom: only the topic-harness logs the rejection; `is-even`/`<hive>`
  show `boot_ok`+`peer_connected` but no admission event. Fix: remove the junk harness
  (registry `jsonb` filter + clone dir) and relaunch — the owner-bootstrap then fires.
* **The new finish line is the CONTENT layer, not admission.** With WI-797 fixed, the owner
  log merges and control rows (`hive-members`, `hive-epoch-keys` — plaintext per
  `hive-epoch-content-ops.ts`) apply, but **encrypted content ops** (features/work-items/
  plans/issues) can still drop on apply even with the epoch key wrapped for the joiner's
  device — the GATE-2 content-apply layer (`owner-side-cross-member-content-apply-gap`,
  D-003, WI-367 content-before-key ordering-drop + the `drainQueuedEpochContent` replay).
  Isolate lag-vs-drop with a fresh op; if a NEW op also never lands, it's a drop, not lag.
* Substrate boot + swarm join are **registry-gated**: a node swarms only registry hives,
  not merely-rostered ones.
* `dogfood-substrate-boot-history` (verified-admin) is the admission ledger; read its
  `kind`/`message` to place the failure on the ladder before touching code.
