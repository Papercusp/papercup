# Templates — composable units for agent-composed apps
URL: /internal/docs/agent-insights/templates-system-design

Design of record for the templates system — components + GUIDE + checks; tier model; composition semantics; consumers; Cupboard distribution. Owner-approved 2026-07-04.

**Status:** design of record for plan `app-templates-2026-07-04` (owner-approved 2026-07-04).
**Audience:** any agent asked to build an app (or an app-aspect) on papercusp, and anyone
extending the template system itself.

## Why this exists

Papercusp had an explicit **deterministic build system** for stamping out apps. It was
retired: it guaranteed correctness *by construction*, which made it rigid — it had to
anticipate every app shape. Models got smarter; the apps that actually shipped on the
framework since (**oddsmith**, **quartermaster**) were composed *by agents* out of shared
libraries plus written guidance (`BORROWABLE.md`, the oddsmith mirror docs) plus judgment.

The **templates system** formalizes what already worked, with the guarantee moved to the
other end: **correctness by verification, not construction.** A template gives an agent
vetted deterministic components, composition guidance, and a shipped acceptance suite; the
agent composes freely and must end green.

## Definition

A **template** is a distributable unit of:

1. **Components** — vetted deterministic code (referenced, version-pinned published
   packages — never vendored copies).
2. **Guidance** — `GUIDE.md`, a composition prompt written for the *building agent*, in
   MUST / SHOULD / FREE tiers, with **declared decision points** where agent judgment is
   explicitly invited.
3. **Checks** — `checks/`, the acceptance suite any composition must pass. This is the
   load-bearing replacement for the deterministic generator, not decoration.

Templates are **scope-generic** (owner decision D-006): `scope: app` (a whole-app
scaffold, e.g. `agentic-desktop-app`) or `scope: aspect` (a capability or adaptation
composed *into* an app, e.g. `papercusp-ops-hives`, `adopt-papercusp-design`,
`add-release-pipeline`). **One app is constructed by composing many templates.**
Blueprints are *optional* content — a design-adoption template ships none.

## The hive-app pattern (what the flagship templates encode)

The construction quartermaster and oddsmith instantiate, and the shape the template system
must reproduce:

* **Two planes.** A *deterministic app plane* (ordinary code: ingest, storage, drivers,
  ledgers — plain TypeScript packages, embedded PG, a Node sidecar, a thin Tauri shell)
  and a *judgment plane* (papercusp hives: a domain hive + an `-ops` hive over it — the
  Queen surveying a backlog and placing member harnesses).
* **Exactly ONE seam.** `work_items` of a declared kind go *up* into the hive; a typed
  contract (quartermaster's `CandidateSet` is the exemplar) comes *down* through a single
  parse gate into an app table. Nothing else crosses.
* **Confinement is inviolable and enforced at install** via role capability envelopes +
  gym signals. The canonical statement of the confinement rule for a given app lives in
  that app's `blueprints/README.md` (see quartermaster's, the exemplar) — this doc and
  every template GUIDE **point at it and never restate it**, so it cannot drift.

## The tier model (owner decision D-002)

Where the system's primitives (definetools, events, work\_items, capability envelopes) are
*enforced* — and where they deliberately are not:

| Tier                         | What                                                                     | Constraint                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — plain components**     | ordinary libraries (ingest, db, grids, release-kit)                      | none beyond a manifest + their own tests; the agent may modify freely                                                                                  |
| **B — seam components**      | anything agent-facing: work\_items enqueue/ingest, events, exposed tools | MUST use the blessed primitives — typed contracts, capability envelopes, gym signals. This is what buys observability, Queen dispatch, and confinement |
| **C — guardrail components** | the vault/approval-gate analogs                                          | sealed: configure yes; rewrite only with loud disclosure and the guardrail checks still green                                                          |

Rationale: quartermaster/oddsmith's deterministic planes are plain packages — that's what
made them fast, testable, portable. Safety lives at the seam, so uniformity is enforced
only there.

## Template anatomy

```
templates/<id>/
  template.yaml     # machine-readable manifest: id, version, scope (app|aspect),
                    #   components[] (version-pinned package refs), blueprints[]?,
                    #   contracts[], decisionPoints[], composesWith[], checks
  GUIDE.md          # the composition prompt (MUST / SHOULD / FREE + decision points)
  blueprints/       # OPTIONAL starter blueprints (ops-hive extends work, member
                    #   extends research; placeholder lexicon)
  contracts/        # typed seam-contract templates (the CandidateSet analog)
  checks/           # acceptance suite (see below)
  reference/        # pointers to worked examples (quartermaster, oddsmith)
```

