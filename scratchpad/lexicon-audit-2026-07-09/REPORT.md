# Old-lexicon (bee/hive) audit — 2026-07-09

**Work item:** WI-3445 · **Repo:** `papercupai-workspace/papercusp` @ `bf3f4f04c6` · **Scan:** all 22,427 git-tracked files (incl. submodules), segment-aware matching (no `archive`/`combine`/`been`/`hyperswarm`-as-word false positives), binaries skipped.

**Audit only — no renames were made.** Companion machine-readable files in this directory are the exhaustiveness guarantee:

| file | contents |
|---|---|
| `inventory.tsv` | every file with ≥1 old-lexicon hit (5,800 rows: path, category, per-term counts) |
| `identifiers.txt` | every distinct identifier containing an old term (10,537, with counts + example file) |
| `filenames.txt` | every file/dir whose NAME contains an old term (845 files, 38 dirs) |
| `tool_like_idents.txt` | every `hive:*`/`bee:*`/`queen*`/`sentinel:*` verb-shaped identifier (541) |
| `dir_rollup.tsv`, `top_source_files.txt`, `summary.json` | rollups |

## Canonical mapping (owner-ratified, D-006 of `restore-pot-lexicon-public-release-2026-07-04`)

| old (bee/hive) | new (cup) | applies to |
|---|---|---|
| hive | **pot** | `hive:*` tools, `hive_*` SQL ids, blueprint `hive`, `/hive*` routes, prose |
| bee | **cup** | role `cup`, `cup:spawn`, `cup_claim_specs`, `cup_id`, blueprint `cup` |
| queen | **brain** (display: **Mug**) | role + tools + prose |
| sentinel | **operator** (display: **Papercup**) | role + `sentinel:converse`→`operator:converse` ⚠ collision with existing operator-core naming — disambiguate |
| hive-eval | **pot-eval** | eval battery |
| hive mind / substrate | **coordination** | prose |
| colony (fleet) | **Fleet** | display |
| keeper | **Human** | display |
| cell (chunk) | **Chunk** | display |
| comb | **Cupboard** | display |
| swarm (node) | **Node** | display |
| waggle | **Signal** | display |
| **KEPT as-is:** scout, overwatch, planner, red-queen | — | owner decision D-006 |
| **KEPT:** the `the-hive` brand pack + THE_HIVE flag | — | intentional flag-gated skin (must stay reversible, P-014) |

## Headline numbers

- **5,800 files** contain old-lexicon terms — **~221,000 raw hits**.
- Core renamable terms: **hive 121,718 · bee 24,691 · queen 23,157 · sentinel 11,474** (+ swarm 14,733 — see §14; colony 235, comb 1,232, keeper 62, waggle 22, brood 16, honey/honeycomb 386, apiary 297, misc <50).
- **845 files and 38 directories are NAMED with old terms.**
- **10,537 distinct identifiers** embed an old term.
- Phase 6 of the rename plan (backend identifiers: P-016 tool names, P-017 DB, P-018 routes/blueprint/role ids, P-019 verify) **has not started** — that is the overwhelming bulk below.

By category (files / hits): source 2,719 / 150,746 · tests 1,535 / 36,899 · other-markdown 910 / 21,218 · SQL 372 / 5,096 · runtime-state 94 / 3,430 · generated (dist+cache+lockfiles) 57 / 2,104 · marketing site 25 / 843 · historical docs 24 / 392 · rubrics 6 / 216 · lexicon-mechanism 6 / 185 · templates 27 / 151 · ops-scripts 13 / 77 · retired 12 / 24.

Source+SQL+scripts core-term hits by area: `apps/operator` 76,803 · `packages/operator-core` 35,981 · `papercusp-desktop/src-tauri` 5,247 · `libs/papercusp` 3,039 · `apps/operator-vite` 2,470 · `apps/tui` 1,835 · `papercusp-desktop/bin` 1,117 · `libs/generic` 317 · `libs/flags` 278 · `apps/operator-public` 116 · `packages/agent-mcp` 72 · rest <50 each.

---

