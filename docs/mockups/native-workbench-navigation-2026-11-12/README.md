# Workbench navigation studies

Open `index.html` directly in a browser. All scripts, styles and sample data are local; no server, package installation, live agents or global shortcuts are needed.

- A / Quick Switch: search open conversations and transcript passages, preview with arrows, activate with Enter, cancel with Escape. History requires an explicit Resume action.
- B / Conversation Rail: persistent conversation list beside the vendor-terminal visual. Drafts and context-sidebar visibility are retained independently per session.
- C / Task Spaces: task groups with explicitly associated sample windows and conversation drill-in.

Try `keyboard focus`, `GlazeWM`, an unavailable Build host, the Windows lab session, and the report link. Ctrl/Cmd+K summons the simulated switcher. The report link demonstrates a sample terminal-to-desktop handoff; it is not a live integration.

Maintained verification: `npm run test:file -- scripts/native-workbench-navigation-mockup.test.mjs`. Screenshot generation: `node docs/mockups/native-workbench-navigation-2026-11-12/render.mjs`. Tests use the project's existing `node:test` and Playwright dependencies and temporary-directory preflight.

These HTML studies reuse the previous native desktop gallery convention. `control.text` in the design registry informed the search control; the browser artboard is an intentional raw escape hatch for a native design study. Production native integration, OS-level focus, latency, credentials and installed-artifact shipment require independent acceptance.

Plan: `quick-access-search-launcher-2026-10-26#D-024`. Design work item: WI-6554700010047645. Terminal-to-desktop integration: WI-6554700010047647.
