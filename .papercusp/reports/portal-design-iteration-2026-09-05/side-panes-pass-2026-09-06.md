# Side panes and overlays design pass — 2026-09-06

Plan: `portal-design-iteration-2026-09-05#P-008` · Work-item: `WI-10000302` · Driver: `WI-2146962`.

The Portal's Accounts dock, Papercup chat, chat history/launched-session surface, notification center, app launcher, agent roster, and process manager were audited on the real `http://127.0.0.1:3081/` shell. The three defects found in that inventory are fixed in the rebuilt production artifact: provider text is normalized before notification persistence, the native process surface carries its canonical stylesheet, and the process inventory is the single flex-shrinking scroll owner at short desktop heights.

## Findings and changes

### Notification projection boundary

The live notification center initially rendered HTML entities literally in 34 of 87 Mail rows (52 encoded tokens). The defect originated before rendering: the Portal's Mail projection persisted raw provider subject/sender/snippet text, while Email's normalizer was reachable only through the Email UI.

The existing shared seam was extended instead of cloned. `cleanSnippet` now lives in `@email/contracts`, the Email UI re-exports it for compatibility, and the Portal host's notification projection normalizes title, sender, and snippet before persistence or search. Projection coverage includes encoded title/sender/snippet input and a zero-width character.

### Native process-manager stylesheet

The process popover mounted `TasksRosterPanel` directly through `OperatorSurface`, bypassing the two operator wrappers that normally import `adv-header-pills.css`. At 1440×900 the result was a structurally accessible but visually flattened 12,894px raw-text surface.

`packages/operator-ui/src/surfaces/index.tsx` now carries the panel's canonical stylesheet at the native-host facade. The existing component and class system remain authoritative; no Portal-local copy of the task-roster rules was introduced. `apps/operator/app/_lints/mounted-surface-css.test.ts` is the recurrence guard for this route-only dependency.

### Responsive process-manager containment

After canonical styling was restored, the Portal's `min(72vh, 620px)` outer dialog became 576px high at 1280×800 while the canonical panel still reserved a fixed 360px inventory scroller. That made the child roughly 590px high, created a second outer overflow, and clipped the nominally pinned footer.

The Portal host now gives `.pc-tasks-roster` the dialog's full definite height and lets `.pc-tasks-roster__scroll` flex-shrink with `min-height: 0` and `max-height: none`. The outer dialog stays hidden-overflow, the footer stays outside the inventory scroller, and `tests/shell-ui.test.tsx` guards the ownership contract.

## Current-source verification

- Notification projection: Email contract tests **5/5**, Portal projection tests **3/3**, and both relevant package typechecks passed.
- Native surface styling: mounted-surface CSS guard **6/6** and `TasksRosterPanel` suite **32/32** passed.
- Responsive host: process-popover checks **4/4** and Portal process-manager shell contract **6/6** passed.
- The concurrent Learning digest migration required by current operator source passed its component suite **107/107**, selected Learning guards, and operator-vite typecheck.
- Operator UI, operator-vite, and Portal typechecks passed. The final guarded production build compiled successfully, including TypeScript over 2,424 files.
- Portal staging contains the final responsive commits `4232f552` (`app/globals.css`) and `1733a7d8` (`tests/shell-ui.test.tsx`), with a clean checkout after git-sync.

## Immutable release proof

One guarded `pc-heavy.sh --exclusive-all-slots npm run build` published and promoted:

- release `PnRju1EfKfM0bo192lRnM-20260906213142870-3551996-469460c6`;
- Portal root digest `cb194b94ff39`;
- previous release `5g4Bnkd7UHviEmQlFhV51-20260906211608772-2480756-a9a4923e`.

`deploy-cloud-portal.sh --handoff` independently confirmed that the current release digest matched Portal source, restarted the healthy-but-stale service onto the standalone artifact, and passed its post-handoff health check. No preview stylesheet or DOM-only layout patch was injected for acceptance.

## Real `:3081` acceptance

At **1280×800 Light** with both side panes collapsed:

- outer dialog: 760×576px at y=55–631, `clientHeight = scrollHeight = 574`, `overflow-y: hidden`;
- roster: `clientHeight = scrollHeight = 574`;
- dedicated inventory scroller: 344px visible over 9,590px content, `overflow-y: auto`, `flex-grow: 1`, `min-height: 0`, `max-height: none`;
- footer: y=603–630, fully visible and 1px inside the dialog border;
- 314 live process rows remained CSS grid with six computed columns.

At **1440×900 Dark**:

- outer dialog: 760×620px at y=55–675, `clientHeight = scrollHeight = 618`;
- roster: `clientHeight = scrollHeight = 618`;
- dedicated inventory scroller: 388px visible over 9,590px content;
- footer: y=647–674, again fully inside the dialog;
- the same 314 rows remained a six-column grid.

The Dark notification center then rendered all **87/87** rows with **0 encoded entity tokens**, **0 horizontally overflowing articles**, and its long list correctly owned vertical scrolling. The browser reported no page errors or console errors during the complete acceptance sequence.

## Visual evidence

Audit snapshots for surfaces that required no change:

- [Accounts dock](side-panes-accounts-dark-1440.png)
- [Papercup chat](side-panes-chat-dark-1440.png)
- [Chat history / launched sessions](side-panes-chat-history-dark-1440.png)
- [App launcher](side-panes-launcher-dark-1440.png)
- [Agent roster](side-panes-agent-roster-dark-1440.png)

Before/after pairs for changed surfaces:

- Notifications: [before normalization](side-panes-notifications-before-dark-1440.png) · [after normalization](side-panes-notifications-after-dark-1440.png)
- Process manager styling: [before canonical CSS](side-panes-process-before-dark-1440.png) · [after canonical CSS and final containment](side-panes-process-after-dark-1440.png)
- Short-height containment: [before flex ownership](side-panes-process-responsive-before-light-1280.png) · [after flex ownership](side-panes-process-responsive-after-light-1280.png)

Every image above was reopened at original resolution. The final process-manager frames show a bounded summary, warning, search field, six-column inventory, and continuously visible footer in both themes. The final notification frame shows decoded, readable titles and snippets with the panel's own vertical scroll.

## Final state and follow-up

The acceptance browser finished at `http://127.0.0.1:3081/?app=phone` with `data-theme="dark"`, both Portal side panes `data-collapsed="true"`, Phone current, and zero open dialogs. Its Chromium process was closed.

During state restoration, a separate rail defect was reproduced: the pinned item's hover-only unpin button can intercept the primary app button's center pointer click. That defect does not invalidate the side-pane or overlay acceptance above; it is filed and owned as `EI-22549808014687820`, with a real-pointer browser regression required before closure. The final Phone restore used the existing keyboard path rather than mislabeling that workaround as a fix.
