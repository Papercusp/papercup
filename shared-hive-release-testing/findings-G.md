# Brief G — Desktop UX flows & honesty findings

Owner: su-d7af0 (Claude). Lane: desktop user-facing shared-hive flows, "the UI never lies".

**Method note:** these findings are from an **adversarial code-audit + deterministic
component/unit tests** of the exact surfaces the desktop renders, cross-checked against
backend ground truth (the way Lane C found C-001). **A live Tauri pass has not yet been
run for lane G.** Originally it was blocked by Lane A's A-001 (S0: the `.deb` didn't
boot); **A-001 is now FIXED + a bootable `.deb` is verified (per RELEASE-READINESS.md),
and Lane A handed its live pair to Brief E and released the `shared-hive-live-instances`
lock.** A live G pass therefore remains open and is now *possible*, but: (a) the live
pair is currently driven by Brief E, and (b) a desktop GUI pass must run on a **sandbox
Xvfb display, NOT host `:0`** (the active fleet-halt: the owner is watching `:0`). So the
live G pass is queued behind E + the halt, not behind a boot bug.

---

## Surfaces audited (the real desktop render path)

- **Share/Publish:** `apps/operator/app/harness/ShareHiveDialog.tsx`
  (`ShareHiveForm`/`ShareHiveDialog`/`PublishHiveCard`) → `POST /api/discovery/set-hive`
  → `hive-set-listing.ts` → `republishHiveAfterMemberAdd` → `publishHiveToDirectory`
  → directory announce.
- **Invite-link join:** `apps/operator/app/harness/CreateHarnessPicker.tsx`
  (`HiveInviteForm`) → `POST /api/discovery/join-invite` → `joinInviteTopic`.
- **Discover/browse + one-click join:**
  `apps/operator-vite/src/components/workbench/WorkbenchHiveDirectoryPanel.tsx`
  (the LIVE desktop panel — the Vite SPA, NOT the retired `apps/operator` Next webapp)
  → `GET /api/discovery/hives` + `POST /api/discovery/join-hive`.
- **Federation status surface:** `apps/operator/app/adv/harnesses/HiveHeaderStrip.tsx`.
- **Create + visibility derivation:** `lib/agent-tools/hive/_create_from_repo.ts`.

---

## Flow matrix

| Flow | Happy path | Unhappy path | Honesty vs ground truth | Verdict |
|---|---|---|---|---|
| **Create hive (from repo)** | ✅ visibility derived server-side | private repo → `invite` (not public) | ✅ `repoIsPrivate ? 'invite' : 'public'` (`_create_from_repo.ts:362`) — no private-repo-forced-public | **GREEN** (code) |
| **Publish — reachablePeers copy** | ✅ component renders `>0`/`0`/`announced:false` distinctly & honestly | n/a (component) | ⚠️ **backend feeds an inflated count → G-001** | **YELLOW** |
| **Publish — invite link** | ✅ correct artifact (`papercusp://hive?pubkey&secret&title`), secret REUSED on edit | n/a | ✅ link carries pubkey+secret; reuse keeps handed-out links valid | **GREEN** (code) |
| **Discover/browse** | ✅ lists discovered public/invite hives, honest empty/loading/unavailable states | join-disabled "link required" for topic-only hives (honest) | ⚠️ **no live refresh → withdrawn lingers / new not shown → G-003** | **YELLOW** |
| **Join — by invite link** | subscribe succeeds | malformed → clear error; 503 → "run gh auth login"; busy resets on every branch (no stuck spinner) | ⚠️ **"✓ accepted … appears shortly" is unconditional → expired/wrong/withdrawn secret = fake success → G-002** | **YELLOW** |
| **Join — directory one-click** | ✅ "Joined hive 'X' — N/M member(s)" (honest partial-success) | "Join failed: <err> (K member(s) joined)" honest | ✅ reports real per-member outcome | **GREEN** (code) |
| **Federation status surface** | shows member count + "N/M set up" + directory-state badge | — | ⚠️ **no live sync/peer-reachability surface at all → G-004**; "(fleet liveness)" wording → G-005 | **YELLOW (gap, not a lie)** |
| **"Synced while stranded" (S0 hunt)** | — | — | ✅ **NOT FOUND** — there is no live "synced/connected" claim to lie. No S0 here. | **GREEN** |

