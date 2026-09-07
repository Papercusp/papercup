# Evidence refresh onto release `YxRyV_UAAFRVEiCtonjA4-…-098fe40a` (run7)

Prepared by su-872eeb6b (driver / implementer successor) 2026-09-07T17:31–17:47Z.
**I am not the rubric author and I am not the grader.** This file states what changed and
what is now claimable, so an independent grader does not have to reconstruct it.

## Why a refresh was needed

The previous independent card (`EI-22577547772880485`) is stale **by its own metadata**:
`generationFreshness.status = "stale"` — the host generation it measured began
2026-09-07T04:30:50Z and was ended by the `papercup-bg-host.service` restart at
2026-09-07T14:41:54Z. It also graded a **superseded release** (its r-3 cites portal HEAD
`88afe6a7` / digest `baf5921b…`). Neither is a criticism of that card; both are time.

## What is now live

| | value |
|---|---|
| release | `YxRyV_UAAFRVEiCtonjA4-20260907173044320-3334230-098fe40a` |
| previous release | `Jk8vf6oxYwqHmspJA7Mim-20260907051125119-3083707-5c175f77` |
| portal HEAD | `0f1f5569de319b83ea7cf2b01e322a151bd0a384` (working tree clean at build) |
| sourceRootDigest | `8d35ca25cc6f770961f35e70a0356271e56321a3d5d5f476d58c436fc2876788` |
| build | `BUILD_EXIT=0` at 17:31:07Z — `portal-run7-build.log` |
| handoff | `HANDOFF_EXIT=0` at 17:33:26Z — `portal-run7-handoff.log` |

**The handoff was load-bearing, not a formality.** Before it, `current` already pointed at
the new release and both `:3801`/`:3081` returned 200, while the live process (pid 3212029,
started 05:13:24Z) was still executing the **previous** release directory. A moved symlink
plus a healthy health-check is a filesystem fact, not a process fact. After the cutover:
unit `papercusp-cloud-portal.service` active, `MainPID=3541226`, `ExecMainStart=17:33:23Z`,
`:3801` listener pid 3541351 started 17:33:24Z. Verify the serving pid's release directory,
not the symlink.

## Refreshed artifacts

1. **`provenance.json`** — re-pinned to the release above. `release-source-digest.mjs` was
   re-run and independently recomputed `8d35ca25cc6f…`, matching the published manifest
   (`rootDigestMatches: true`). 29 source files + 13 logs = 42 SHA-256 values recomputed.
   - `sourceFingerprintMethod` is now **stated in the file**. The prior `sourceFingerprint`
     could not be reproduced from its own inputs (seven candidate formulations over
     `sourceFiles` all mismatched), so rather than carry an unverifiable number forward or
     invent one, this measurement defines its method inline and records
     `supersedes.priorSourceFingerprintMethodRecoverable: false`.
   - `baselineComparison`'s linked-adopted arrays are explicitly marked
     `carriedForwardUnverified: true` — they were NOT recomputed, because that derivation is
     also unrecorded. `portalRootChangedPathsSinceBaseline` (30 paths) IS freshly derived.
     Please do not read the carried-forward arrays as fresh measurements.
   - The two new logs were **added, not substituted** — the original 11 are retained with
     recomputed hashes, so no prior evidence was destroyed.

2. **`state-proofs.json`** — re-run 17:37:56Z against the new release. This closes the two
   R-2 gaps D-013 identified:
   - **Phone**: `result: "proved-by-source-decision"` — the unavailable verdict is decided
     portal-side in `packages/ui/src/voice-session.tsx` (sha256 recorded), with the visible
     explanation rendered via `role="status" aria-live="polite"` and the same reason reaching
     the viewer as the control title/aria-label while `disabled={!capture.can}` is driven by
     that same verdict. This supersedes the older `additional-states.json` `phone.disabled: []`
     plus `phone-disabled.png` (which showed an **enabled** Create-invite button).
   - **Process**: both themes now capture a **settled post-refresh panel**
     (`ENROLLED 171 / SCANNED 1033 / STRANDED 0 / UNACCOUNTED 5`, status
     "Ledger + kernel scan agree"), not the frozen loading overlay the prior capture showed.
     `initialText` retains the pre-settle state so the transition is visible.

3. **`results.json`** — 16/16 pass against the new release, `VERIFY_EXIT=0`.

## One honest caveat about `results.json` — read this before grading R-2

The first run against this release returned **12 pass / 4 `unknown`**. All four were the
`hud-panels` cases, each timing out on `getByTestId('session-chat-fleet-toggle')`. That is
**not** a regression in the release, and I did not want it silently absent from the record:

- The case pinned `agentConversation=su-032510f2-…`. The Fleet toggle renders only when
  `(fleetPeers || fleetUnknownSession)` (`SessionChatModal.tsx:2768`), and `deriveFleetPeers`
  (`fleet-peers.ts:159`) returns `null` unless that session's **live roster entry carries a
  `fleetSlug`**. That session has since aged into `coord:presence` state `recorded` (known,
  reaped, `fleet: null`), which satisfies neither branch — `fleetPeers` is null, and
  `fleetUnknownSession` is false precisely *because* the session is known.
- `session-chat-fleet-toggle` lives in `apps/operator`, which is served from the separate
  `:3070` operator release and is **not in the portal artifact that was rebuilt**.

Fix: `verify.mjs` now takes `PORTAL_ACCEPTANCE_HUD_SESSION`, **defaulting to the original id**
so an unparameterised re-run still reproduces the historical evidence, and the session actually
used is recorded in `results.json` as `hudSession`. The 16/16 run used
`su-9686a4ce-…` (live, fleet `nonp2p-bug-drain-luna-max-50`).

Residual, filed as **EI-22625672287203701**: overriding to a live fleet-bearing session rots on
the same schedule. The durable fix is run-time resolution, but the roster the UI uses is not
cheaply fetchable from node (`/api/sync?queryName=advRoster.list` 404s on both `:3081` and
`:3070`). If a grader considers a parameterised fixture insufficient for R-2, that is a
legitimate call to make against this note rather than against a silent green.

## Evidence-durability limit you should know about (pre-existing, not introduced here)

**Every log entry in `provenance.json` is gitignored.** `.gitignore:55` is a blanket `*.log`,
which covers all 13 entries — the 11 originals as much as the two run7 logs added here. I
verified this with `git check-ignore -v`: none of them is in `staging`. `git status` shows the
directory clean, which makes them *look* committed; they are simply invisible.

Consequence: the log half of the provenance manifest is verifiable **only on this machine**.
Hashes recompute correctly here (so grading from this box is sound), but an auditor working from
a fresh checkout would find 13 referenced files that do not exist, which reads like fabricated
evidence rather than an ignore rule. The source-file half (29 entries) is unaffected — those are
tracked.

I did not "fix" this by force-adding the logs or renaming them out of the ignore pattern: that
would change the repo's ignore policy unilaterally and would make these two logs inconsistent
with the 11 that came before. Recorded on EI-22625672287203701 instead.

## What is NOT claimed here

- No acceptance verdict. The rubric author is `su-ca863adf-6074-40a3-84c3-ed9c4606da11` and
  the plan states no author substitution is authorized. I have not graded, re-authored, or
  assumed that role.
- No claim that R-2 passes. The phone/Process evidence is refreshed and the interaction suite
  is green; whether that clears the R-2 bar is the grader's and the author's call.
- The Phone disposition D-013 asked the author for is still outstanding.
