# WS P-003 — workspace-Queen re-key: turnkey build spec (su-6e0fd, 2026-06-20)

Plan: `workspace-scoped-coordination-2026-06-20` item **P-003** (harness `papercusp`). Owner sign-off = D-007
(K1 keying + shared dark flag + A+B+C behind the flag). Sibling: P-002 (su-68782) re-keys the LEARNING loop
on the **same** convention.

## Keystone DONE (this session, green)
- **Shared flag `FLAGS.WORKSPACE_COORDINATION = "papercusp-workspace-coordination"`** — default OFF, in
  `KNOWN_DARK_FLAGS`. Files: `libs/flags/src/types.ts` (FLAGS + FLAG_DEFAULTS), `libs/flags/src/production-defaults.test.ts`.
  libs/flags suite 75/75 green. **P-002 + P-003 BOTH gate on this one flag** (they flip together post-canary).
- Gate idiom: `import { getFlag } from '@papercusp/flags/server'; import { FLAGS } from '@papercusp/flags';`
  then `await getFlag(FLAGS.WORKSPACE_COORDINATION, 'system')` (sync-cached; safe in hot paths).
  Tests: `setFlagOverridesForTest({ [FLAGS.WORKSPACE_COORDINATION]: true })`.

## K1 keying convention (shared with P-002 — su-68782 mirrors)
Brain identity key → `workspace_id` ALONE; the per-hive (install_slug / hive-home) dimension is DROPPED.
Bee execution stays hive-scoped (untouched). EVERY cutover ships a READ-FALLBACK to the legacy per-hive row →
**flag-OFF must be byte-identical** (zero regression for the live single-hive papercusp-workspace).
- KV (operator_settings): key `<thing>:<ws>` (drop `:<install>`); fallback = if `<ws>` absent, read legacy `<thing>:<ws>:*`.
- routines table: workspace-sentinel `install_slug = workspaceId` within the EXISTING global `(install_slug,name)` unique → one row/ws. No migration.
- dedicated per-hive SQL tables (P-002's scout_ticks/lens_weights, mig 289): need a migration (336+) — P-002's side, not P-003.
- **P-003 needs NO migration** (KV + routines-sentinel + label change + code).

## A — Re-key Queen lifecycle (all flag-gated; OFF = byte-identical)
### A1 `packages/operator-core/lib/hive/started.ts`  (key `hive_started:<ws>:<install>`)
- `getHiveStarted(ws, install)`: flag-ON → read `hive_started:<ws>`; if no row, FALLBACK to any legacy `hive_started:<ws>:*`='true'.
- `setHiveStarted(ws, install, started)`: flag-ON → write `hive_started:<ws>` (install ignored).
- `listStartedHives()`: flag-ON → return one entry per started **workspace**, `install` = the workspace's seat-home
  (`resolveHiveHomeSlug(undefined, undefined)` → env `PAPERCUSP_HIVE_HOME_SLUG`; for this ws = `papercusp`).
  Parse: the `<ws>`-only key has no second colon → handle (don't skip). ⚠ ENTANGLED with B/launch — see "seat-home" note.
- Callers (signatures unchanged): hive/{start:70,pause:74,status:61}, system-health/compute:919, overwatch/control-state:107-119,
  sync-resolver/index:3129, endpoint-route/.../bootstrap-su:161. (external-bench/hive-eval = test rigs, leave.)

### A2 `packages/operator-core/lib/hive/wake.ts`  (routine keyed `(install_slug, name='hive-wake')`, GLOBAL unique; EI-1477)
- **The collision the plan names**: 2 hives in 1 ws = 2 routine rows = 2 Queen launches both clobbering the ONE
  workspace-scoped `hive_wake` operator-state (carryNote + subscriptions, already `readHiveWakeState(ws)`-keyed). One workspace Queen fixes it.
- `declareHiveTimeWake(opts{ws,install,...})`: flag-ON → use `install_slug = ws` for the existing-row SELECT (line 158) + upsert (line 166). Has ws. Easy.
- `getHiveTimeWake(sql, install)` (line 205) + `clearHiveTimeWake(sql, install)` (line 191): NO ws param today.
  → add optional `workspaceId?` param; flag-ON + ws → query by `install_slug = ws`. Thread ws at callers:
  status:49, _resolve:101, urgent-wake:95, watchdog:75/248, pause:76, dissolve:122, _create:492, declare_wake:138/141.
- A4 (event-state): `setHiveCarryNote`/`setHiveEventSubscriptions`/`readHiveWakeState` are ALREADY ws-only → NO code change; the fix is structural (one writer). Add a test asserting single-writer correctness.

### A3 `packages/operator-core/lib/hive/placement-watchdog.ts:434` `resolveQueenOwner(sql, ws, install)`
- flag-ON → match `label LIKE 'hive · %'` (any hive's Queen in the ws), newest by started_at. OFF → today's `'hive · '+install+'/%'`.
- Same for `resolveQueenOwners` (line 454, the historical-all variant used at :577 to avoid orphaning bees) → widen label flag-ON.
- Callers (unchanged): scout/register-scout-action:144, overwatch/compute-brief:429, scout/queen-notify (port), hive/queen-brief-launch:99.

## B — Widen survey across all workspace hives  (`packages/operator-core/lib/hive/survey.ts`)
- Today `surveyHive(ws, hiveHomeSlug)` scopes to ONE hive's members (`resolveHiveMembership`); frontier query (`fetchFrontierRows`)
  already filters by `workspace_id` (+ surveySlugs). Empty surveySlugs ⇒ already workspace-wide.
- NEW `surveyWorkspace(ws)`: enumerate started hives (A1 listStartedHives) → `surveyHive` per hive → return **per-hive SECTIONS**
  (D-004 anti-dilution) + a cross-hive ranked top-N. The frontier curse anti-join already scopes per install (survey.ts:362).
- Queen wake brief (`queen-brief-launch.ts` / `renderQueenBrief`) renders per-hive sections.

## C — Central dispatch + Queen prompt  (D-002: Queen IS the central dispatcher — do NOT reintroduce distributed scheduling)
- `fleet:place_batch` already targets a specific harness/hive → the Queen places per target hive from the ranked backlog;
  route by each item's target hive (P-001 tags + harness_slug, already on the frontier rows).
- Prompt: `libs/papercusp/packages/harness/blueprints/coding/prompts/queen.md` (+ base/queen.base.md) — teach the ONE workspace
  Queen she spans all hives, reads per-hive sections, places cross-hive, manages cross-hive parallelism. Edit the SOURCE (auto-assembled), not rendered output.

## Tests (each piece)
- started: flag-ON workspace key + read-fallback; flag-OFF byte-identical. resolveQueenOwner: flag-ON ws-wide vs OFF per-install.
  wake: flag-ON sentinel one-row-per-ws + collision fixed. surveyWorkspace: per-hive sections.
  **single-hive==workspace ZERO-REGRESSION test** (the live case) — load-bearing.
- Build green in-tree (deploy frozen → no live-verify; flag OFF so nothing changes live until canary).

## OPEN DESIGN NOTE (confirm w/ su-aede8, not blocking the common case)
The workspace Queen's **seat-home** (the harness the `system:blueprint-run` launch runs in). For the live single-home
workspace it's just `PAPERCUSP_HIVE_HOME_SLUG` (= `papercusp`). For a workspace with MULTIPLE hive-HOMES, "which home seats
the one Queen" needs a designated primary (registry flag or first-started). Proposed default: the env/registry workspace home;
multi-home-workspace primary = a follow-up. Surface to su-aede8.

## Hot-path coord (re-verify file-locks before editing)
role-1176 clear (confirmed). harness-invoke-once.ts just edited by su-ea8fd (build on current tree). loop-engine = B-LOOP-FIN deploy-gated.
Coordinate started.ts/wake.ts/survey.ts/placement-watchdog.ts locks. P-002 (su-68782) shares ONLY the flag + convention (different files).
