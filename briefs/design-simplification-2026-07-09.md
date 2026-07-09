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
- **P-005** [DONE 2026-07-09] status single-source. As shipped: harness/theme.ts
  gained `TONE` (good/warn/bad/accent/neutral/fg → bare var() forms) +
  `statusToneColor(status, fallback)` (one-color lookups; covers VAL, DBOS
  (incl. MAX_RECOVERY* contains-match), gym, stream-step vocabularies) +
  `MEMORY_KIND_COLOR`/`MEMORY_KIND_FALLBACK`. Migrated: AcceptancePanel
  STATUS_TONE, DbosClient statusColor (still exported, delegates; tests
  unchanged 10/10), settings/user/memory KIND_COLORS, vite LearningTab
  GYM_STATUS_COLOR (37/37), + BONUS StructuredStreamView STATUS_COLOR (4/4).
  SKIPPED deliberately: AgentInspectorModal + dock/Real*+Pinned* +
  insights/BootHistoryTable — all on P-008's retire list (migrating
  soon-retired surfaces is waste); they show in the lint warn output instead.
  Warn-first lint added to design-primitives.test.ts (`unexpectedLocalStatusColorMaps`,
  enforce:false, central-files allowlist = theme.ts): 10 offenders logged — 8
  P-008-bound, 2 categorical (AdvConversationsTab KIND_COLOR, CupboardClient
  KIND_TONES → P-016 territory). Flip enforce:true after P-008+P-016 land.
  ⚠ Fixed en route: warnOrFail's warn path used console.warn, which
  vitest-fail-on-console turns into a hard fail — warn-first NEVER actually
  worked for a real offender; now writes process.stdout.write (self-tests
  updated). Behavior deltas (deliberate): DBOS CANCELLED now fg-mute (was fg);
  gym unknown-status fallback now var(--fg-mute) (was #94a3b8). Verified:
  _lints 19/19 + css-tokens, DbosClient 10/10, LearningTab 37/37,
  StructuredStreamView 4/4, `npm run test:affected` exit 0 (2713 files green;
  su-ba914 confirmed the nuqs red fixed on their side).
- **P-006** [DONE 2026-07-09 — litmus PASSED; two extra leaks found+fixed en route] theme-contract
  sweep — executed WIDER than the recipe: (a) globals.css had 211 cyan-300
  literals (not ~28; .pc-voice-btn.is-wake-detected turned out amber, the cyan
  is .operator-panel + marketplace/route-transition/shell-heading families) —
  ALL migrated via exact-pattern rewrite to `rgb(from var(--accent-strong) r g b
  / <alpha>)` (file's own idiom; alphas byte-identical, hue cyan-300→sky-300);
  .operator-panel neon triplets bound (--operator-neon-cyan→var(--accent-strong-rgb),
  --operator-neon-blue→var(--accent-rgb)); NEW DTCG token `accent-strong-rgb`
  (desktop.semantic.tokens.json) + tokens rebuilt; tokens.mdx migration table
  +cyan-300/cyan-400 rows. (b) FeaturesAdmin ×4 → rgb(from …); AdvConversationsTab
  VIEW_ACCENT threads → var(--accent,…); AdminShell needed nothing (already
  var-fallback forms). (c) theme.ts COLORS.danger/success solid button bgs →
  color-mix(var(--bad|--good), var(--bg-deepest) 55%) (keeps white-text contrast;
  frost ≈ old red-900/emerald-900), *Bg → var(--bad-bg/--good-bg), *Text →
  var(--bad/--good). (d) FrameVncView rgba(7,16,29,.6) → rgb(from var(--bg) …)
  (the literal was --bg, not bg-deepest). (e) plugins '#000' ×2 →
  var(--accent-ink). (f) cyanLiteralRe extended to 6 shades (+67e8f9/0ea5e9/
  bae6fd + triplet forms) + FeaturesAdmin/AdvConversationsTab/FrameVncView/
  plugins-page added to audited list. En route: allowlisted RubricDetailPanel +
  ScorecardDetail native tables (peer plan rubrics-tab-scorecard-ui-2026-07-09
  landed mid-verify holding the gate red; their author owns migration).
  LITMUS (2026-07-09, isolated dock-suppressed shell on :3370 per agent-e2e §1.3;
  OperatorPanel is UNMOUNTED/orphaned per design/operator-panel-visual-pass.mdx,
  so a fixture div carrying the panel classes was injected): PASSED — frost
  renders the sky-family bezel (near-identical to old cyan), black goes
  monochrome white/grey + deliberate amber decoratives, zero blue leak;
  WebKitGTK resolves `rgb(from var(--accent-strong) r g b / a)` exactly
  (color(srgb .49 .827 .988 / a)). TWO EXTRA LEAKS found by the litmus + fixed:
  (g) black/honeycomb/hive token sets lacked accent-rgb + accent-strong-rgb, so
  frost's SKY triplets inherited through :root into every rgba(var(--*-rgb), a)
  composition under those themes — triplets added to all three
  *.semantic.tokens.json (black 230,230,230/255,255,255; honeycomb 198,142,36/
  214,166,74; hive 246,183,47/255,209,102) + tokens rebuilt; rule recorded in
  the token $descriptions: every theme overriding accent MUST override the
  triplets. (h) the P-006 neon-var binding had landed on a SUPERSEDED
  .operator-panel block (~L11887) — the LIVE winning block is the later
  "augmented HUD bezel" (~L13487) whose --operator-hud-cyan/-blue were still
  bespoke literals 99,230,255 / 16,185,235 → now var(--accent-strong-rgb) /
  var(--accent-rgb) (computed-style proof: hud-cyan resolves 125,211,252 frost /
  255,255,255 black). ⚠ Gotcha for future litmus work: the desktop dev shell
  serves operator-vite as a BUILT bundle from hono-host (:3370/assets/index-*.css)
  — a globals.css edit needs `cd apps/operator-vite && npm run build` + reload,
  Vite HMR does NOT reach it. Docs-mirror clean rebuild green (stale
  dist/.prerender chunk; rm -rf dist .astro fixed). Verified after (g)+(h):
  _lints 21/21, tokens.test 15/15, test:affected exit 0.
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
