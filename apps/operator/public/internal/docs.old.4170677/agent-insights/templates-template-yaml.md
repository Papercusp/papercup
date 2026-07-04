# Templates — template.yaml schema
URL: /internal/docs/agent-insights/templates-template-yaml

The machine-readable half of a template — the template.yaml manifest schema, validation rules, and the retro-fitted agentic-desktop-app reference manifest. Projection of @papercusp/template-kit.

**Status:** the P-005 template manifest schema for the templates system
([design of record](/internal/docs/agent-insights/templates-system-design) ·
[component catalog](/internal/docs/agent-insights/templates-component-catalog)).
**Machine source of truth:** `@papercusp/template-kit` —
`libs/generic/template-kit/src/template-manifest.ts` (`validateTemplateManifest`,
`parseTemplateManifest`, `validateTemplateAgainstCatalog`). **Edit the code first**,
then mirror this page.

`template.yaml` is the machine-readable half of a template — what the Cupboard
listing and the materializer read. It says *what exists*; `GUIDE.md` says *how to
think about composing it*. Validation is **pure and zero-dep**: the consumer parses
the YAML with whatever loader it already has and hands the object to the validator
(the kit never takes a yaml runtime dependency).

## The schema

| Field            | Type                                | Meaning                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | kebab string                        | template id, unique across the template set                                                                                                                                                                                                                            |
| `version`        | semver                              | version of the template itself                                                                                                                                                                                                                                         |
| `scope`          | `app` \| `aspect`                   | whole-app scaffold vs a capability composed *into* an app ([D-006](/internal/docs/agent-insights/templates-system-design#definition))                                                                                                                                  |
| `summary`        | string                              | one-paragraph description — the Cupboard listing text                                                                                                                                                                                                                  |
| `components`     | `{ id, version }[]`                 | **version-pinned catalog refs, never vendored copies**; `id` = [component catalog](/internal/docs/agent-insights/templates-component-catalog) id, `version` = exact semver pin. Non-empty UNLESS the template is a pure composition (non-empty `composesWith`) — P-014 |
| `blueprints`     | kebab string\[]?                    | OPTIONAL starter blueprint dirs under `blueprints/` — a design-adoption template ships none                                                                                                                                                                            |
| `contracts`      | kebab string\[]                     | typed seam-contract template names under `contracts/` (may be empty for templates that don't cross the seam)                                                                                                                                                           |
| `decisionPoints` | `{ id, prompt }[]`                  | declared decision points — where agent judgment is explicitly invited; GUIDE.md expands each prompt                                                                                                                                                                    |
| `composesWith`   | kebab string\[]                     | template ids this template is designed to stack with (composition **semantics** = P-014)                                                                                                                                                                               |
| `checks`         | `{ id, run, summary? }[]` non-empty | the acceptance suite — `run` is the template-relative entry. **Non-empty by rule: checks are the load-bearing replacement for the old deterministic generator**                                                                                                        |

Uniqueness is enforced within a manifest: no duplicate component refs, decision
point ids, or check ids. All ids are kebab-case; all versions are exact semver
(`x.y.z` — never a range).

## Validation surfaces

* `validateTemplateManifest(raw)` — untrusted parsed object → `{ ok, errors[] }`,
  collecting **every** problem (never throws).
* `parseTemplateManifest(raw)` — fail-loud form: typed `TemplateManifest` or one
  `Error` listing all problems.
* `validateTemplateAgainstCatalog(manifest, COMPONENT_CATALOG)` — every component
  ref must resolve to a catalog id **and its pin must match the catalog's current
  version**. The catalog carries exactly one living version per component, so a
  mismatched pin is rot, not history — update whichever side is stale. The anti-rot
  gym (P-009) re-runs this.

## Composition semantics (P-014)

One app = a composition of MANY templates. The machine half lives in
`src/composition.ts`; the rules:

* **`validateTemplateSet(entries)`** — registry-level anti-rot over the whole
  template set: every entry validates, template ids are unique, every
  `composesWith` reference resolves within the set.
* **`composeTemplates(templates)`** — resolves ONE app's selection into a
  `TemplateComposition`, enforcing: **at most one `scope: app` template** per
  composition; **component pin consistency** (the same component pinned at two
  versions across the selection is an error, never silently resolved); and the
  **additive union** — components deduped, while blueprints / contracts /
  decisionPoints / **checks** keep their source template id.
* **The union-of-checks is the load-bearing rule:** an app built from N
  templates must pass ALL N templates' checks (key by `templateId:checkId` —
  ids are unique per template, not per composition). This is what keeps
  free-form composition safe without a deterministic composer.
* `composesWith` is a design-affinity declaration, not a dependency edge — a
  composition may include templates that never name each other.

v1 = schema support + these semantics + manual composition documented in each
GUIDE; automated composition **tooling** (a materializer walking `composesWith`
and prompting per decision point) is v1.1 and sits on top of this pure module.

## The reference templates

`src/reference-templates.ts` holds template #1 **retro-fitted from what
quartermaster actually is** (P-005 acceptance), split three ways per P-014's
one-app-many-templates directive:

| Template              | Scope   | Carries                                                                                                                                                                                                                                                                   |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `papercusp-ops-hives` | aspect  | the judgment plane + the ONE seam: both Tier B components (`hive-app-seam`, `typed-contracts`), starter blueprints `ops-hive` + `member`, the `candidate-set` contract template, 5 domain decision points, checks `confinement-guard` / `seam-round-trip` / `gym-signals` |
| `tauri-desktop-shell` | aspect  | the deterministic chassis: `tauri-shell`, `hono-host`, `embedded-postgres-server`, `tauri-release-kit`; decision points `ui-shape` + `app-identity`; check `boot-e2e`                                                                                                     |
| `agentic-desktop-app` | **app** | a THIN pure composition of both (zero own components — allowed exactly because `composesWith` is non-empty); decision point `domain`; check `composition-integrity`                                                                                                       |

Composed, they yield exactly the two-plane construction and the four flagship
checks ([design doc §checks](/internal/docs/agent-insights/templates-system-design#checks--what-green-means))
plus `composition-integrity`.

These are **drafts of the shippable templates**: P-006 writes the GUIDE.md +
starter blueprints + contract templates around them; P-007 makes `checks/`
real; P-013 (consumer #1) re-materializes quartermaster's agentic plane from
them. The suite validates each standalone, as a set, composed, and against
`COMPONENT_CATALOG`, so catalog drift breaks the kit's tests loudly.
