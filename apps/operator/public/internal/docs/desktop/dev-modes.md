# Dev modes — HMR vs. rebuild-watch vs. prod-preview
URL: /internal/docs/desktop/dev-modes

Three ways to run the Tauri desktop in dev. Pick the one whose tradeoffs match what you're doing.

The operator-vite SPA can be served to `tauri dev` three ways. They use
different ports and the choice has real implications for what bugs you
see.

## TL;DR

|                                           | `bin/desktop-dev` (HMR)         | `bin/desktop-dev-nohmr` (rebuild-watch)           | `bin/desktop-preview-prod` (prod-preview) |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| URL Tauri loads                           | `http://localhost:3055`         | `http://localhost:3070`                           | `http://localhost:4173`                   |
| Frontend process                          | `vite` (dev server)             | `vite build --watch` → `apps/operator-vite/dist/` | `vite build` → `vite preview`             |
| Server in front                           | Vite dev middleware             | Hono host (`host-spa.ts`, Phase G3)               | `vite preview` (static)                   |
| `import.meta.env.PROD`                    | `false`                         | `false`                                           | `true`                                    |
| React build                               | dev (warnings, dev checks)      | dev                                               | **prod (minified)**                       |
| Minification                              | none                            | none                                              | **terser**                                |
| Update on save                            | Hot-reload, state preserved     | Manual reload (Ctrl-R), state lost                | Rebuild + reload manually                 |
| Rebuild latency                           | \~10ms per HMR patch            | \~200-500ms per incremental rebuild               | full `vite build`                         |
| `ws://localhost:3055/?token=…` in console | Yes (Vite HMR socket)           | No                                                | No                                        |
| Path-equivalence to prod                  | ⚠ different from `tauri build`  | ✓ same code path as `tauri build` (dev mode)      | ✓✓ identical to what users install        |
| libsoup-pool exhaustion risk              | Yes (HMR + SSE both long-lived) | No                                                | No                                        |

## When to use HMR (`bin/desktop-dev`)

The default for active UI iteration. State preservation between saves
matters when you're working on a deeply-nested view that takes effort
to navigate to. The cost is divergence from prod: HMR injects
additional runtime modules, the dev server transforms code differently
than `vite build`, and the HMR WebSocket eats one of WebKitGTK's six
per-host connections, which can starve `fetch()` and SSE producers.

## When to use rebuild-watch (`bin/desktop-dev-nohmr`)

Reach for this when:

* You're chasing a bug you can't reproduce in HMR mode — the prod
  bundler path is meaningfully different, and bugs that hide behind
  HMR's loose module resolution surface here.
* You're debugging connection-pool / SSE / fetch behavior. HMR's
  long-lived WebSocket is itself a pool consumer; rebuild-watch
  removes it.
* You want a clean console. No HMR connect/disconnect chatter, no
  `ws://localhost:3055/?token=` line.

## Wiring

Two processes run in parallel:

```bash
# 1. From the papercup repo — rebuild apps/operator-vite/dist/ on every save.
cd /path/to/papercupai-workspace/papercup
npm run dev:operator:nohmr

# 2. From the papercusp-desktop repo — Tauri dev pointing at :3070.
cd /path/to/papercusp-desktop
bin/desktop-dev-nohmr
```

The Hono host at `:3070` is already running (the prod operator process
serves `apps/operator-vite/dist/` via `host-spa.ts` whenever the file
exists). `vite build --watch` writes a fresh dist on every save; the
Hono host re-reads index.html on each request, so reload in the Tauri
webview to pick up changes.

## Under the hood

`bin/desktop-dev-nohmr` is a one-line wrapper:

```bash
npm run tauri -- dev --config '{"build":{"devUrl":"http://localhost:3070"}}'
```

The `--config` flag accepts a JSON5 string that's deep-merged over
`tauri.conf.json`. Only `build.devUrl` is overridden — everything
else (the dev-time `beforeDevCommand`, the `frontendDist`, the
Tauri-side identifiers) stays as defined for the standard dev flow.

