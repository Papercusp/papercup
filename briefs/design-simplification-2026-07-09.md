# design-simplification-2026-07-09

Full-app design audit → simplification + design-doc-violation fixes.
Owner-approved 2026-07-09; executor: su ("implement it yourself from start to finish").

> Re-homed to briefs/ after the original file at apps/operator/docs/plans/ was
> swept by the plans-projection janitor (that dir mirrors PG plans; hand-written
> files don't survive there). Mirror into the PG plan store (plans:new) from a
> session that has the papercusp-su MCP tools — this session's tool surface
> lacked them, which is also why no work_items back this yet.

## Owner decisions (binding)
- **D1** Only chat surface = the terminal-native pui "Papercup chat" in the
  zellij dock. OracleDock + OperatorChatSidebar = legacy → retired. Deck
  (OperatorPanel) NOT declared legacy — keep.
- **D2** app/harness/ legacy → _retired/, BUT split first: the design-system
  primitives inside it (Modal/Select/Checkbox/Tooltip/Button/TextInput/Popover/
  Confirm+Prompt modals/useDebouncedSave/Kanban/theme.ts/primitives.tsx/
  harness.css) stay live — 100+ importers in both trees (operator-vite reaches
  them via the `@`→apps/operator alias). Only the dashboard surface retires.
- **D3** Cup lexicon is committed; ANOTHER AGENT owns the lexicon switch — out
  of scope here, don't touch lexicon code.

## Status
- **P-002 DONE** (docs drift): gotchas.mdx `<details>` section rewritten around
  LazyDetails (all native details migrated; list removed); index.mdx HR2
  carve-out corrected (accent-color baseline exists; #22d3ee hardcode gone);
  broken link → /internal/docs/performance. NOTE a peer had concurrently fixed
  gotchas' accent-color section + the globals.css baseline — aligned, no clobber.
  PENDING: docs-mirror rebuild (`cd apps/operator-docs && npm run build`).
- **P-003 DONE** (D1 retirement): OracleDock, OperatorChatSidebar, OperatorChat,
  TutorialButton (+5 test files) → `_retired/legacy-web-chats/` + RESTORE.md;
  ChromeShell mounts/imports removed (all were FLAGS.TESTING-gated = prod-dark);
  ChromeShell.test.tsx updated + NEW recurrence-guard test ("never renders the
  retired legacy web chats"); AUDITED_DIRECT_CYAN_FILES pruned (missing-file
  entry would red the lint); repo-conventions retired-surfaces table row added;
  gotchas floating-widgets section: Deck = sole canonical exception (role=region).
  VERIFIED: design-primitives + css-tokens lints + ChromeShell suite 28/28 green.
  Kept live (consumers checked): OperatorConversationProvider (vite __root,
  login), chat/ChatConversation, chat-cards/*, AudienceModeSelector
  (SentinelVoiceBar), SupportChatButton (self-falls-back to /support when no
  [data-oracle-dock]), ChatwootWidget. Dead .oracle-*/.op-chat-* CSS → P-010.
- `npm run test:affected` after P-003: 1 non-quarantined failure in
  packages/operator-core — MY edits touched only apps/operator + docs, not
  operator-core; NOT yet root-caused (next session: identify the failing test,
  fix or confirm pre-existing/unrelated; don't leave the gate red).

> NOW MIRRORED into the PG plan store (plans:new, slug design-simplification-2026-07-09,
> harness papercusp) — the store is the live status surface; this file stays the
> long-form recipe carrier. P-004 claimed as WI-3531 by su-85929.

## Remaining items (full recipes; execute in order)
- **P-004** [DONE 2026-07-09 — executed WIDER than the recipe below] vocab migration.
  What actually shipped: --good-bg/--bad-bg promoted into the DTCG source
  (design-tokens/{desktop,hive,honeycomb}.semantic.tokens.json, symmetric with
  --warn-bg; frost values byte-identical to the old globals.css aliases) instead
  of the color-mix() replacement the recipe suggested (analysis predated noticing
  --bad-bg was the dominant tint name); ALL status alias families folded, not
  just the four (also --error/--err/--red/--fg-danger/--accent-error/--pc-danger/
  --pc-color-danger*/--pc-color-success*/--bg-danger/--bad-bg dup/--warning/
  --needs/--fg-warning/--pc-warn-*/--pc-color-warning-text/--bg-warning/
  --amber-100/--border-warning); 74 consumer lines in 31 files migrated repo-wide
  (incl. packages/operator-core/lib/capability-explain.ts + libs/testing-shell —
  the consumer list below was scoped too narrow); whole alias block deleted from
  globals.css :root except --bad-bg-solid (documented one-off); THEME_TOKENS
  gained good-bg/bad-bg. ⚠ Fixed en route: --border-muted + --accent-rgb existed
  ONLY in the generated _semantic.css (hand-edit drift trap) — now properly in
  desktop.semantic.tokens.json ($type color so the frost parity block emits them).
  Verified: zero-consumer grep clean, _lints 20/20, tokens.test.ts 15/15.
  Left for P-017 (new item in the store plan): the accent/info/border alias
  family (--info 44, --counter 13, --chip-tint 9, --pc-accent 7, --fg-accent 3,
  --border-subtle 3, --pc-color-primary 2, --pc-accent-2 1; 0-consumer
  --chip-accent/--stat-accent/--fg-link/--border-dim), globals.css :root ~L60-71.
  Original recipe (superseded, kept for the record):
  REAL alias definitions are only FOUR (earlier "12 --danger" were CSS class
  names, not tokens): globals.css L74 `--success: var(--good)`, L75 `--ok:
  var(--good)`, L80 `--danger: var(--bad)`, L92 `--error-bg:
  rgba(251,113,133,0.1)` (raw rose-400@0.1 → replace consumers with
  `color-mix(in srgb, var(--bad), transparent 90%)`, byte-identical if --bad's
  frost value is #fb7185 — VERIFY in _semantic.css first).
  Mechanical map: `var(--success` → `var(--good` · `var(--ok` → `var(--good` ·
  `var(--danger` → `var(--bad` · `var(--error-bg)` → the color-mix above.
  Keep existing #fallbacks as-is. COMPLETE consumer list (grep-verified):
  admin/plans/PlanDetail.tsx:948,949,1004 · admin/plans/plan-renderers.ts:269 ·
  admin/plans/PlanKanbanView.tsx:47 · SetupWizard/BootstrapFinishGate.tsx:69 ·
  cupboard/cupboard-theme.ts:34–39 · cupboard/CupboardClient.tsx:96,969–971,
  1020–1022 · cupboard/CupboardErrorState.tsx:53,58,60,75,78 ·
  cupboard/ToolsSection.tsx:325 · cupboard/[id]/page.tsx:287 ·
  harness/EntryGithubUrlForm.tsx:186 · adv/sessions/AdvSessionsClient.tsx:1376 ·
  adv/harnesses/AcceptancePanel.tsx:31 · settings/omp-integration/page.tsx:
  125,137,141 · globals.css:26865,26866,26911,26913 (uses `rgb(from var(--ok)…)`
  — swap to --good/--bad). THEN delete the four alias definitions (L74/75/80/92)
  + prune `--ok/--success/--danger/--error-bg` if present in THEME_TOKENS /
  custom-theme allowlists (check packages/operator-core/lib/theme-tokens.ts).
  Edit tool per file (lock hook), not sed. Verify: vitest _lints green + this
  grep returns ZERO: `grep -rnE "var\(--(ok|success|danger|error-bg)[,)]"
  apps/operator/app apps/operator-vite/src --include=*.tsx --include=*.ts
  --include=*.css | grep -v _retired | grep -v '\.test\.'`.
- **P-005** status single-source: replace local maps with harness/theme.ts
  tables/pills — AcceptancePanel STATUS_TONE; admin/dbos/DbosClient statusColor;
  AgentInspectorModal inline hexes; settings/user/memory KIND_COLORS;
  operator-vite LearningTab GYM_STATUS_COLOR; dock/Real*+Pinned* panels ONLY if
  P-008 doesn't retire them first. Extend central tables for missing keys
  (dbos/gym). Add warn-first lint (warnOrFail enforce:false) for local
  STATUS_*/SEVERITY_*/KIND_COLORS maps.
- **P-006** theme-contract sweep: (a) globals.css ~28 lines rgba(103,232,249)/
  #67e8f9 in .pc-voice-btn.is-wake-detected + .operator-panel → color-mix over
  --accent-strong (add cyan-300 row to tokens.mdx migration table);
  (b) FeaturesAdmin(4)/admin AdminShell(2)/AdvConversationsTab(1) sky literals;
  (c) harness/theme.ts COLORS.danger/success raw hexes → var(--bad/--good,…);
  (d) FrameVncView navy → --bg-deepest; (e) installed/plugins color:'#000' →
  var(--accent-ink) ×2; (f) lint: extend cyanLiteralRe to all 6 sky shades, add
  (b) files to audited list.
- **P-007** flat buttons (HR9): strip bevels globals.css L~9128 .operator-feed-
  pills button.is-active, L~20760 .operator-mini-btn--ghost, L~21145
  .operator-delegates__actions button, L~24624 .operator-feed-active-filters
  button (L4667 .oracle-form dies with oracle CSS removal); sheen gradients on
  button/pill rules: harness.css(25) globals.css(25) h-proposals.css(10).
- **P-008** retire legacy harness dashboard (D2): keep-list above; retire
  page components, FeatureEditor, InsightsPanel, PiTerminalsDock, dock/*,
  AgentInspectorModal, TrustBadge, PrsTab, PiPanel + vite /harness/$slug route
  (redirect → /adv). Inventory outside-importers per file FIRST. RESTORE.md +
  conventions row + design-docs example-table updates + lint list updates.
- **P-009** burn down design-primitives allowlists via `@` alias imports:
  ToolUsagePanel (select+table), AdvOverviewTab (table), ModelOverride (select),
  settings/p2p (table→GridTable), SentinelVoiceBar title=→Tooltip. ⚠ LeftSidebar
  title= tab tips are an OWNER ASK (2026-06-23) yet lint-allowlisted as
  "temporary" — ASK owner: bless as documented carve-out vs migrate.
- **P-010** globals.css split (26,935 lines/834KB; .operator-* 2001, .pc-* 1468,
  .oracle-* 318): DELETE dead .oracle-*/.op-chat-* blocks (post P-003), extract
  Deck/feed chrome → deck.css, etc. Brace-balanced splitter + frost/black visual
  litmus via tauri-agent-tools.
- **P-011** delete legacy hive theme alias (hive.semantic.tokens.json +
  generated css + theme.ts readers map hive→honeycomb + docs). npm run tokens.
- **P-012** letter-spacing: add baseline reset; delete ~495 css + ~60 inline
  `letter-spacing: 0` declarations.
- **P-013** demote lab routes under /dev + FLAGS.TESTING: editor-demo, el-min,
  operator-mock, notes, wiki, prompt-studio(top), gym, eval-viz, res, design,
  drizzle-studio (inventory e2e/docs referers first).
- **P-014** settings IA regroup 24→6 nav groups (Agents/Workspace/Appearance/
  Integrations/Account&Trust/Setup); merges needing owner input: omp+omp-
  integration, plugins×3, prompt-studio×2, user vs profile.
- **P-015** one Button: fold .pc-button/.operator-mini-btn/.pc-advpanel__btn
  recipes into <Button> variants.
- **P-016** central categorical palette (AdvShell 38-hex + LearningTab/HealthTab
  copies → one exported table beside STATUS).

## Verification per wave
vitest run --config apps/operator/vitest.config.ts apps/operator/app/_lints/*.test.ts
+ npm run test:affected + frost/black screenshot litmus for UI-visible waves.
