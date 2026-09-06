# Deploy evidence — portal quick-panel palette (plan portal-quick-panel-palette-2026-09-06, WI-1965083 unit 5)

Author: su-e8071b9d-b6aa-4d2b-ba3f-05de514f9d7b · written 2026-09-06T01:56Z (UTC).
All paths absolute. Evidence files live beside this one under
`/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/`.

## What shipped

- Operator (papercusp tree `/home/marsh-office/papercupai-workspace/papercusp`): surface kind
  `quick-panel` in `packages/operator-ui/src/surfaces/index.tsx` + `packages/operator-ui/src/surfaces.d.ts`,
  mounting `apps/operator/app/quick-panel/page.tsx` with the two additive props `chatSidebar={false}` and
  `queryPrefix="qp"` (D-003); `apps/operator/app/quick-panel/PromptsTab.tsx` prefixes its nuqs keys.
- Portal (sibling checkout `/home/marsh-office/papercupai-workspace/portal`): panel kind `quick` +
  `panelForChord` in `packages/ui/src/shell-model.ts`; trigger button `.quick-panel-trigger` (⌘J) beside the
  launcher, `QuickPanel` panel frame and the ⌘K/⌘J chord in `packages/ui/src/shell.tsx`; panel styling in
  `app/globals.css`; `/internal/docs/*` proxied on the portal origin — `apps/host/src/api.ts`
  (`app.use("/internal/docs/*", requireSession)` + passthrough) and the Next catch-all
  `app/internal/docs/[...path]/route.ts` (D-004).

## Build + deploy chain (P-005)

- Launched 2026-09-06T01:44Z as `capability:bash` background task `0mtp58hz9tpcgik5l1w`
  (pc-heavy `npm run build` → `bash apps/operator/scripts/systemd/deploy-cloud-portal.sh` handoff).
- Log: `/tmp/e8071-u5-build-deploy-1.log` — `BUILD_RC=0 2026-09-06T01:42:05Z`, `DEPLOY_RC=0 2026-09-06T01:42:19Z`,
  `CHAIN_END 2026-09-06T01:42:19Z`, `portal_standalone_promoted:` →
  `/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/.portal-runtime/portal/releases/fUOvyDt86Wsh3rFfEKtC9-20260906014153337-1682634-fb1aab0b`.
- Served release (2026-09-06T01:44:14Z): `:3801` backend pid 1740477, cwd = that release;
  `grep -rl --include='*.js' quick-panel-trigger <release>` → 2 chunks. `curl :3081/api/health` → 200.

## Live probe on :3081 (P-004 + P-005)

Driven with the verdict daemon (never :3055/:3070). Two scripts, two evidence files:

1. `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/probe.sh`
   → `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/live-probe-20260906T014446Z.txt`
   - A ✓ `?app=home&panel=quick` renders `section.shell-panel--quick[role=dialog]` aria-label "Quick panel",
     820×600 at 1280×720, tabs Prompts*/Brainstorm/Docs, `.pc-qp` position static, no `.op-chat-sidebar`,
     body lacks `has-op-chat` (D-001, D-003). Prompts tree: 2 rowgroups, 2 treeitems, search box present.
   - B ✓ sync read `GET /api/agent-mcp/saved-prompts` → 200, 2 prompts.
   - E ✓ `.quick-panel-trigger` aria-label "Open quick panel", kbd ⌘J, DOM-after the launcher trigger; click →
     `panel=quick`, `aria-expanded=true`; header close → panel param gone.
   - F ✓ ⌘J keydown toggles `panel=quick` on/off; ⌘K opens `panel=launcher`; ⌘J from there SWITCHES to
     `panel=quick` (one exclusive slot); exactly one dialog open ("Quick panel").
   - H ✓ D-010 write: `POST /api/agent-mcp/saved-prompts/node` same-origin → 200 (id c08d4882…), remove → 200;
     sibling-origin `http://localhost:3081` → 200 (id 1d1624ed…), remove → 200. **No loopback-sibling CORS
     residue for this surface** — WI-2147102 NOT linked as a blocker.
   - C/D/G in this run reported no tab switch: instrument error — Radix `Tabs.Trigger` activates on
     mousedown, not on a synthetic `element.click()`. Re-run below.
