# BRIEF — Blueprint distribution layer: extends-composition + init-from-blueprint + import-time dep validation (E1 + E2)

**Plan:** `harness-blueprint-distribution-2026-06-03` (read first: `plans:get { slug, harness:'all' }`).
Items **P-001, P-002** (E1), **P-003, P-004** (E2). Decisions **D-001/D-002/D-003/D-004** and the reconciliation **D-011/D-012**.
**Coordinate with:** **su-adb1b** — owner of the blueprint ENGINE + `harness:create` + `work_items` (`harness-blueprint-orchestration-2026-06-03`). This brief builds the *distribution layer* directly on top of their engine; the seam is tight. They confirmed (2026-06-04, coord `mpzkp5yp`): **loader API is FROZEN — build on it; research/research-base blueprints are THEIRS (their P-017) — do NOT author them.**
Also: **su-9e6b8** is carving `packages/operator-core` out of `apps/operator/**` (heavy churn) — hold the one operator-side edit (E1c) until their carve settles.

## Goal
The distribution layer **on top of** su-adb1b's blueprint engine:
1. **extends-resolution that spans `local → installed → built-in`** (the engine ships built-in-only resolution; the loader reserves the composition for us).
2. **`papercusp init --from` instantiates a blueprint** (resolve+validate+write `.papercusp/blueprint.yaml`), not a directory copy.
3. **import-time dependency validation** — resolve a blueprint's `dependencies.{tools,plugins}` against the catalog + installed plugins + Cupboard listings and **fail upfront ("needs plugin X")** instead of the call-time `unknown_tool`.

## Verified background (don't re-derive — some of it corrects the plan text)
- **The engine ALREADY EXISTS + is frozen** in `libs/papercusp/packages/orchestrator/src/blueprint/`: `schema.ts` (BlueprintSchema, `extends`, `dependencies:{tools[],plugins[]}` at :267 — its comment literally names "distribution P-003/P-004"), `loader.ts` (exports `resolveBlueprint`, `resolveExtends`, `mergeRaw`, `loadBuiltinBlueprint`, `loadBlueprintFromFile`, `builtinBlueprintPath`, `resolveBuiltinExtends`, type **`ResolveExtendsPath`** — the seam), `validate.ts`, `derive-next.ts`. Built-in blueprints exist at `libs/papercusp/packages/harness/blueprints/{base,coding}/blueprint.yaml`. Migration **133** (`harness_shared.blueprints` PG projection) is **applied live**.
- The loader's default resolver is `resolveBuiltinExtends` (built-in only → `harnessPath('blueprints', id, 'blueprint.yaml')`). Its doc-comment: *"the distribution plan widens this to local → installed → built-in via `resolveExtendsPath` … composes local/installed in front."* **That composition is your E1a.**
- Reuse `versionPin` / `migrationManifest` machinery from `libs/papercusp-export-state/src/manifest.ts` as the dep-manifest basis (D-004).
- **Citation fix:** the call-time `unknown_tool` gap is `apps/operator/lib/capabilities/invoke.ts:69` (the plan's old `dispatch-stack.ts:192` was wrong; role-gating is `libs/generic/tooldef/src/dispatch-stack.ts:201`).
- Today's `papercusp init --from <harness>` = **template-directory copy** (`libs/papercusp/packages/cli/src/papercusp.ts:859` `cmdInit`): copies `HARNESSES_DIR/<from>/*` (minus `*.tar.gz` + `papercusp.json`), copies the manifest → `.harness/papercusp.json`, then **auto-installs template-declared plugins (papercusp.ts:1022–1107 — REUSE this plugin install/enable machinery)**. Only built-in template = `sheets-clone`. `FLAGS.TEMPLATES` gates nothing today (orphan flag).

## Boundaries to settle with su-adb1b BEFORE building wiring
1. **`init` ↔ `harness:create`** must share ONE blueprint-instantiation path, not diverge. su-adb1b's `harness:create` (operator) instantiates blueprints → PG; the CLI `init --from` is the second entry. Agree where the shared instantiation logic + the **composition** + the **dep-validator** live — the orchestrator `blueprint/index.ts` is su-adb1b's hot file, so agree on "add exports there" vs "a sibling module" (note: `@papercusp/harness` → `@papercusp/orchestrator` would be circular, so the shared modules can't live in the harness package).
2. **template → blueprint migration (D-002):** `sheets-clone` (a template dir) becomes a blueprint + optional seed content. Confirm whether `harness:create` already handles seed content so `init` reuses it.

## Scope
- **E1a — composition (pure, unit-tested).** `makeComposedResolveExtends({ localDirs, installedDir })` → a `ResolveExtendsPath` that tries local (`<project>/.papercusp/blueprints/<id>/blueprint.yaml`) → installed (`~/.papercusp/blueprints/<id>/…`) → built-in (`resolveBuiltinExtends`). First hit wins.
- **E1b — `init --from` → blueprint instantiation.** Resolve+validate via `loadBuiltinBlueprint`/`resolveBlueprint` + the composition; write the resolved `.papercusp/blueprint.yaml` + `.papercusp/config.json` (instance fields) + optional seed content. Retire the `SPEC.md` default write (papercusp.ts:990).
- **E1c — retire `SPEC.md`** from `apps/operator/lib/harness-state-files.ts:17` (`PROJECT_FILES_TO_COPY`). *(apps/operator — hold for su-9e6b8's carve; confirm the file's new path if it moved into operator-core.)*
- **E2a — dep-validator (pure, unit-tested).** `validateBlueprintDependencies(deps, { availableTools:Set<string>, installedPlugins:Set<string>, cupboardPlugins?:Set<string> }) → { ok, missing:{tools,plugins}, messages:string[] }`. Inject the host sets through the seam (keeps it pure + borrowable).
- **E2b — wire it.** (i) CLI `init`: validate declared plugin deps resolve/install before instantiation. (ii) operator: call the validator at blueprint-load/`harness:create` against the in-process catalog (`getCatalog()`, `capabilities/invoke.ts`) — closes the `unknown_tool` gap. *(ii) is apps/operator + su-adb1b's harness:create — coordinate.)*

## Testing
Vitest for E1a + E2a (pure → trivial to cover thoroughly). A `cmdInit` integration test: `init --from coding` → a resolved+validated `.papercusp/blueprint.yaml`. A missing-plugin blueprint → upfront failure with "needs plugin X". Follow the **"Adding a tool"** discipline in `CLAUDE.md` for any new operator tool (`guidance`, register, `tools-md-sync` test).

## Done when
`papercusp init --from coding myproj` instantiates the coding blueprint (resolved, validated, declared plugins installed); a blueprint declaring an absent plugin fails **upfront**; `extends` resolves across local/installed/built-in; `init` and `harness:create` share one instantiation path.

## Do NOT
- author `research`/`research-base` (su-adb1b's P-017); edit the frozen loader files; build a divergent instantiation path; edit `apps/operator` during su-9e6b8's carve without coordinating the (possibly moved) paths.
