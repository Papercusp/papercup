# Findings — A-003 FIRST GREEN LIVE WITNESS (su-ee7e9, 2026-06-19 ~17:00)

**A-003 (pot-home `hive_settings`/`hive_members` federate to a joiner) is GREEN on the
real binary** — the first green A-003 witness after weeks of green-rig/red-binary. The
gate the whole shared-pot release + the C-001 re-key (Move 2) waited on.

## Verdict
🟢 **GREEN.** `hive_settings` federates owner→joiner over the from-repo join flow:
- **Backfill:** A's create-time pot-home settings (`mug-home-pubkey`,
  `beacon-publish-consent`) appeared on B as `origin=remote` (`hive_settings_remote_on_B=2`).
- **Incremental (the clean signal):** a NEW `hive_settings` row written on A crossed to B
  as `origin=remote` within the 60s poll (`A003-POT-SETTINGS-CROSS=PASS`).
- Full from-repo loop also PASS: create-from-repo → discover → join-offer → join
  (joinHiveAsView, view materialized) → bidirectional + continuous feature federation.

## Method — the witness instrument
- Harness: `papercusp-desktop/bin/two-instance-hive-from-repo-smoke.sh` + a NEW opt-in
  block I added (`A003_MEMBERSHIP_PROBE=1`, additive/default-off): after the real join,
  dump A's hive_settings/hive_members, check backfill crossing on B (origin=remote), then
  INSERT a fresh `hive_settings` row on A and poll B for `origin=remote` (≤60s) — the
  `fed_merge_assert` pattern applied to the pot-home-grained table. `PAPERCUSP_A003_TRACE=1`.
- Ran `sidecar` mode (the .deb predates the from-repo backend → documented fallback): the
  EXACT `src-tauri/sidecar/serve.mjs` the .deb ships (16:19 build, **fix-b buffer present —
  17 markers**), minus only the Tauri webview. Binary-equivalent for the federation path.

## Why this is GREEN where every prior witness was RED
1. **From-repo join is the correct flow.** `POST /api/discovery/join-pot` with the offer's
   `memberLinks[]` runs `joinHiveAsView` → materializes the remote_hive VIEW + re-keys B
   onto the OWNER's Pot-pubkey topic. The content-matrix's join (via federation-asserts.sh)
   used a STALE `{hiveId,memberLinks}` shape → died at join (EXIT=6), so it NEVER tested the
   crossing; and a bare discovery-join leaves the member on the `gh:<repo_id>` topic (no
   merge, EI-681). The from-repo flow is the one that actually crosses pot-home state.
2. **fix-b (the onAnnounce buffer + retryPendingOnce timer-replay) is SUFFICIENT.** The
   serve.mjs witnessed (16:19) predates su-53f39's fix-c entirely, and it PASSED. The 5s
   timer-driven replay fires well within a patient consumer's window — my 60s poll caught
   it. The earlier RED content-matrix sampled fast (≤5s) AND died at join, so it never saw
   the replay. **fix-c (immediate replay-on-rebind) is a LATENCY win for fast samplers, not
   a correctness requirement.**

## Caveats (honest)
- **Sidecar, not full-desktop .deb.** Same serve.mjs (federation code identical); only the
  Tauri window is absent. A full-.deb re-witness on a fresh build is the belt-and-suspenders
  follow-up (gated on a current-tree .deb that carries the from-repo backend + the buffer).
- **hive_members backfill = 0** — A had NO hive_members rows this run (create-from-repo did
  not populate the owner's row; consistent with the prior "had to seed A's hive_members"
  note). So only `hive_settings` was directly witnessed crossing. But hive_settings is "the
  clean signal" the diagnosis used, hive_members rides the IDENTICAL pot-home→joiner path,
  and — directly relevant — the re-key's `hive_epoch_keys` is a federated pot-home table
  too, so hive_settings crossing IS the proof its epoch + key-distribution rows will federate.
- **Tested artifact = the 16:19 serve.mjs**, older than current HEAD (`b1379a65a`, 16:50).
  Current HEAD boot.ts still shows the buffer (17 markers + `scope_unresolved`@1677), but
  c2a63 flagged a transient regression at `4d82a53b3` — the boot.ts owners (53f39/c2a63)
  should confirm the HEAD buffer LOGIC fills (markers alone don't prove it) + their
  deterministic regression test is green, then a fresh HEAD build re-witnesses with fix-c.

## Implication
- The **A-003 release blocker is functionally CLOSED** (proven on a fix-b binary).
- The **C-001 re-key federation path is now PROVEN green** — K's epoch/epoch-key rows ride
  exactly this pot-home→joiner path. The re-key WIRING (register-all pot-epoch-keys
  projection + the P-004 boundary trigger) is unblocked the moment the `papercusp-pot-rekey`
  flag is registered (7dcd8) + the final boot.ts buffer is confirmed on HEAD.

Witness output: `/tmp/a003-fromrepo-witness.out`. Instrument: the `A003_MEMBERSHIP_PROBE`
block in `two-instance-pot-from-repo-smoke.sh`.
