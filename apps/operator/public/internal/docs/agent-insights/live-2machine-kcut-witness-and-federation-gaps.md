# Live 2-machine K-CUT re-key witness — the working recipe + the federation gaps (WI-560)
URL: /internal/docs/agent-insights/live-2machine-kcut-witness-and-federation-gaps

How to run the live fed-a/fed-b K0→K1→K-revoke→K-CUT re-key cut-off witness on the linux-test-vm rig, what actually works, and the two real blockers that keep the JOINER (fed-b) from receiving the federated epoch keys: (1) live announce→admit needs a gh-ATTESTED device announce, absent on the gh-unauthed VMs — so admit fed-b via the owner approval path (seed the pending-join + hive:membership_decide); (2) the hive_epoch_keys projection rides the repo-LESS hive HOME log, and a joiner only peers a HOME its operator booted at STARTUP — a view-join after startup never boots the home substrate (repo-bound MEMBERS federate fine without gh; repo-less HOMES need gh-auth announce). Owner-side K-CUT is fully verifiable on fed-a regardless. Discovered 2026-06-24 running WI-560.

import { Aside } from '@astrojs/starlight/components';

The C-001 read-plane re-key flip (`papercusp-hive-rekey`) is owner-gated on a **live
2-machine K-CUT witness** (WI-560; see
[hive-rekey-flip-readiness](/internal/docs/agent-insights/hive-rekey-flip-readiness)).
This page is what running it on the `scripts/linux-test-vm` rig actually taught: the
re-key **mechanism** is green end-to-end at the authoritative OWNER layer, and the only
thing standing between that and the joiner-side confirmation is **federation transport**,
not the re-key code.

`papercusp-desktop/scripts/linux-test-vm/fed.sh` SELF-DISCOVERS the VMs' dynamic
operator/PG ports (they change on every desktop restart). The ad-hoc `/tmp/fed.sh` with
hardcoded ports goes stale after any restart — don't trust it across a reboot.

## The witness, owner-side (this part WORKS, fully on fed-a)

Mechanism map (all gated on `papercusp-hive-rekey`, ON on the rig):

* **K0 admit/grant** — owner admits a member ⇒ `upsertHiveMember` ⇒
  `grantEpochKeysToMembers` wraps epoch `[0..current]` to the new device (owner-self-gated
  on `loadHivePubkey`). `hive-membership-admission.ts` + `hive-epoch-boundary-wiring.ts`.
* **K1 owner re-key** — a benign boundary that KEEPS everyone: `hive-set-listing.ts`
  go-private ⇒ `advanceEpochOnHiveBoundary` with **no cutOff** ⇒ epoch++ wrapped to ALL
  current members.
* **K-revoke** — `hive:ban_member` ⇒ `hive-revoke-contributor.ts`
  `revokeHiveContributor` ⇒ `advanceEpochOnHiveBoundary(cutOffPubkeys=[target device])`
  ⇒ epoch++ wrapped to **remaining members only**. Ban is Hive-native (owner = holds the
  hive key via `loadHivePubkey`), **NOT gh-repo-admin** — no GitHub token needed to ban.
* **K-CUT** — the revoked device simply has no row at the new epoch; no such row exists to
  author or federate, so it can never reach the cut member.

Verified live on fed-a (fresh isolated hive `wi560k-hive`, member ← a public repo), epoch
× device wrap matrix:

| epoch | owner device | revoked device | event                     |
| ----- | ------------ | -------------- | ------------------------- |
| 0     | ✓            | ✓              | admit/grant               |
| 1     | ✓            | ✓              | owner re-key (go-private) |
| 2     | ✓            | **✗**          | ban → cut                 |

The owner-side cut is the thing the flag actually gates, and it composes with the already
-green hermetic content read-cut witness (`hive-epoch-read-cut-witness.test.ts`).

## Gap 1 — admitting the joiner: the live announce→admit needs gh attestation