---

## G-001 — `reachablePeers` is TOPIC-BLIND: publish overstates real reach (S2 honesty; Brief-G "publish-lie" class)

**Severity:** S2 by the program rubric (UX/honesty). **Brief G explicitly elevates
publish-lies to S1** — this is a regression of the exact "deceptive-publish" class the
program already fixed once, so treat it as release-gating-UX.

**Claim:** A publish reports `reachablePeers` = swarm peers across **every joined
directory topic**, not the peers on the **announce's own topic**. So "Published —
announced to N connected peers" can claim N when **zero** peers actually received this
announce. Worst case: an **invite** publish on a box that has joined the global
directory topic (to browse public hives) reports the *global* peer count for an announce
that went only to the *invite* topic — the deceptive-publish bug, resurrected for invite.

**Why the green suite missed it:** the existing component test
(`ShareHiveDialog.test.tsx:133`) asserts `reachablePeers: 3 → "announced to 3 connected
peers"` and trusts the number. No test feeds a *topic-mismatched* count, and the wiring
that computes the number is never asserted against the announce topic.

**Evidence (code):**
1. **The count is all-topics.** `directory-swarm.ts:267-272` — `openChannelCount(topicHex?)`
   sums `st.channels.size` over **all** joined topics when called with **no arg**.
2. **The wiring passes no topic.** `hive-directory-boot.ts:121` —
   `setHiveDirectoryTransport(transport, keychainId, () => gossip.openChannelCount())`
   — no `topicHex`, so `reachablePeers()` is the all-topics total.
3. **The announce is single-topic.** `hive-directory.ts:412-420` `topicForLocalHive` →
   public = `deriveDirectoryTopic()` (global), invite = `deriveInviteTopic(secret)`;
   `announceLocalHive` (`:467`) broadcasts to **that one** topic only.
   `directory-swarm.ts:87-89` `broadcast`: "Pairing guarantees **only peers that joined
   that topic** receive it."
4. **The contract it violates is its own.** `hive-set-listing.ts:35` / `hive-publish.ts:73`
   /`hive-publish-from-repo.ts:44` all document `reachablePeers` as "swarm peers the
   announce **actually reached**" — i.e. per-announce. The implementation counts
   per-process-across-topics.
5. **Per-topic counting already exists** — `openChannelCount(topicHex)` (`:268`) returns
   the right number; the publish path just never passes the topic.

**Repro (the demonstrating tests added — see Tests):**
- `directory-swarm.test.ts`: a gossip paired on topic-A (1 channel) + topic-B (0
  channels) → `openChannelCount()` === 1 while `openChannelCount(B)` === 0. The publish
  wiring uses the former for a topic-B announce → overstates by the A peers.
- `hive-publish.test.ts`: `publishHiveToDirectory` of an INVITE hive returns
  `reachablePeers` = the injected all-topics count even though the invite topic has 0
  peers.

**Fix (low-risk, in-lane — sketch):** thread the announce topic into the count.
- `HiveDirectoryDeps.reachablePeers?(topicHex?: string)`, `HiveDirectory.reachablePeers(topicHex?)`
  pass-through, and a `HiveDirectory.reachablePeersForHive(hiveId)` that resolves the
  owned descriptor's topic and calls `reachablePeers(hiveTopicAsHex(topic))`.
- boot wiring → `(topicHex?) => gossip.openChannelCount(topicHex)`.
- `publishHiveToDirectory` → `reachablePeers: announced ? dir.reachablePeersForHive(meta.hiveId) : 0`.
- Default-no-arg path preserved → back-compat.
- **Touches `hive-directory*.ts` which Lane E also edits → coordinate before landing**
  (filed to owner + E; not landed unilaterally).

---

