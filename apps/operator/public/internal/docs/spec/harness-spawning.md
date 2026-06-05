# Harness spawning
URL: /internal/docs/spec/harness-spawning

How harnesses spawn child harnesses, how parent_slug works, and how completion reporting flows back.

import { Aside } from '@astrojs/starlight/components';

Harness spawning is a substrate feature: any harness whose role config grants `scaffold_harness` in `allowedActions` can call the `/api/admin/execute-action` endpoint to materialize a child harness from a marketplace template.

## The verb

```ts
{ "op": "scaffold_harness",
  "projectSlug": "<unique-slug>",
  "template": "<spawnable-template-name>",
  "spec":  "<initial SPEC.md content>" }
```

`parent_slug` is **server-derived from the bearer token**, never accepted from the request body. This makes the parent/child relationship cryptographically sealed — a harness cannot claim someone else as its parent or claim parentage of a sibling.

## What happens on success

1. Executor verifies the `template` is in `GET /api/marketplace/spawnable` (rejects with 400 `template_not_spawnable` otherwise).
2. Slug uniqueness check against `harness_shared.projects` (409 `slug_already_in_use` on collision).
3. Shells out to `papercusp init <slug> --from <template>` with a 5-minute timeout.
4. Writes `SPEC.md` from the request body.
5. Generates a 256-bit `harness_token`, writes it to `<projectDir>/.papercusp/config.json` (mode 0600), and merges in `parent_slug = <derivedCallingHarness>` and `slug`.
6. Triggers `bin/scaffold-harness-schema.sh <slug>` to provision the per-harness PG schema (messages, supervisor\_notes, executed\_actions, config\_token, harness\_features, etc.).
7. Inserts the token into `harness_<slug>.config_token` and `harness_shared.token_index` for O(1) bearer→slug resolution.
8. Updates `harness_shared.projects.parent_slug` for cross-harness lineage queries.

## Failure modes & rollback

* **`papercusp init` exits non-zero**: rollback any partial directory creation. Returns `internal` with stderr.
* **5-minute timeout**: SIGTERM → SIGKILL the CLI process. Same rollback. Response includes `{ timeout: true }`.
* **Schema scaffold fails**: harness exists on disk + in file registry, but partial PG state. Idempotent retry with same `actionId` re-runs the scaffold script.
* **Token-mirror fails**: harness usable for reads but cannot authenticate its own outbound `executeAction` calls. Returns `internal`.

## Authoring a spawning harness

Set `roles.<role>.allowedActions` to include `scaffold_harness`:

```json
{
  "harness_kind": "org",
  "roles": {
    "director": {
      "allowedActions": ["spinup_project", "scaffold_harness", "send_message"]
    }
  }
}
```

The director's prompt sees the available templates listed in the Tier 3 capabilities section of its substrate context (sourced from `GET /api/marketplace/spawnable`).

See: [spawning-harnesses](/internal/docs/spec/spawning-harnesses), [spawnable-templates](/internal/docs/spec/spawnable-templates), [auth-and-identity](/internal/docs/spec/auth-and-identity).
