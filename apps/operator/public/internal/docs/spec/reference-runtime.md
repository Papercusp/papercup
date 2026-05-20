# 12. Reference runtime walkthrough
URL: /internal/docs/spec/reference-runtime



PathContains

`libs/papercusp/packages/harness`The substrate: `run.sh`, `prompts/`, role templates. The thing that boots an iteration loop.
`packages/papercusp-plugin-sdk`TypeScript types for plugin authors. `PapercuspPlugin`, `RoleDefinition`, `UiContribution`, `Capability`, etc.
`packages/papercusp-plugin-loader`Discovers plugins, validates manifests, applies migrations, registers routines, mounts hooks/tabs/routes, enforces capabilities.
`libs/papercusp/libs/db`Drizzle schema for the substrate (goals, tasks, issues, pending\_events, routines, audit).
`libs/papercusp/apps/web`The substrate's web UI + Hono API (was `apps/papercusp`; moved into the papercusp submodule). Marketplace browser, install settings, harness control panel. Runs on `:3055`.
`libs/papercusp/apps/marketplace-api`The marketplace tarball/catalog server. Hono on Node, filesystem-backed (`~/.papercusp/marketplace-storage/`). Runs on `:3057`. See §11.4.
`libs/papercusp/apps/marketplace-site`Public-facing marketplace site at papercuspai.com. Static Next.js export deployed to Cloudflare Pages. See §11.4.
`apps/papercup`Reference install — 5-director autonomous AI company demo. Currently lives in the Restart monorepo and runs as its own Next.js app (`:3061`); not yet published as a marketplace tarball (see §11.5 update flow).