## G-002 — Invite-link join: "✓ accepted … appears shortly" is UNCONDITIONAL (S2 honesty; Brief-G "join-no-op" class) — ✅ COPY FIX LANDED

**Severity:** S2 by rubric. **Brief G elevates join-no-ops to S1** — a well-formed but
dead invite is indistinguishable from a good one and is shown as success.

**Claim:** `POST /api/discovery/join-invite` returns `{ ok:true, joined:true }` after
merely **subscribing to the invite topic** — it never confirms a hive announces there.
The UI then shows **"✓ Invite accepted — Joined the invite directory — the hive will
appear in the panel shortly."** For an **expired/withdrawn** hive, a **wrong-but-
well-formed** secret, or an **offline owner**, nothing ever appears — the user was told
success and gets a silent no-op.

**Evidence (code):**
1. `join-invite.ts:52-59` — `await wiring.joinInviteTopic(invite.secret)` then
   `Response.json({ ok:true, joined:true })`. No announce wait, no confirmation.
2. `hive-directory-boot.ts:141-143` — `joinInviteTopic` is literally
   `gossip.joinTopic(deriveInviteTopic(inviteSecret))`. A DHT topic join. Nothing more.
3. `hive-invite-link.ts:38` — `SECRET_RE` accepts **any 16–128 hex string**, so a
   wrong/typo'd/expired secret **parses identically** to a valid one and joins a garbage
   (un-announced) topic → `ok:true`.
4. UI copy: `CreateHarnessPicker.tsx:605-607` — unconditional "will appear … shortly".

**The honest pattern already exists in the codebase** — the directory one-click join
(`WorkbenchHiveDirectoryPanel.tsx:99`) reports the real **`N/M member(s)`** outcome. The
invite-link join just doesn't apply it.

**Fix — DONE (copy) + recommended (confirmation):**
- ✅ **LANDED (low-risk, in-lane):** honest copy in `CreateHarnessPicker.tsx:605-608` —
  heading "✓ Subscribed to this invite"; body "The {hive} appears in the {hives} panel
  once its owner's machine announces it on this invite — it won't appear if the invite
  was withdrawn or the link is wrong." Replaces the unconditional "✓ Invite accepted …
  will appear shortly". The existing success test
  (`CreateHarnessPicker.test.tsx:514`) updated to assert the honest copy + `not("shortly")`
  — **teeth-verified** (reverting to the old copy → RED).
- **Still recommended (product decision, NOT landed):** a bounded wait — after
  `joinInviteTopic`, poll the directory for an announce on the derived topic for a few
  seconds and return `found:true|false`, so the UI can say "Found 'X' — joining…" vs
  "Subscribed, but no hive is announcing on this invite yet." This is the real cure for
  the silent-no-op; the copy fix above makes today's behavior honest in the meantime.

---

## G-003 — Discover panel never refreshes: withdrawn hives linger, new hives don't appear (S2 honesty) — ✅ FIXED

**Severity:** S2 (stale UI). Brief scenario 3: "stale/withdrawn hives disappear" — they
only disappear on **remount**, not live.

**Claim:** `WorkbenchHiveDirectoryPanel` fetches `GET /api/discovery/hives` **once on
mount** (`:71-73`, `useEffect(() => void load(), [load])`) with no interval/poll/event
refresh. A hive withdrawn (or newly announced) after the panel rendered is not reflected
until the panel is remounted. The directory is a live P2P set; the UI shows a frozen
point-in-time snapshot.

**Evidence:** `WorkbenchHiveDirectoryPanel.tsx:58-73` — single `load()` on mount, no
timer, no SSE/event subscription, no manual "Refresh" affordance.

**Fix (low-risk, in-lane):** a slow poll (e.g. 15–30s `setInterval` → `load()`) and/or a
manual Refresh button. The endpoint already excludes expired (`listDiscoveredHives`
default), so a re-fetch converges. (operator-vite file — no other lane on it.)

---

## G-004 — No live federation/sync/peer-reachability status surface in the desktop (GAP → YELLOW)

