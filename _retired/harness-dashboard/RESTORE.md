# harness-dashboard — retired 2026-07-09

**What:** the legacy per-slug harness dashboard surface, retired per owner
decision (design-simplification-2026-07-09, D2): *"app/harness/ is also
legacy"* — with the explicit split that the design-system primitives living in
the same directory **stay live**. `/adv` is the harness surface; the vite
`/harness/$slug` routes are now a translating splat redirect
(`apps/operator-vite/src/routes/harness/$.tsx`).

**The retire set was derived by importer inventory + reachability closure, not
by the audit's hypothesis list** (scripts preserved in the plan brief,
`briefs/design-simplification-2026-07-09.md` § P-008): a file retired only if
nothing outside the retiring surface could reach it. That flipped several
audit-list entries to KEEP — see "Deliberately NOT retired" below.

**Moved here from `apps/operator/app/harness/` (paths mirrored):**

- `[slug]/HarnessDockShell.tsx` (+ test) — the per-slug dock-mode page shell
- `[slug]/projects/ProjectsList.tsx`, `[slug]/projects/[id]/ProjectDetail.tsx`
  (+ tests) — the projects pages
- `dock/sample-panels.tsx` — the legacy-dashboard panel registration set (the
  only thing that mounted the Real*/Pinned* panels)
- `dock/Real{Agents,Features,Git,HarnessOverview,Issues,Logs}Panel.tsx`,
  `dock/Pinned{Feature,Issue}Panel.tsx` (+ tests) — legacy dock data panels
- `dock/DockNavChevrons.tsx`, `dock/DockOnboarding.tsx`, `dock/LayoutsMenu.tsx`,
  `dock/useDockLayout.ts` (+ tests) — shell-only dock chrome
- `insights/InsightsFirstVisitGate.tsx` (+ test) — the /harness/$slug insights
  first-visit gate (route-only)
- `InsightsPanel.tsx`, `MemoryBrowser.tsx`, `PromptBudgetView.tsx`,
  `PromptsTab.tsx` (+ tests) — dashboard tabs with zero live importers
- `h-proposals.css` — proposals-tab stylesheet, no importer anywhere (the
  `.h-proposals-*` rules in `harness.css` are separate and still live)

**Moved here from `apps/operator-vite/src/routes/harness/`** (under
`vite-routes/`): `$slug/index.tsx` (+ test), `$slug/insights.tsx` (+ test),
`$slug/dock-preview.tsx`, `$slug/projects/index.tsx`, `$slug/projects/$id.tsx`.
Replaced by the `$.tsx` splat redirect (`/harness/<slug>` →
`/adv?tab=harnesses&slug=…`, `/harness/<slug>/insights` → `tab=insights`).

**Moved here from `apps/operator/e2e/`:** `dock.spec.ts` — drove
`/harness/<slug>?dock=1` (the retired dock-mode shell).

**Deliberately NOT retired (live consumers verified per file):**

- The D2 keep-list primitives: `Button/Checkbox/Modal/Select/TextInput/Tooltip/
  Popover/Kanban/Table/picker-kit/primitives.tsx/theme.ts/useConfirmDialog/
  usePromptDialog/useDebouncedSave/harness.css` (100+ importers, both trees).
- **The dock engine** (`dock/HarnessDock`, `panel-registry`, `dock-actions`,
  `close-guard`, `AddPanelCatalog`, `workbench-panels`, `IframePanel`,
  `iframe-host`, `MissingPanel`, `NavChevrons`, nav/layout hooks,
  `useRegisterPluginPanels`) — the LIVE `/adv` workspace and vite `/workbench`
  are built on it (26 importers of panel-registry alone).
- **Audit-list entries flipped to KEEP by the inventory:**
  `AgentInspectorModal` + `AgentThinkingStream` (vite adv AgentsRunningPill /
  AgentsPillSessions), `TrustBadge` (adv WorkItemsPanel), `PrsTab` (AdvPrsPanel
  + vite AdvHarnessPanelPage), `FeatureEditor` (adv DetailPanel),
  `insights/InsightsTab` (AdvInsightsPanel), the `insights/` Substrate*/
  BootHistory*/ClaimAttempt* cards (admin/dogfood-substrate, both trees),
  `PiTerminalsDock` + `PiPanel` (live `/pi` route in both trees, LeftSidebar/
  DevAdminRail links, plugin-panel lazy mapping in `useRegisterPluginPanels`,
  and ChatPanel imports `PiPanel.css`).
- Live-elsewhere components: `ChatPanel`, `CreateHarnessPicker`,
  `EntryGithub*Form`/`CombBlueprintForm` (via CreateHarnessPicker),
  `HarnessSettingsPanel`/`BlueprintSettingsPanel`/`brainstorm/*` (vite
  AdvHarnessPanelPage), `ShareHiveDialog`/`PublishHiveCard` (AdvShell,
  HiveHeaderStrip), `SavedPromptsSection` (settings/personalization),
  `filters/` (adv panels), `HarnessPluginsSection`/`PrRow`/`PromptModal`
  (deps of kept files).

**Un-wired at retirement (restore = re-apply these):**
1. Move the files back to their mirrored paths.
2. Delete `apps/operator-vite/src/routes/harness/$.tsx` (+ `.test.tsx`) — it
   shadows the per-slug routes — and restore the `vite-routes/harness/$slug/`
   files to `apps/operator-vite/src/routes/harness/$slug/`; the route tree
   regenerates on the next vite dev/build.
3. Restore the pruned lint-allowlist entries in
   `apps/operator/app/_lints/design-primitives.test.ts` (retired-file entries
   removed at retirement — see that file's git history).
4. Revert the stale-comment update in
   `apps/operator-vite/src/routes/harness/index.tsx`.

**Known dead weight left in place (cleanup tracked in
design-simplification-2026-07-09 P-010):** the `.h-*` dashboard rule families
in `apps/operator/app/harness/harness.css` that only the retired shell
rendered (P-010 splits/prunes that file with a visual litmus).

**Last-active commit:** the tree state immediately before the git-sync commit
containing this file.