`template.yaml` says *what exists*; `GUIDE.md` says *how to think about composing it*.

The components a template references are catalogued — manifest format, tiers, and the
current entries — in the
[component catalog](/internal/docs/agent-insights/templates-component-catalog)
(machine source: `@papercusp/template-kit` `COMPONENT_CATALOG`, P-004). The
`template.yaml` schema itself — fields, validation rules, and the retro-fitted
`agentic-desktop-app` reference manifest — is documented in
[template.yaml schema](/internal/docs/agent-insights/templates-template-yaml)
(machine source: `@papercusp/template-kit` `template-manifest.ts`, P-005).

## Composition (owner decision in P-014)

* `scope` + `composesWith` declare how templates stack; an app-scope template is typically
  a thin composition of aspect templates (e.g. `agentic-desktop-app` =
  `papercusp-ops-hives` + `tauri-desktop-shell` + glue guidance). **Realized in P-014**:
  template #1 IS that 3-way split — see the
  [reference templates](/internal/docs/agent-insights/templates-template-yaml#the-reference-templates).
* **Checks compose additively:** an app built from N templates must pass the **union** of
  their checks. That rule is what keeps free-form composition safe without a deterministic
  composer. Machine form: `@papercusp/template-kit` `composeTemplates` (union-of-checks,
  pin-consistency, at-most-one-app-scope) + `validateTemplateSet` —
  [semantics](/internal/docs/agent-insights/templates-template-yaml#composition-semantics-p-014).
* v1 ships schema support + these semantics + manual composition documented in each GUIDE;
  automated composition tooling is deferred (v1.1) and sits on top of the pure module.

## checks/ — what green means

Every template ships app-parameterized checks; the flagship set:

1. **Confinement guard** — no hive role holds cart/checkout/vault/approvals-write-analog
   capabilities.
2. **Seam round-trip** — enqueue a work\_item → complete it with a payload → the contract
   parse gate ingests it → the app table row exists.
3. **Boot E2E** — the composed app builds, the sidecar spawns, the discovery file is
   written, health returns 200.
4. **Gym signals installed** — the hive's guardrail signals are present and wired.

An agent may compose however it judges best; **"done" is defined by these going green.**

**Landed (P-007):** the runnable suites live in the repo `templates/<id>/checks/` dirs —
PORTABLE `*.test.ts` files (devDeps: `vitest` + `yaml` only) the materializer copies
verbatim into a composed app, parameterized via a JSON config named by the
**`TEMPLATE_CHECKS_CONFIG`** env var (canonical schema: `@papercusp/template-kit`
`TemplateChecksConfig`, `checks-config.ts`). Unconfigured, a check SKIPS — copying never
breaks an unwired repo. `composition-integrity` is the exception: it validates the
template SET via the kit, and runs continuously in-repo as the `@papercusp/templates`
workspace suite. `boot-e2e` has two modes (`spawn` = full lifecycle incl. SIGTERM
cleanup, for CI/gym; `attach` = assert a live instance, because the discovery file is a
per-user singleton). The worked consumer-#1 config —
`templates/agentic-desktop-app/reference/quartermaster.checks-config.json` — runs the
whole union green against quartermaster as-is: its blueprints hold no dangerous
capability, its contract gates round-trip + reject, its four gym signals are declared,
and its live sidecar answers health 200.

## Decision points — legible non-determinism

Each GUIDE declares where judgment is invited (seam work\_item kind, contract shape,
lexicon, domain roles, width knob, UI shape…). Everything not MUST or a sealed guardrail
is FREE. This is deliberate: the failure mode of the old system was rigidity; the failure
mode to guard against now is *illegible* improvisation — declared decision points make the
agent's choices reviewable.

## Consumption flow

1. User: *"build me an app for X using the `<id>` template"* (or an agent recognizes the
   ask shape — see the guidance rule, plan P-012).
2. Materialize the template (Cupboard fetch or repo `templates/` dir) into a workspace —
   the `scaffold_harness` "from-template" entry is a *thin materializer*, nothing more.
3. The agent reads `GUIDE.md`, walks the decision points, composes components, generates
   the app-specific pieces (contracts, lexicon, UI, domain roles).
4. Runs `checks/` until green; ships with the decisions disclosed.

## Distribution

* **v1 source of truth** (P-006/D-005): the papercup repo **`templates/<id>/`** dir —
  versioned, git-synced, gym-readable. Template #1's three dirs live there now
  (`agentic-desktop-app`, `papercusp-ops-hives`, `tauri-desktop-shell`: template.yaml +
  GUIDE.md + starter blueprints + the candidate-set contract template), pinned to
  `@papercusp/template-kit`'s reference manifests by the kit's test suite (drift fails
  loudly).
* **Cupboard/Comb** gets a dedicated **Templates section** (`kind=template`) alongside
  blueprint/plugin/snapshot listings (plan P-010) — it *projects* from the repo dir.
  **Landed (P-010):** `template` is a full listing kind end-to-end. Worker: D1
  migration 010 (the 008-skeleton CHECK rebuild, carrying 009's `blueprint_kind`)
  * `template` in the route layer's `LISTING_KINDS` and — because a template's
    GUIDE.md is a composition prompt injected into the building agent's context —
    in `REVIEW_POLICY_KINDS` (D-007: publishes land `pending`, publicly invisible
    until operator approval at `/admin`). Operator: `template:publish` (agent tool —
    lists `<repo>/templates/<id>/` repo-backed, listing\_ref = template id) and
    `POST /api/cupboard/install-template` (resolve listing → shallow-clone →
    kit-validate schema + component-catalog pins → place under
    `~/.papercusp/templates/<id>/`, where the P-011 materializer reads it; core:
    `operator-core/lib/cupboard/install-template-core.ts`, DI'd + unit-tested).
    UI: a **Templates** tab in the Cupboard storefront (`?kind=template`). The
    official set publishes under **"Papercusp Official:"** titles (owner directive
    2026-07-04).
* **Naming caution (D-006):** `scaffold_harness`'s existing spawnable-catalog entries are
  also called "templates". These must be **unified** — the old spawnables become instances
  of this system — never two meanings of the word in one product.

## Consumers & anti-rot (owner decision D-007)

* **Consumer #1** is the **2-hive ops construction** itself: retrofit quartermaster so its
  agentic plane + app skeleton are materialized/validated *from* the templates
  ("as-if-template-built" made literal). Validates against reality first, and stops our
  own apps drifting from the pattern. **Landed (P-013):** quartermaster consumes
  `@papercusp/hive-app-seam` (`libs/hive-app-seam`) for its agentic plane, and carries
  `packages/template-checks/` — the four portable suites copied verbatim + its
  checks-config + a `DECISIONS.md` disclosing every GUIDE decision point; the union runs
  green from the quartermaster root via `npm run template-checks` (unconfigured runs
  skip, so the root suite stays safe).
* **Consumer #2** is a **new simple greenfield app** (owner picks it after #1 lands) — the
  true no-hand-holding test, because a retrofit lets author knowledge leak in.
* **Template gym:** a cadence routine rebuilds consumer #1's composition from the
  templates and runs its checks; a red auto-files a template-drift work-item. *The
  template is tested by building an app from it.* **Landed (P-009):** the
  `template-gym` system routine (`system:template-gym`, every 6h — seeded ACTIVE;
  `packages/operator-core/lib/harness/routines/template-gym-{runner,action}.ts`)
  re-verifies five legs: the P-013 verbatim-materialization invariant
  (`templates/<id>/checks` ⇄ quartermaster `packages/template-checks`,
  byte-identical), docs⇄catalog drift (`COMPONENT_CATALOG` ids ⊆ the catalog
  page), the kit's manifest drift pins, the `@papercusp/templates` suite, and
  consumer #1's configured union inside the quartermaster repo. A standing RED
  auto-files ONE `template-drift` work-item (stable watchdogKey, exact-lookup
  dedup); advisory — it never gates. On-demand:
  `npx tsx packages/operator-core/lib/harness/routines/template-gym-runner.ts`;
  history at `~/.papercusp/template-gym/`.

## Roadmap

The work items, dependencies, and open owner forks live in plan
**`app-templates-2026-07-04`** (papercusp plan store) — 14 items across design →
component extraction (`@papercusp/hive-app-seam` first) → template #1 set → consumers →
Cupboard/menu/persona surfaces.