**Severity:** Not an S0 lie — there is **no** "synced/connected" claim to be false (the
good news for the S0 hunt). But the **absence** is a release caveat: a user who
published to 0 peers (G-001) or "joined" a dead invite (G-002) has **no in-app surface**
to discover they are stranded.

**Evidence:** `HiveHeaderStrip.tsx:30` header comment — "v1 SCOPE NOTE: … LIVE
Colony/Queen presence (coord), and live [federation] are out of scope." The only
hive-status surfaces are: member count (`:246`, registry), "N/M set up" (`:250-256`,
`m.hasState` local-state count), the directory-state badge (`:230-238`, declared
visibility), and the beacon consent toggle. None reflect live peer connectivity or sync
progress. There is no public-hive **browse-discover entry point** in the
`apps/operator/app` surface either — the only discover UI is the operator-vite workbench
panel (G-003).

**Why it matters for release:** combined with G-001 (overstated publish reach) and
G-002 (optimistic join), the user is misled at the two action points **and** has no
corrective status surface. Either implement a minimal live status (peer count / "0 peers
reachable" / sync state cross-checked against ground truth) or ship release notes that
state the desktop does not yet surface live federation status.

---

## G-005 — Minor: misleading "(fleet liveness)" wording + stale doc comment (S3/nit)

- `HiveHeaderStrip.tsx:253` — tooltip "`N of M set up (fleet liveness)`" derives from
  `m.hasState` (members with **local** state), not peer/online liveness. "liveness"
  reads as "online/connected"; a member can be "set up" locally while its peer is
  stranded. Reword to "members initialized" / "set up locally".
- ✅ **FIXED:** `WorkbenchHiveDirectoryPanel.tsx:7-8` header comment said join runs
  `POST /api/harness/join-link`; the code actually calls `POST /api/discovery/join-hive`
  (`:83`). Corrected the comment (doc drift, not user-facing).

---

## Positives confirmed (the honesty that holds)

- **Create visibility is correct:** `_create_from_repo.ts:357-362` — private repo →
  `invite`, public repo → `public`; never private-forced-public. Beacon consent gated to
  public only (`:536`).
- **Invite artifact is correct + stable:** the link carries `pubkey+secret+title`; the
  stored secret is **reused** on edit (`ShareHiveDialog.tsx:214-215`) so handed-out
  links never orphan.
- **Join-form error handling is solid:** malformed → instant client error (no
  round-trip); 503 → "run `gh auth login`"; every failure branch sets the error AND
  resets `busy` (`CreateHarnessPicker.tsx:584-599`) — **no stuck spinner, no silent
  fail**.
- **Directory one-click join is honest:** reports real `N/M member(s)` partial success
  and "Join failed: <err> (K joined)" (`WorkbenchHiveDirectoryPanel.tsx:94-101`).
- **ShareHiveForm copy is honest IN THE COMPONENT:** it distinguishes `>0 peers` /
  `0 peers ("becomes discoverable once peers come online")` / `announced:false ("pending
  transport")` / failure (`ShareHiveDialog.tsx:359-375`). G-001 is that the **backend
  number** it faithfully renders can be inflated.
- **No "synced while stranded" (S0):** there is no live sync/connected claim anywhere in
  the desktop UI, so the S0 false-positive cannot occur. (It's a gap — G-004 — not a
  lie.)

---

## Tests added / landed

1. **`apps/operator/app/harness/__tests__/ShareHiveDialog.test.tsx` (Vitest component) —
   ADDED 2 tests, GREEN, TEETH-VERIFIED.** Closes the `reachablePeers:0` +
   `announced:false` honesty gap (the suite previously only tested the `>0` case).
   - "announced with 0 reachable peers says registered-not-discoverable, NOT 'announced
     to 0 peers'" — and asserts NO "announced to N connected peer" text at 0.
   - "announced:false says 'pending transport', not published".
   - **Teeth:** neutered the component's `(reachablePeers ?? 0) > 0` honesty guard
     (`>= 0`) → the 0-peer test went RED rendering the exact lie *"Published — announced
     to 0 connected peers."* → restored → GREEN. (17/17 pass.)

2. **`packages/operator-core/lib/hive-publish.test.ts` (Vitest unit) — ADDED 1 test,
   GREEN.** G-001 characterization (C-001 pattern): a topic-aware `reachablePeers` fn is
   never asked for the announce's topic — `publishHiveToDirectory` calls
   `dir.reachablePeers()` with no arg, so an INVITE publish reports the global peer count
   (3), not the invite topic's real reach (0). **Built-in fix-tripwire:**
   `expect(askedTopic).toBeUndefined()` — breaks the moment anyone threads the topic; the
   `reachablePeers === 3` expectation flips to `0` when G-001 is fixed. (8/8 pass.)

3. **G-001 counting mechanism — CITED, already covered:**
   `packages/operator-core/lib/sync/hyperbee/directory-swarm.test.ts:228-235` already
   proves `openChannelCount()` (all-topics) = 3 vs `openChannelCount(HEX)` (per-topic) =
   2 — i.e. the infra is per-topic-capable and the no-arg sum is the overstatement. No
   new test needed at that layer.

4. **`CreateHarnessPicker.test.tsx` (Vitest component) — UPDATED, GREEN, TEETH-VERIFIED.**
   The existing join-form tests already cover malformed→inline-error-no-POST, 503→gh-auth
   copy, and the success path. The success test (`:514`) is updated to assert the **G-002
   honest copy** ("appears … once its owner announces it … won't appear if withdrawn or
   wrong") and `not("shortly")`. **Teeth:** reverting `CreateHarnessPicker.tsx` to the old
   "will appear shortly" copy → RED → restored → GREEN (33/33). The deeper route-level
   confirmation test belongs with the bounded-wait fix (still a product decision).

5. **Playwright e2e — DEFERRED (with reason):** a full e2e of these federated flows needs
   the live app, which **does not boot** right now (Lane A's A-001, S0). The honesty
   *logic* is correctly unit-tested in the deterministic Vitest component/unit layer (the
   README's "one framework per test" rule favors a component test for a component-honesty
   assertion). Add e2e specs in `apps/operator/e2e/` once A-001 unblocks the live app and
   a live window frees.

---

## Brief G dimension verdict: **YELLOW**

**No S0 and no S1-by-the-program-rubric blocker** in the desktop UX honesty surface —
crucially, the S0 "synced while stranded" lie does **not** exist (there is no live sync
claim to lie). But there are **three real honesty gaps the brief weights heavily**:

- **G-001** — publish overstates reach (the deceptive-publish class, resurrected for
  invite + multi-topic boxes). Brief-G class: S1.
- **G-002** — invite-link join shows fake success for expired/wrong/withdrawn links.
  Brief-G class: S1.
- **G-003** — discover panel never refreshes (stale/withdrawn linger).

…plus **G-004** — the desktop has **no** live federation-status surface, so the user
cannot detect a 0-peer publish or a dead join. All four are fixable with small,
low-risk, in-lane changes (count-by-topic, honest copy + bounded confirm, a refresh
poll), or — at minimum — release notes that state the limitations.

**Landed this lane (low-risk, in-lane, GUI-free):** ✅ G-002 honest invite-join copy
(+ teeth-verified test); ✅ G-005 doc-comment fix; + 3 teeth-verified/tripwire honesty
tests (ShareHiveDialog ×2, hive-publish ×1).

**To reach GREEN, remaining:** (1) land the **G-001** count-by-topic fix — **coordinate
with Lane E** (`hive-directory*.ts` is their lane; filed, not landed unilaterally per the
brief's coordination rule); (2) optional G-002 bounded-confirmation (product decision);
(3) **G-003** discover refresh (operator-vite, in-lane — small poll); (4) **G-004** a
minimal live federation-status surface or a documented limitation; (5) **the live
desktop pass** — now unblocked (A-001 fixed, bootable `.deb` verified), but queued behind
Brief E's live pair + run on a **sandbox Xvfb, not `:0`** (fleet-halt). None of the above
has been confirmed in the running desktop yet.