On the rig **both VMs are gh-unauthed**, so a joiner cannot produce the attested device
announce that the owner's substrate admission (`admitAnnouncedPeerAsOwner` /
`drainAdmissionQueue`) consumes — the joiner materializes only as a read-only VIEW
(`joinHiveAsView`), never a crypto member (this is the long-standing "fed-b is a
view-joiner but has 0 epoch rows" symptom).

**Recipe that works** — drive the owner approval path the WI explicitly allows. Seed the
pending-join on the OWNER (the part the gh gap blocks) then admit through the real verb:

```sh
# on fed-a (owner): seed fed-b's pending join with its real device pubkey
fed.sh a sql "INSERT INTO harness_shared.hive_pending_joins
 (workspace_id,harness_slug,github_user_id,github_username,device_attestations,status,
  requested_at,origin,created_at,updated_at)
 VALUES ('default','<hive-home>',<joiner_gh_id>,'<login>',
  '[{\"device_pubkey\":\"<joiner_device_b64>\",\"gist_id\":\"manual\",\"gist_url\":\"\",
     \"device_label\":\"fed-b\",\"created_at\":0,\"signature_by_device\":\"\"}]'::jsonb,
  'pending',(extract(epoch from now())*1000)::bigint,'local',
  (extract(epoch from now())*1000)::bigint,(extract(epoch from now())*1000)::bigint)"
# admit through the PRODUCTION verb (runs approvePendingJoin → upsertHiveMember → grant)
fed.sh a mcp hive:membership_decide '{"hive":"<hive-home>","githubUserId":<id>,"decision":"approve","workspace":"default"}'
```

The grant/cut path is 100% production code; only the *discovery* of the device is shortcut
(the gh-attestation concern is orthogonal to the re-key mechanism). The real fix for live
admission is restoring gh auth on the VMs (WI-757).

## Gap 2 — delivering to the joiner: repo-LESS homes don't federate without gh + a boot

This is the one that blocks the joiner-side confirmation:

* **Repo-bound MEMBER harnesses federate fine without gh auth** — they rendezvous on the
  public repo topic (`shared_repo_binding_cache.harness_topic`). On the rig fed-b actively
  peers hello-world / fixawitness / spoon-knife members + a freshly-joined member clone.
* **The repo-LESS hive HOME needs the gh-auth-bound announce** (`local-announce-identity` →
  `resolveLocalAnnounceIdentity` throws when gh-unauthed ⇒ `boot.ts` keeps it local-only;
  see [substrate-swarm-self-heal-no-restart](/internal/docs/agent-insights/substrate-swarm-self-heal-no-restart)
  * the [restart runbook §6](/internal/docs/agent-insights/federation-rig-restart-runbook)).
* **`hive_epoch_keys` (and `hive_members`) federate over the HOME log** (the A-003
  hive-home seam), NOT the member topic. So even when the joiner peers the member, the
  epoch keys never arrive.
* **A joiner only peers a HOME its operator booted at STARTUP.** `joinHiveAsView` clones the
  member harnesses but does NOT boot the home substrate; the home boots on the operator's
  startup sweep. A hive view-joined AFTER startup is never peered until the next restart
  (the WI-559 self-heal join-retry only retries a boot that was *attempted* and failed).

### To complete the live joiner-side receipt

1. Restore gh auth on the OWNER VM with its **correct historical identity** (host
   `gh auth token` piped over ssh — runbook §6; reversible, no restart) so the home
   announces.
2. Re-publish the hive (a go-private K1 WITHDRAWS it — re-`discovery:set_hive public` after).
3. **Restart the JOINER's operator** so it boots the post-startup-joined hive's home
   substrate (this changes the joiner's dynamic port — coordinate; other rig agents depend
   on it).

Then the joiner replicates the owner's home log and ends up holding epoch 0..K-1 (the keys
it legitimately had) but **never the post-ban epoch** — the live K-CUT, and (with content
encryption on) the AEAD content read-cut.

## Adjacent bug observed

`hive:create_from_repo` via the **superuser MCP** fails `member_create_failed /
hive_not_found` because the MCP session resolves `ctx.workspaceId='*'` while hives live in
`default`; the HTTP API route (`activeWorkspaceId()='default'`) works. Same EI-3409 class
the versioned `fed.sh` documents (`FED_MCP_WS=default`). Pass `workspace:"default"` or use
the route.