2. `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/probe2.sh`
   (pointerdown/mousedown/pointerup/mouseup/click dispatch)
   → `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/live-probe2-20260906T014940Z.txt`
   - C' ✓ Brainstorm: URL `?app=home&panel=quick&qptab=brainstorm&qpbs=pot-verify` (qp-prefixed keys, D-003);
     `.pc-qp__brainstorm` + `.pc-qp__bsbar` mounted; tab data-state active.
   - D' ✓ Docs: URL `qptab=docs`; `iframe.pc-qp__docsframe src=/internal/docs/search-palette.html` 790×482,
     same-origin `contentDocument` title "Search docs", search input present, readyState complete (D-004).
     Direct fetches: `/internal/docs/search-palette.html` 200 text/html (contains pagefind-ui.js),
     `/internal/docs/pagefind/pagefind-ui.js` 200 text/javascript.
   - D'' ✓ deep link `?app=home&panel=quick&qptab=docs` opens straight on Docs.
   - G' ✓ `?app=dev&tab=pg&panel=quick` + Brainstorm → URL keeps `tab=pg` and gains `qptab=brainstorm`;
     DEV console stays on PG connections (no key collision, D-003).
   - Console: 0 error/uncaught lines in both runs.

Screenshots (inspected by the author):
- `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/screenshot-panel-prompts.png`
- `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/screenshot-panel-brainstorm.png`
- `/home/marsh-office/papercupai-workspace/papercusp/.papercusp/reports/portal-quick-panel-palette-2026-09-06/screenshot-panel-docs.png`

## Tests + typecheck

- Operator (papercusp): `testing:run` — surfaces registry test 5/5; `npm run lint:tsc -- --files=…` clean
  (`/tmp/e8071-u5-tsc-op.log`, TSC_EXIT=0, operator + operator-vite legs).
- Portal: `tests/quick-panel-palette.test.tsx` 9/9, `tests/operator-passthrough.test.ts` 12/12, shell
  consumer suites 146/146 (`/tmp/e8071-u5-portal-shell-tests.log`, VITEST_EXIT=0).
- Portal typecheck (`node scripts/typecheck.mjs`, run LAST at 2026-09-06T01:53Z,
  `/tmp/e8071-u5-portal-typecheck-final.log`): `status=errors errors=4 files=2399`. All four are a PEER's
  concurrent, uncommitted refactor of `packages/ui/src/shell.tsx` (137+/210−, mtime 01:53:14Z):
  `formatSessionAge` import dropped while usages remain at 1553/2755/2757, and
  `tests/launched-sessions-ui.test.tsx:118` (`liveSessionCount`). `git diff -U0 packages/ui/src/shell.tsx |
  grep '^+.*formatSessionAge'` → 0 lines; none of the quick-panel hunks are involved. The previous run at
  01:41Z (before that peer edit; after every quick-panel edit except the `apps/host/src/api.ts` session gate,
  whose file typechecks in this run) was `status=clean files=2397`.
  **Re-run at 2026-09-06T02:02Z** (`/tmp/e8071-u5-portal-typecheck-final2.log`, after the peer's write settled):
  `TYPECHECK_RESULT status=clean exit=0 errors=0 files=2400` — the 01:53Z red was transient (a file mid-write during the run).
- Session gate check (02:01Z): unauthenticated `curl` to `/internal/docs/search-palette.html` and to `/api/agent-mcp/saved-prompts`
  both answer 200 on this dev box — identical behaviour for the two prefixes, so `requireSession` is applied uniformly and the
  loopback identity is an environment property, not a quick-panel gap. The passthrough test asserts the gate registration.

## Commit state

- Portal sweep fired 02:01Z (`git-sync:run installSlug=portal`): committed `40a84531` → `aee3ccdb`, so
  `tests/quick-panel-palette.test.tsx` and `app/internal/docs/[...path]/route.ts` are now tracked.
- Operator files were already committed (papercusp sweep 01:50:31Z).

## Residue

- Portal working-tree edits are uncommitted until git-sync sweeps the portal checkout (stall cleared 01:45Z).
- EI-22474205458538258 (filed this unit): bare nuqs keys of the quick-panel page collide with the portal shell —
  resolved for this mount by D-003's `queryPrefix`; the EI stays as the general note for other embedded pages.