## 1. MCP tool names (plan P-016 — todo)

38 registered tool names in the live catalog still bee/hive-themed (`.papercusp/tool-catalog.json` + `defineTool` sites in `packages/operator-core/lib/agent-tools/{hive,bee,hive_git}/`):

`hive:add-member` `hive:ask` `hive:asks` `hive:ban_member` `hive:beacon_consent` `hive:control_policy` `hive:create` `hive:create_from_repo` `hive:cross_grant` `hive:declare-wake` `hive:dissolve` `hive:get` `hive:get-steering` `hive:leave` `hive:list` `hive:membership_decide` `hive:membership_pending` `hive:moderation_queue` `hive:moderation_resolve` `hive:pause` `hive:queen_efficiency` `hive:report` `hive:request_work` `hive:set-steering` `hive:start` `hive:status` `hive:survey` `hive:takedown` `hive:update` `hive:wake` · `hive_git:integration_requests` · `bee:spawn` (1,550 references — the single most-referenced old name) · `fleet:bee_mail` `fleet:selected_bee` · `sentinel:converse` · `deploy:hive` `deploy:teardown_hive` `discovery:set_hive` · `curation:state-of-hive`.

Also queen-verb surfaces: `QUEEN_MCP_TOOL_NAMES`, `queenVerbs` (see `identifiers.txt`). Blast radius: every agent prompt, recipe, the Rust pui, external MCP clients, docs, tests, and the tools-md-sync test.

Additionally, **tool ARG names and descriptions** still use the old lexicon even on new-named tools — e.g. `work_items:create { hive }` ("the hive home-harness slug"), `coord:orient` fleet-health described as "bees running/working". Grep `identifiers.txt` for `hiveSlug:`(826) `hiveHomeSlug:`(560) `hiveId:`(452) `beeId:`(121) etc.

## 2. Database identifiers (plan P-017 — todo; sequence LAST, expand-contract + migrations)

372 SQL-bearing files, 5,096 hits, ~83 distinct SQL identifiers (per plan; full extract in `summary.json → sql_identifiers`). Tables (mostly `harness_shared.*`):

`hives` · `hive_members` · `hive_settings` · `hive_policy` · `hive_placements` · `hive_pending_joins` · `hive_reports` · `hive_epoch_keys` · `hive_directory_cache` · `hive_directory_tombstones` · `hive_integration_requests` · `hive_throughput_ticks` · `hive_watchdog_fires` · `hive_wake` · `hive_eval_instances` · `hive_eval_runs` · `hive_eval_scenarios` · `hive_eval_scores` · `bee_claim_specs` · `beekeeper_instances` · `beekeeper_runs` · `beekeeper_scores` · `cross_hive_asks` · `cross_hive_outbox` · `cross_hive_beacon_history` · `capture_hive_members_outbox` · `operator_hive_control_policy` · `plan_hive_scope_moves` · (`red_queen_drills` — red-queen KEPT; `scout_*` KEPT)

