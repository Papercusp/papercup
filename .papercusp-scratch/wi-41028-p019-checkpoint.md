# WI-41028 / P-019 Wave B gate — checkpoint (local; MCP bearer invalid at 19:2xZ)

> Written to disk because `mcp__papercusp-su__*` began returning
> `request_rejected: superuser_invalid_bearer` for EVERY verb (checkpoint, loop:status).
> RE-SUBMIT this as `work_items:checkpoint { id: 'WI-41028' }` the moment the bearer recovers.

## Scope correction (my carry note was under-scoped)
P-019 is **four** adapters, not three: blocked-by P-015..P-018 =>
`youtube`, `facebook-pages`, `instagram`, `threads`. The carry note omitted YouTube.

P-019 has **two halves**, and the first is the substantive one:
- **(A)** Google-scope consent upgrade verified non-destructive to the live Gmail + Calendar lanes.
- **(B)** Every Wave B adapter passes the P-003 conformance kit, unmodified.

## Carry note was WRONG about the git-log assertion
`wave-a-gate.test.ts` contains **no** git-log assertion. It asserts:
1. kit files (`conformance.ts`, `adapter-contract.ts`) name no Wave A platform in
   **executable** code (local `stripComments` + a CONTROL that it strips prose and keeps code);
2. exactly one module exports `runSocialAdapterConformance`;
3. each `<platform>-adapter.test.ts` imports `'./conformance'` and calls the runner.

So "the kit is unmodified" is a **content** property, not a git property. There is nothing to
restate — Wave B has to be reasoned fresh.

## Measured this session (each positive-controlled)
- Wave B platform names (`youtube|facebook|instagram|threads`) appear **zero** times in
  `conformance.ts` and `adapter-contract.ts` — not even in prose. Wave A names DO appear
  (bluesky 2+1, mastodon 1+1, reddit 0+1) as the documented prose exemptions.
  Positive control: `grep -c runSocialAdapterConformance conformance.ts` = 1, `cursor` = 32.
- Registry waves: A={bluesky,mastodon,reddit} B={youtube,facebook-pages,instagram,threads}
  C={linkedin,tiktok,x-twitter}. `listSocialPlatformsByWave('B')` exists => the gate can
  DERIVE its subjects instead of hand-listing them.
- READ adapters declare `readonly platformId = '<id>' as const`; WRITE adapters declare none.
  That is an exact **derived** file->platform discriminator, needing no naming convention.
  Wave B read modules = 6: `youtube-activities`, `youtube-comments`, `facebook-posts`,
  `facebook-comments` (both `facebook-pages`), `instagram-comments`, `threads-conversation`.
  All six already call `runSocialAdapterConformance` in their sibling tests.
- Kit has 9 checks, 2 skippable (`conformance.ts:259,315`).

## THE REAL HOLE (half A)
`include_granted_scopes=true` is set at `providers.ts:273` in `buildAuthorizeUrl` and is
asserted by **no test anywhere** (grep across packages/apps/libs: 1 source hit + 1 registry
prose hit, zero test hits). The registry's own prose (`platform-registry.ts:569`) leans on it:
"so the upgraded token retains the landed Gmail and Calendar grants (D-019)".

Delete that one line and the first YouTube incremental consent returns a token scoped ONLY to
youtube => `googleGrantedScopes()` (`personal-vault.ts:207-221`) returns that **non-empty**
stored set => the `GOOGLE_WORKSPACE_SCOPES` fallback does NOT fire => gmail + calendar
`requiredScopes` are missing => both flip to `needs-consent` / `connected:false`.
That is exactly P-019's named regression, and it is currently unguarded.

Already guarded elsewhere — do NOT duplicate: `providers.test.ts:96-134` pins
`GOOGLE_WORKSPACE_SCOPES` to the 4 Gmail/Calendar/Contacts scopes, plus a D-019
requestable-but-not-presumed property test over a **hand-maintained** list of 3 scopes.

## Plan
`wave-b-gate.test.ts`:
- **Half A** — pin `include_granted_scopes`; plus a registry-DERIVED version of D-019
  (no Wave B scope may enter the presumed-granted set; any `googleapis.com` Wave B scope
  must be in ALLOWED). Derived beats the hand list: it covers a future Wave B platform
  the day it is added.
- **Half B** — no Wave B platform name in kit executable code; every DERIVED Wave B
  read-adapter module is kit-run. That last one is the genuinely Wave-B-specific property:
  Wave B platforms have MULTIPLE read adapters each, so a one-file-per-platform check
  (which is all Wave A needed) would pass while a second adapter silently skipped the kit.
- Extract `stripComments` to a shared fixture so both gates share one instrument.

## Filed en route
`EI-21272716444076170` — the `youtube` capability can never read `enabled:false`
(`googleCapabilities` filters sources to `GOOGLE_WORKSPACE_SOURCE_KINDS`, which excludes
`youtube`). A real P-015 defect, NOT P-019's regression, deliberately out of scope.
