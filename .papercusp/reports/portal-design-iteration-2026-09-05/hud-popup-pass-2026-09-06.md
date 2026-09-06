HUD conversation popup — completed design pass, 2026-09-06

Work: WI-2147225. Plan: portal-design-iteration-2026-09-05, P-009 / D-005. Source request: session 6278c564-a66c-471f-8b69-e32297a1aafc, turn 6, repeated in this successor session. The original AUTO design iteration continues under WI-2146962.

Orders, Activity, and Fleet now use one labeled collapse control in their own panel headers. A collapsed panel leaves a labeled edge tab in its original position. The conversation header uses normal layout for session identity/status and window actions. URL state, deferred panel loading, directional chevrons, and keyboard focus survive collapse/reopen. At narrow widths Activity leaves the Fleet tab exposed.

Live portal release: `Y2gn8mngOrffHZkWv5LHC-20260906011114474-3941600-d37fced7`. The compiled client contains the panel controls, new heading, and final Activity inset. `bash apps/operator/scripts/systemd/deploy-cloud-portal.sh --handoff` verified the source digest and completed its health check. Acceptance was exercised on the actual native portal at http://127.0.0.1:3081/. This is a portal shipment claim, not a claim about the separate operator green-main release.

Verification:

| Case | Result |
| --- | --- |
| Five focused Vitest suites | 319 tests passed, no skipped tests |
| Final scoped TypeScript check | All six changed TypeScript/test files clean; unrelated baseline errors remain elsewhere |
| Light, 1440×900 | Popup clientWidth and scrollWidth both 1302; panel controls outside conversation |
| Light, 1280×800 | Three collapsed edge tabs; popup clientWidth and scrollWidth both 1058 |
| Each panel closes and reopens | Exactly one control per panel; focus follows the control; aria-expanded reflects state |
| Activity overlay at laptop width | Fleet button remained reachable by elementFromPoint hit test |
| Full window | Popup width 1280 equals viewport; all three panel controls remain present |
| Full screen | document.fullscreenElement is session-chat-modal; all three controls remain present |
| Dark, 900×800 | Popup clientWidth and scrollWidth both 836; three reachable edge tabs |
| Dark, 2300×1000 | Orders/Activity/Fleet are static columns of 272/300/248 px; one header control each; popup clientWidth and scrollWidth both 1818 |
| Theme restoration | UI restored System; GET /api/preferences confirmed theme=system; data-theme removed |
| Whitespace | git diff --check clean |

Actual screenshots (not mockups): [before](hud-popup-before.png), [light 1440](hud-popup-light-1440.png), [collapsed laptop](hud-popup-light-collapsed-1280.png), [compact dark](hud-popup-dark-900.png), [wide dark](hud-popup-dark-wide.png). Viewports differ between cases; these are layout/interaction witnesses, not a pixel-diff comparison. Live panel data can still be loading when a layout capture is taken.

Changed source: SessionChatModal.tsx, PanelToggleButton.tsx, FleetPeersRail.tsx, AgentOrders.tsx, AgentDossier.tsx, chat-controls.css, and SessionChatModal.test.tsx, all under apps/operator/app. Existing component headers remain available to their other hosts through the default header content. Regression tests additionally cover the current historyOwner URL contract, verified against use-owner-session-chat.ts before repairing four stale expectations.

Separate preexisting defect: the Decisions shelf can fail its plans.attention read with upstream HTTP 400. It was present in the before capture and is owned as WI-2147274 for the next continuous iteration. No claim that this data failure was fixed by the layout pass.

Test logs remain at /tmp/wi-2147225-test-final.log and /tmp/wi-2147225-types.log; build/handoff logs at /tmp/wi-2147225-portal-build-final.log and /tmp/wi-2147225-handoff.log. Re-run the five suites with npm run test:file, then npm run lint:tsc -- --files=<the changed TypeScript paths>. The temporary Tauri baseline verifier was stopped.