Columns/functions/values: `hive_slug` (494 refs — the #1 SQL id), `hive_home_slug`, `hive_id`, `hive_pubkey`, `hive_title`, `bee_id`, `source_hive`, `to_hive`, fn `sync_pot_hive_slug` (already half-renamed — mixes pot+hive), `sethivecarrynote`, enum/`child_role` values `'queen'`/`'bee'`, all `*_pkey`/`*_fkey` constraint + index names (e.g. `spawned_agents_fleet_slug_running_idx … child_role='bee'`).

## 3. HTTP routes + URLs (plan P-018 slice 1 — todo/in progress via WI-2890)

- `packages/operator-core/lib/endpoint-route/routes/hive/` (whole route dir)
- `/api/harness/hives/from-repo` · `/api/discovery/join-hive` · `/settings/hive-customization` · `/remote-hives/*` · `/hives/*` · `/brand/the-hive/favicon.svg` (skin asset — keep?) 
- `/operator/hive-steering` — **external oddsmith wire contract; plan says HOLD**
- 28 internal-docs URLs `/internal/docs/**/hive-*` (shared-hive-guide, hive-git-sync, hive-tool-namespace, hive-queen-fresh-per-wake, … full list in `identifiers.txt`/route scan) — renaming = docs slugs + every cross-link (1,222 refs each in the docs build)

## 4. Blueprint ids + agent role ids (plan P-018 — todo)

- Blueprint dirs (×2 copies: `libs/papercusp/packages/harness/blueprints/` AND `papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/`): **`bee/`** (→`cup`), **`hive-eval/`** (→`pot-eval`), **`sentinel/`** (→`operator`), `red-queen/` (KEPT)
- Role ids threaded through spawn/coordination/steering/prompts/DB: `role='bee'`, `role='queen'`, `role='sentinel'`, `child_role` values, `PIN_ROLE='bee'` (`apps/operator-vite/.../ThrottleSection.tsx:49`), `humanFacingRole='sentinel'`
- LLM-testing scenario dirs: `packages/operator-core/lib/llm-testing/scenarios/{bee,queen,sentinel}/`
- Template blueprint: `templates/papercusp-ops-hives/` + `blueprints/ops-hive/` (also the template's registry listing + GUIDE)

## 5. Feature-flag keys (`libs/flags/src/types.ts` + production-defaults + registry)

29 old-term keys: `BEE_FRESH_CONTEXT_WARM_INJECT` `BEE_TRANSCRIPT_CAP` `BEE_WAKE_DOSSIER` `DOGFOOD_PAPERCUSP_HIVE` `DOGFOOD_PAPERCUSP_HIVE_SHARE` `HIVE_AGENT_TABS` `HIVE_CONTROL` `HIVE_FROM_GITHUB_URL` `HIVE_PLACEMENT_WATCHDOG` `HIVE_REKEY` `HIVE_ROLE_TIERS` `HIVE_SEED_BUNDLE` `HIVE_SEED_SELF_ADMIT` `HIVE_WAKE_FRONTIER_GUARD` `PER_HIVE_LEARNING_LOOPS` `PER_HIVE_RELEASE_GATE` `QUEEN_AUTONOMY_ARMED` `QUEEN_AUTONOMY_SETTINGS` `QUEEN_BRAIN_FRESH` `QUEEN_CAPACITY_DISPATCH` `QUEEN_CARD_INTERCEPTION` `QUEEN_FULL_AUTONOMY` `QUEEN_TIER_SELECTION` `QUEEN_WARM_SESSION` `SENTINEL` `SENTINEL_PROACTIVE` `STEERING_HIVE_TREE` (+ `THE_HIVE` and `RED_QUEEN` — intentional, keep).

## 6. Env vars / process env

`PAPERCUSP_HIVE_SLUG` · `PAPERCUSP_HIVE_HOME_SLUG` · `PAPERCUSP_FLAG_PAPERCUSP_HIVE_REKEY` · `PAPERCUSP_SWARM_MAX_PEERS` · `PAPERCUSP_HIVE_PLACEMENT_BREAKER` (explicitly noted as leaked in the P-014 verify) · `HIVE_HOME` · `HIVE_SLUG` · `HIVE_PUBKEY` · `HIVE_BLUEPRINT_ID` · `QUEEN_BRIEF` · `RIG_HIVE_ID` · `PLATFORM_SELF_HIVE_SLUG` · `CROSS_HIVE_GRANTS_KEY` · `HIVE_WAKE_ROUTINE_NAME` (+ ~50 more ALL-CAPS ids in `summary.json → env_style_identifiers`).

## 7. System routine / policy names (string ids in the routines registry)

`hive-watchdog-sweep` · `hive-placement-watchdog-sweep` · `hive-paused-recovery-sweep` · `hive-throughput-tick` · `hive-epoch-key-reconcile` · `hive-eval-battery` · `hive-control-policy`.

## 8. Directories + files NAMED with old terms (845 files, 38 dirs — full list: `filenames.txt`)

Key directories (beyond blueprints/routes above):

- `packages/operator-core/lib/hive/` · `lib/shared-hive/` · `lib/shared-hive-loop/` · `lib/sync/hive-git/` · `lib/agent-tools/{hive,bee,hive_git}/` · `lib/hive-eval/` · `lib/sentinel/` · (`lib/red-queen/` KEPT)
- `apps/operator/app/settings/hive-customization/` · `app/dev/swarm-identity/` · `app/dev/swarm-logos/` · `apps/operator/prompts/hive-instances/` · `apps/operator/public/brand/the-hive/` (skin — keep?)
- `libs/generic/hive-app-seam/` — **published package `@papercusp/hive-app-seam`** (the ONE typed app seam named in templates/personas)
- `design-tokens/hive.semantic.tokens.json` + `design-tokens/style-dictionary.config.mjs`
- `scripts/deploy-hive.ts` · `scripts/teardown-hive.ts`
- `rubrics/pot-coordination-health/` · `rubrics/experiment-hive-quality/`
- `shared-hive-release-testing/` (in-repo test rig, 102 files/2,449 hits)
- `templates/papercusp-ops-hives/`
- Package names: `@papercusp/hive-app-seam`, `hive-eval-seed-app`, (`@papercusp/the-swarm-site` — D-004)

Named-file counts by area: operator-core 417 · desktop src-tauri 139 · apps/operator 136 · libs/papercusp 47 · operator-docs 43 · operator-vite 36 · the-swarm-site 4 · misc 23.

## 9. UI display strings (Phase 3 residue — P-005 partially done at last plan write)

Per the plan's own progress notes, still un-routed through `useLexicon` at last record: **QueenTab internals** (~10 user-facing "Queen"/"hives" sites incl. title/tooltip/scope copy), SentinelTab/OverwatchTab internals, HiveSteeringTree, LocalHivesControl, QueenHeartbeat, plus P-006 adv panels · P-007 palette/toasts/empty-states · P-008 the 16 server `term()` callsites · P-009 desktop shell labels. Component files themselves are hive-named (`HivesTab.tsx`, `QueenTab.tsx`, `SentinelTab.tsx`, `SwarmTab.tsx`, `CombBlueprintForm.tsx`, `HiveThemeBridge`, `HiveVisualIdentity` — last two are skin machinery).

Emoji: 🐝/🍯 remain in `apps/tui/src/layout.rs`, `apps/operator/app/harness/CreateHarnessPicker.tsx`, `CombBlueprintForm.tsx`, `EntryGithubSearchForm.tsx` (+ compiled copies in desktop env-sidecars), statusline-fleet 🐝 + tutorial-runner `CHAPTER_EMOJI` (deferred in P-010/P-011).

## 10. Docs (D-003 — decision recorded as OPEN)

- `apps/operator-docs`: 353 files / 6,070 hits, 43 hive-named pages incl. the 28 agent-insights hive-slugged pages (`shared-hive-guide`, `hive-tool-namespace`, `hive-queen-fresh-per-wake`, `coding-hive-bee-vs-coding-factory-scoper`, `sentinel`, …) + `agent-insights-index.md` rows
- Other markdown across the repo: 910 files / 21,218 hits (READMEs, GUIDEs, briefs, template docs)
- Agent prompts: `apps/operator/prompts/hive-instances/`, blueprint prompt files, `QUEEN_BRIEF` — plan D-003 left "user-facing docs vs agent prompts" scope open; both are still bee-themed

## 11. Desktop app

- `papercusp-desktop/src-tauri` 419 files / 6,618 hits — includes `env-sidecars/staging/` (a bundled copy of the staging tree: prompts, blueprints, SPA assets — **regenerates from the main tree**; fix source then rebuild)
- `papercusp-desktop/bin` build scripts: 1,123 hive hits
- `src-tauri/icons/the-hive/` + `libs/papercusp/apps/desktop/src-tauri/icons/the-hive/` (skin icons — intentional per P-010)
- `apps/tui` (Rust pui): 25 files / 2,103 hits (`layout.rs`, `agent_pane_kind`, wake_board, fleet panes)

## 12. Tests

1,535 test files / 36,899 hits — fixtures, mocks (`role:'bee'`, `agent:'queen'`), scenario assertions, `production-defaults.test.ts` flag lists, `tools-md-sync` test. These move WITH each Phase-6 slice.

## 13. Marketing site (D-004 — explicitly an OWNER decision)

`apps/the-swarm-site` (`@papercusp/the-swarm-site`, 25 files / 843 hits) deploying to **theswarm.dev** (Cloudflare Pages project `the-swarm`). Owner has not ruled whether the public brand stays "The Swarm" or becomes Papercup — excluded from "must fix" until ruled.

## 14. "swarm" needs case-by-case review

14,733 hits split three ways: (a) lexicon Swarm (deployment unit / old brand) — rename per map; (b) **hyperswarm P2P library** usage in shared-hive/federation code ("swarm topic", `PAPERCUSP_SWARM_MAX_PEERS`) — technical term, arguably keep; (c) `apps/the-swarm-site` + `app/dev/swarm-identity|swarm-logos` brand assets — D-004.

## 15. Runtime/state + generated (fix source, then regenerate/migrate)

- `.papercusp/` runtime state: 94 files / 3,430 hits (tool-catalog.json, memory raw.md, text-artifacts, state rows referencing hive slugs/tools)
- Generated: `.nx` cache (1,234), tracked `dist/` incl. `packages/agent-mcp/dist` (844), lockfiles (26 — package names), desktop SPA asset bundles
- `_retired/papercup`: 12 files / 24 hits (retired — skip or delete)

## 16. Out-of-repo / deployed surfaces (adjacent — flagged so nothing is missed)

- Live DB (`harness_shared` schema on the running Postgres) — mirrors §2; needs migrations, not text edits
- Deployed MCP server tool catalog (serving `hive:*` / `bee:spawn` / `sentinel:converse` today) + every recorded recipe calling them
- Agent personas/blueprints projected outside the repo (e.g. `~/.claude/AGENTS.md`, materialized launch-contexts, the su persona's own "Queen/QUEEN_BRIEF/hive" references)
- Sibling workspace dirs/harnesses: live harnesses `hive-canary`, `hiveloop`, `quartermaster-hive`, `shared-hive-test` (all named in today's git-sync watchdog broadcasts), plus dirs `brood-box-alpha/`, `shared-hive-parallel-test/`, `.papercusp-hive-demo/`, `papercup-hive-backup-20260619/`, `.papercusp-shared-hive-retest/`
- Cupboard/template registry listing for `papercusp-ops-hives`
- theswarm.dev domain/email/Cloudflare commitments (D-004/D-008)

## 17. Intentional bee/hive references — do NOT flag as misses

1. `libs/generic/lexicon/` the-hive pack (Hive/Colony/Queen/Sentinel/Bee/Keeper/Cell/Comb/Swarm/Hive Mind/Waggle labels) — the flag-gated skin itself
2. `THE_HIVE` + `RED_QUEEN` flags; `scout`/`overwatch`/`planner`/`red-queen` role+table names (owner: KEPT)
3. `the-hive` brand asset dirs + icons (skin must stay reversible, P-014)
4. Historical records: `docs/plans/*`, `briefs/`, decision bodies, `.papercusp/memory` history
5. hyperswarm-the-library mentions where they mean the P2P primitive

---

### Suggested execution order (mirrors plan Phase 6 + closes Phase 3/5 residue)

1. Close Phase 3 display-string residue (§9) + emoji (§9) — user-visible, cheap
2. P-016 tool names (§1) — hard cutover with prompts+recipes+docs in the same change
3. P-018 routes (§3, hold oddsmith contract), blueprint+role ids (§4), flags/env/routines (§5–7), file/dir/package renames (§8)
4. Docs sweep (§10) once D-003 scope ruled; marketing site only on D-004 ruling
5. P-017 DB rename LAST (§2), expand-contract behind a green gate, then regenerate state/dist (§15)
6. P-019 full verification (typecheck, `test:all:integration`, live fleet smoke: spawn pot → brain→cup placement)
