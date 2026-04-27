# Papercusp web app — development tree

> **Two-tree architecture.** This directory (`apps/papercusp/`) is the
> **active development tree**. New features land here first. The Papercusp
> framework's public-face copy lives in the `papercupai/papercusp` git
> submodule at `libs/papercusp/apps/web/` — features get promoted there
> when stable. See [**ARCHITECTURE.md**](../../ARCHITECTURE.md#two-papercusp-web-trees) for details.
>
> | Tree | Path | Purpose | Consumed by |
> |---|---|---|---|
> | Dev | `apps/papercusp/` | Active development; ships in desktop bundle | `bin/build-desktop-sidecar.sh`, `:3055` dev server |
> | Public | `libs/papercusp/apps/web/` (submodule) | Public framework face; canonical when submodule is used standalone | External consumers cloning the submodule |
>
> Both share the same npm package name (`@papercusp/web`) and would collide
> as workspace members — `apps/papercusp` is `!`-excluded from the root
> workspace as a result. Workspace-internal deps in this tree use `file:`
> paths and resolve via `npm install` inside this directory.

The open-source autonomous-harness framework — the hosted web app + marketplace API.

This app powers `papercuspai.com`. It serves:

- The marketing homepage at `/`
- A signup stub at `/signup`
- The harness marketplace at `/marketplace` (browse + install command)
- Settings at `/settings/*`:
  - **API keys** (`/settings/api-keys`) — writes `~/.papercusp/credentials.json`
  - **Profile** (`/settings/profile`) — writes `~/.papercusp/profile.json`
- Harness control panel at `/harness/*` (Stage 3 — currently redirects to the legacy admin)

## Prerequisites

- **Postgres 16+** running locally (or anywhere reachable). Quick start:

  ```sh
  docker compose -f docker-compose.papercusp.yml up -d postgres
  bin/papercusp-init-db.sh
  ```

  This creates the `papercusp` + `papercusp_test` databases, the
  `harness_app` / `harness_admin` roles, and applies the framework DDL plus
  the Papercup demo's extra DDL.

- **Anthropic API key**. The harness invokes `claude -p` for every role.
  Add yours at `/settings/api-keys` once the dev server is up.

- **Node 22+**.

## Dev

```sh
# from repo root
npm install --legacy-peer-deps
npm run dev:papercusp        # port 3055
npm run dev:marketplace      # port 3057 — the catalog tarball server
npm run dev:papercup         # port 3061 — the first demo install
```

Or all at once via Overmind: `bin/overmind-all start`.

## Architecture

- `apps/papercusp/` — this app (the framework's web UI).
- `apps/papercusp-marketplace/` — Hono service backing `/api/marketplace/catalog`.
- `apps/papercup/` — Papercup demo, the first reference install of Papercusp.
- `packages/papercusp-harness/` — the harness substrate (`run.sh`, prompts, identity, templates).
- `packages/papercusp-plugin-sdk/` — TypeScript types for plugin authors.
- `libs/db-org/` — Postgres connection + Drizzle schema (framework tables).
- `libs/papercup-db/` — Drizzle schema for Papercup-specific tables (`papercup_shared`).

See `PLAN.md` at the repo root for the staged migration roadmap.

## What stays local

API keys (`~/.papercusp/credentials.json`) and profile preferences
(`~/.papercusp/profile.json`) are written to disk on the user's machine,
mode 0600. Even when cloud sync ships, the API keys never leave your machine.
