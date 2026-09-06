# Responsive and accessibility pass — 2026-09-06

Plan: `portal-design-iteration-2026-09-05#P-010` · Work-item: `WI-10000317` · rail defect: `EI-22549808014687820`.

## Outcome

The Portal shell now keeps the pinned rail item's primary activation target separate from its revealed unpin action at both required compact viewports. Host-owned geometry, focus, motion, and contrast rules explicitly win the later mounted Operator primitive baseline. The rebuilt release was promoted and handoff-verified on the real `:3081` service.

## Root cause and durable fix

The mounted Operator stylesheet loads after Portal CSS and contributes a zero-specificity native-button baseline. The rail unpin control therefore grew from its nominal 20×20 box to 22×26 with padding, and its hit area covered the sibling app item's center. The fix keeps the existing two-button interaction and makes the host rule explicit:

- `.rail-unpin` owns width/height plus min-width/min-height, zero padding, and line-height;
- focus-visible owns a 2px accent outline;
- the transition is present only for no-preference motion and is disabled under reduced motion;
- hover/focus accent text uses `--accent-on-soft`, not `--accent`, so dark-mode text clears AA on `--accent-soft`.

The browser regression loads the real later Operator primitive cascade, performs real pointer clicks, checks keyboard reach, and exercises both 1280×768 and 390×768.

The same focused pass exposed stale Portal-local Ask renderer guards left behind by the shared PapercupChat migration. Those rules were removed (chat-card rules remain Portal-owned), the report typography sentinel now guards the shared renderer seam, and the contrast guard measures the live Portal custom-property mapping for assistant/user markdown and the capability notice in light, explicit-dark, and system-dark themes.

## Source verification

- Focused Portal Vitest: **241/241 passed** across the contrast, shell, rail, host-state, placeholder, shared-chat, report-typography, and Portal Ask suites.
- Portal typecheck: **clean**, 0 errors across 2,424 files.
- Production-cascade Playwright: **5/5 passed** in `e2e/portal-more-sections.spec.ts`.
- `git diff --check`: clean for the Portal source/test diff.

## Build and shipment evidence

One guarded `pc-heavy.sh --exclusive-all-slots npm run build` completed successfully:

- release: `n1RY3Pvr1DwJA5nl_lJvU-20260906225252809-1256025-41f9cfc4`;
- source-root digest: `120073718b575099f914cf86e654d5d650b2095af762aba97c114ac8da30c526`;
- previous release: `PnRju1EfKfM0bo192lRnM-20260906213142870-3551996-469460c6`.

`deploy-cloud-portal.sh --handoff` independently confirmed the source digest, restarted the healthy-but-stale service onto the standalone artifact, and passed its health check. No preview stylesheet or DOM-only patch was injected for acceptance.

## Live acceptance on `:3081`

The fresh headless browser selected the first rendered pinned rail item (Calendar; no hard-coded app assumption), then hovered its opposite corner so the secondary control was revealed.

At **1280×768 Dark**:

- primary center hit remained owned by the primary `.rail-item`;
- unpin computed geometry was **20px × 20px**, padding **0px**;
- real pointer click kept the selected app at Calendar;
- after Tab, Unpin Calendar was focused with a solid 2px outline;
- after 180ms, focus color resolved to rgb(111, 188, 172) and the reduced-motion probe resolved to **0s**;
- no page errors or console errors.

At **390×768 Dark**:

- the same center-hit, 20×20, zero-padding, keyboard-focus, and reduced-motion checks passed;
- no page errors or console errors.

The screenshot blankness guard reported all three captures as rendered content.

## Visual evidence

- Before (pre-fix, 1280×768): [rail-before-dark-1280](responsive-accessibility-rail-before-dark-1280.png)
- After (rebuilt release, 1280×768): [rail-after-dark-1280](responsive-accessibility-rail-after-dark-1280.png)
- After (rebuilt release, 390×768): [rail-after-dark-390](responsive-accessibility-rail-after-dark-390.png)

The before frame is the genuine pre-fix live capture from the pointer-interception reproduction. A retained old release could not be launched concurrently for a second “before” mobile frame: its standalone entry attempted to start a second Postgres against the live data directory and masked the lock error with an undefined dereference. That separate runtime defect is filed as `EI-22554751188135570`; no synthetic mobile-before image is presented as live evidence.

## Follow-ups discovered during this lane

`EI-22554378117333050` was corrected after direct verification: Next printed a tsconfig “reconfigured” message during the guarded build, but the source-integrity root digest and post-build tsconfig diff were unchanged. The surviving issue is a misleading no-op warning, not a tracked-file mutation.