`npm run dev:operator:nohmr` resolves to
`npm --workspace @papercusp/operator-vite run dev:nohmr` which runs
`vite build --watch --mode development`. The `--mode development`
keeps sourcemaps and unminified output; the bundler path is otherwise
identical to `vite build`.

## When to use prod-preview (`bin/desktop-preview-prod`)

Reach for this when you need to know how the bundle will actually
behave for a real user:

* **Hunting prod-only bugs** — code paths that only run when
  `NODE_ENV === 'production'` (PostHog batching cadence, telemetry
  flush behavior, error-boundary fallbacks without React's dev
  enhancements).
* **Sanity-checking perf claims** — terser-minified bundles parse and
  run measurably faster than dev bundles; "feels snappy in dev"
  doesn't survive minification regressions like unintentional `eval`
  paths or barrel-import bloat.
* **Verifying the release before `bin/release-local.sh`** — same
  bundler output, same React runtime, just without the .deb/AppImage
  packaging step.

Wiring:

```bash
# 1. Build the prod bundle once (or run in a watch loop if iterating).
cd /path/to/papercupai-workspace/papercup
cd apps/operator-vite && npm run build

# 2. Launch the desktop pointed at the prod bundle.
cd /path/to/papercusp-desktop
bin/desktop-preview-prod
```

The launcher starts `vite preview` on `:4173` as a background child
(killed on Tauri exit), waits for it to come up, then launches
`tauri dev` with `build.devUrl=http://localhost:4173`. The
`/api/*` calls go to whatever backend the prod bundle expects —
typically the operator process on `:3070` (the `papercup-dev` systemd
unit), so that needs to be running.

Note: `vite preview` is a static server, not a watcher. To pick up
edits, re-run `npm run build` and reload the Tauri webview
(Ctrl-R / Cmd-R).

## Gating dev-only UI: use `MODE`, not `DEV`

A dev-only surface — the **dev admin rail**
(`apps/operator-vite/src/components/dev-admin-rail/`, plan
`dev-admin-sidebar-2026-06-05`) is the worked example — must show in the dev
shells above but be **absent from the shipped build**. The non-obvious part: gate
it on **`import.meta.env.MODE !== 'production'`**, *not* `import.meta.env.DEV`.

`DEV`/`PROD` follow the **command** (`vite` serve vs `vite build`); `MODE` follows
`--mode`. The default desktop dev (`bin/desktop-dev-nohmr`) is a `vite build`, so
`import.meta.env.DEV` is **`false`** there — a `DEV`-gated surface compiles away
and never appears in the very desktop it's for. Only `MODE` is `development` in
**both** dev shells (HMR + nohmr) and `production` in the shipped `vite build`.
Because `MODE` is a static string, a `MODE`-gated `lazy(() => import(...))` is
dead code in prod and Rollup drops the whole chunk (rail JS *and* CSS).

Full rationale, the CSS-leak/class-prefix gotchas, and the build-grep that proves
absence: [Gate dev-only UI on MODE, not DEV](/internal/docs/agent-insights/dev-only-ui-gating-mode-not-dev).

## Next.js is retired

The operator frontend is Vite-only. `next dev` and `next start` are
**blocked** — a guard at the top of `apps/operator/next.config.js`
throws if either subcommand is detected, so an accidental `npm run`,
an `npx next dev`, or stale muscle memory can't bind `:3055` or
`:3070` and shadow the real servers.

The `apps/operator` npm scripts are Vite equivalents:

| `apps/operator` script | Runs                                             |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | `vite` — the operator-vite dev server (`:3055`)  |
| `npm run build`        | Starlight docs build + `vite build`              |
| `npm run start`        | `tsx bin/hono-host.ts` — the Hono host (`:3070`) |

`bin/dev` runs the dev server as a systemd unit; `bin/prod` builds the
operator and runs the Hono host. Neither invokes `next`. `next build`
is still allowed (it binds no port) for reference tooling — it is
removed outright in Phase H.
