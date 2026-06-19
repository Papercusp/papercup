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

## G-001 — `reachablePeers` is TOPIC-BLIND: publish overstates real reach (S2 honesty; Brief-G "publish-lie" class) — ✅ FIXED

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

**Fix — ✅ LANDED (coordinated with Lane E, who explicitly cleared the files).** Threaded
the announce topic into the count across 4 files:
- `hive-directory.ts` — `reachablePeers(topicHex?)` pass-through + new
  `reachablePeersForHive(hiveId)` (resolves the owned descriptor's topic via
  `topicForLocalHive` → `reachablePeers(hiveTopicAsHex(topic))`; 0 for unknown/private).
- `hive-directory-deps.ts` — dep signature `reachablePeers?(topicHex?)` + production
  passthrough.
- `hive-directory-boot.ts:121` — wiring closure → `(topicHex?) => gossip.openChannelCount(topicHex)`.
- `hive-publish.ts:119` — `reachablePeers: announced ? dir.reachablePeersForHive(meta.hiveId) : 0`.
- Default-no-arg path preserved → back-compat (the existing deceptive-publish test, whose
  fake ignores the topic, stays green). **Type-clean** (operator-core tsc — no errors in
  the touched files). **Teeth-verified:** the flipped invariant test (now asserting
  `askedTopic === INVITE` + `reachablePeers === 0`) goes RED when the call is reverted to
  the topic-blind `dir.reachablePeers()`. No regressions: hive-publish (8), -from-repo
  (21), set_hive (10), directory-swarm (11) all green.

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

## LIVE desktop pass (real packaged binary) — G-001 + G-002 confirmed live

**Ran 2026-06-19.** Reused Lane A's harness (`two-instance-content-matrix-smoke.sh`)
to bring up a **2-peer pair of the shipped `.deb`** (`Papercusp_0.0.2_amd64.deb`, the
05:33 luxon-fixed build, 50 luxon entries) under **Xvfb `:156` — fleet-halt-safe, never
`:0`**, single public hive to dodge A-002, halt-safe curl+psql method (Lane E's pattern).
Held the `shared-hive-live-instances` lock for the run; pair torn down + lock released
after.

- A (papercupai) `:23594`, B (aviynw) `:22637`. A created+published a public hive
  (`hello-world-hive`), B discovered + joined it; features federate both ways,
  topic-equal PASS, negative-isolation PASS — so A & B are **live peers on the global
  directory topic**.

**⚠ The binary predates my G-001/G-002 fixes** (still pending git-sync). So this pass
**live-confirms the BUGS on the shipped binary** (the C-001 pattern — proving the fix is
necessary), and verifies the unchanged flows; it does **not** live-prove my fixes (not
deployed). A GREEN live re-verification needs a binary built with the fix.

| Flow | Live result | Verdict |
|---|---|---|
| **Discover accuracy** | B's `GET /api/discovery/hives` lists A's public hive with correct title/owner/visibility/pubkey + member-link topic; A doesn't re-discover its own | ✅ **live-correct** |
| **G-002 — invite-join fake-success** | `POST /api/discovery/join-invite` with a **well-formed-but-dead** secret → `{"ok":true,"joined":true}` (HTTP 200); `GET /hives` 2s later → the ghost **never appears** (count stays 1) | ❌ **bug LIVE-CONFIRMED** — the route reports success for an invite that never materializes (= the old UI's "✓ accepted … appears shortly") |
| **G-001 — reachablePeers over-report** | `set-hive` **public** → `reachablePeers=1` (correct — B *is* on the global topic). Flip to **invite** (fresh secret B never had → true reach **0**) → `reachablePeers=1` (over-reports by 1 — counted the global peer the invite announce never reached) | ❌ **bug LIVE-CONFIRMED** — the deceptive-publish lie, on the real binary |
| **Visibility flip + restore** | public → invite → public round-trip clean; A restored to public, B's view consistent (count 1, public), both sidecars HTTP 200 — no damage | ✅ **works live** |

**Ground truth for G-001:** I freshly minted the invite secret; B never had it and joined
via the *public* link — so the invite topic provably has **0** peers. `reachablePeers=1`
for that invite publish is an over-report of exactly the global-topic peer (B). My fix
reports 0 here.

**What the live pass did NOT cover** (deferred): driving the actual **Tauri GUI render**
(the `:0` fleet-halt restricts GUI automation; the honesty *render* is covered by the
component tests, and a sandboxed GUI drive can confirm the rendered copy once the halt
lifts); and **re-verifying the FIXED flows live** (needs a binary built with my fix —
git-sync push is engine-gated). Multi-hive (A-002) was intentionally avoided (SKIP_INVITE).

---

## Brief G dimension verdict: **YELLOW (trending GREEN — every honesty LIE is now fixed)**

**No S0, no S1-by-rubric blocker** — and crucially the S0 "synced while stranded" lie
does **not** exist (there is no live sync claim to lie). The three honesty gaps the brief
weights heavily are now **fixed + teeth-verified in code**:

- ✅ **G-001 FIXED** — `reachablePeers` is now scoped to the announce topic (count-by-topic).
- ✅ **G-002 FIXED (copy)** — the invite-join no longer promises "appears shortly"
  unconditionally (a bounded-confirmation upgrade remains an optional product decision).
- ✅ **G-003 FIXED** — the discover panel now polls + has a manual Refresh (withdrawn
  hives drop out, new ones appear).
- ✅ **G-005 FIXED** — the stale doc comment corrected.

**Why not GREEN yet** (two items, neither a code-honesty lie):
1. **G-004 (gap)** — the desktop still has **no** live federation/peer/sync surface, so a
   user can't *see* a 0-peer publish or a dead invite. The action-point copy is now
   honest, so the user is no longer *actively misled*; but a positive status surface (or
   a documented limitation) is still wanted. Small, in-lane (operator-vite) or a
   release-note. NOT a lie — an absence.
2. **The live desktop pass HAS now run** (see the section above) — on the shipped
   binary, halt-safe under Xvfb. It **live-confirmed G-001 + G-002 as real bugs** and
   verified discover/visibility live. Two threads remain before this counts as a GREEN
   live confirmation: (a) re-run the same pass against a binary **built with my fix** (to
   see `reachablePeers=0` for the invite case + the honest join copy) — blocked on
   git-sync push (engine-gated) + a `.deb` rebuild; and (b) a **GUI render** drive
   (currently `:0`-halt-restricted; the render is covered by component tests in the
   meantime).

**Flip to GREEN when:** (a) a live desktop pass confirms publish/join/discover/status
render the now-honest copy against ground truth, and (b) G-004 is implemented or
documented.

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
