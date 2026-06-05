# Architecture
URL: /internal/docs/build-system/architecture

How a production Papercusp binary is laid out, what it spawns at startup, and how the browser webview finds the operator server.

:::caution\[Partly stale — the operator is Vite now, not Next.js]
The operator frontend migrated **Next.js → Vite** (`@papercusp/operator-vite`,
a TanStack-Router SPA). Read any "Next.js app / Next standalone / `next dev` /
`next start`" wording below as the **Vite** SPA (`:3055` dev) served by the
`:3070` **Hono host** (`bin/hono-host.ts`). `next dev`/`next start` are blocked
by `apps/operator/next.config.js`; `apps/operator/app/**` is dead code. See the
`operator-next-is-retired` insight.
:::

## Two repos, two stages

```
~/papercupai-workspace/
├── papercup/                 ← the operator (Vite SPA + Hono host + libs)
│   ├── apps/operator-vite/   ← @papercusp/operator-vite — the TanStack-Router SPA UI (:3055 dev)
│   └── apps/operator/        ← the Hono host (bin/hono-host.ts, :3070) + lib/bin/app page bodies
└── papercusp-desktop/        ← the Tauri shell (Rust)
    └── src-tauri/            ← main.rs + tauri.conf.json — produces the .deb/.dmg/.msi
```

`papercusp-desktop` is the wrapper. It bundles a built copy of `apps/operator` (Next.js standalone) as a **sidecar** and ships the Rust binary + sidecar in one installer.

## What a Tauri production build does at startup

`papercusp-desktop/src-tauri/src/main.rs` `setup()`:

1. **Find a free port** (e.g. `19210`)
2. **Spawn 5 sidecars** as child processes:
   * `embedded-postgres-server` — real PostgreSQL with `wal_level=logical`, listening on a second free port (e.g. `20721`), data dir `~/.papercusp-workspaces/<ws>/.papercusp/embedded-pg-data`
   * `operator-server` — the bundled `apps/operator` standalone, bound to `127.0.0.1:<port>`
   * `zero-cache` — replication sync layer for the browser-side Zero client
   * `code-server` — the bundled `code-server` (VS Code for the web), `127.0.0.1:19198`
   * `mcp-bridge` — Tauri's MCP bridge plugin (dev only, `127.0.0.1:9223`)
3. **Wait for the operator-server to emit `PAPERCUSP_IPC_READY socket=<path>`** on stdout
4. **`eval()` an init script into the webview** setting `window.__papercuspBase = 'http://localhost:<port>'`

The webview itself opens at `tauri://localhost/index.html` — a tiny bootstrap page (`papercusp-desktop/web/index.html`) that:

1. Waits for `window.__papercuspBase` to be set by step 4
2. Polls `<base>/api/desktop/preflight` until `{ok: true}`
3. `location.replace(<base>/harness)` to hand off to the real operator UI

After step 3, the webview is at `http://localhost:19210/harness` (or whatever port). Every fetch from there is same-origin. Tauri's IPC (`invoke()`) works alongside HTTP because the page is in a Tauri webview.

## What dev mode does instead

`tauri dev` sets `cfg!(debug_assertions) == true`, which makes `main.rs` `setup()`:

1. **Skip the sidecar spawn entirely** — the developer is expected to run `npm run dev` separately on `:3055`
2. **Open devtools automatically** (WebKitGTK doesn't reliably wire Ctrl+Shift+I)
3. Webview loads `http://127.0.0.1:3055` directly (`devUrl` in `tauri.conf.json`)

So a dev Tauri window IS just a Tauri webview pointed at the live Vite dev server on `:3055` (with the Hono host on `:3070`). Production is the same UI code but served from the bundled sidecar on a private port.

## Where the operator code lives in a prod bundle

After `npm run build` (which runs `apps/operator desktop-build` followed by `tauri build`):

```
/usr/lib/Papercusp/                          # Linux .deb install root
├── papercusp-desktop                        # main Tauri binary
├── resources/
│   └── _up_/libs/papercusp/libs/db/         # bundled SQL files
└── sidecar/
    ├── operator-server/                     # apps/operator/.next-prod/standalone — Next standalone
    │   ├── server.js
    │   ├── node_modules/
    │   ├── .next/
    │   └── apps/operator/
    ├── embedded-postgres-server/            # @embedded-postgres bundle + the embedded-postgres-server.js wrapper
    ├── code-server/
    ├── zero-cache/
    └── node/bin/node                        # bundled Node 22 runtime (Mac/Linux only)
```

Mac is the same shape inside `Papercusp.app/Contents/Resources/`. Windows under `C:\Program Files\Papercusp\`.

## The bundled Node binary (`bundled_node` resolver)

`main.rs` has a `bundled_node()` function that returns the absolute path to the shipped `node` binary. **All sidecar spawns use this path explicitly** rather than `which node` because GUI-launched apps inherit `$PATH = /usr/bin:/bin` on macOS — Homebrew's `node`, `nvm` Node, etc. won't be visible. Without this, `pg_dump` and `libpq` discovery would also break on Mac.

## The embedded-PG discovery file

On boot, `main.rs` writes `~/.papercusp/embedded-pg.json` containing:

```json
{
  "pid": 877130,
  "adminUrl": "postgresql://harness_admin:...@127.0.0.1:20721/papercusp",
  "appUrl":   "postgresql://harness_app:...@127.0.0.1:20721/papercusp",
  "port": 20721,
  "startedAt": "2026-05-13T12:56:00Z"
}
```

Three rules:

* The webapp (`apps/operator`) reads this via `getHarnessAdminUrl()` in `apps/operator/lib/embedded-pg-discovery.ts`. **Never hard-code `:5432` or `:16534` anywhere** — always resolve through this helper. The central connection resolver in `libs/papercusp/libs/db/src/connection.ts` already does this; new code should call the helper.
* The file is **PID-owned**. On `RunEvent::Exit` and `WindowEvent::CloseRequested`, `main.rs` calls `delete_pg_discovery_file_if_owned()` which only deletes if `pid` matches the current process. This means two desktop instances won't fight over the file.
* Native PG (`:5432`) is for Restart / paperclip / marketplace. **`papercusp` itself never touches native PG** — that DB has been renamed to `papercusp_native_backup` since 2026-05-11.

## What gets *built* vs. what gets *shipped*

* **Built** but **not shipped**: anything under `apps/operator/.next/` (dev cache), `target/debug/`, `node_modules/.cache/`. The auditor (`bin/audit-bundle.sh`) scans the *installer* contents, not the build directory.
* **Built and shipped** but **not loaded at runtime in prod**: `web/index.html` only runs during the brief bootstrap; `tauri.conf.json`'s `devUrl` is dev-only and never read in a release binary.
* **Built and shipped and active**: everything in `sidecar/`. Each sidecar is spawned at boot and runs for the lifetime of the Tauri window.

## A note on Linux WebKit quirks

WebKitGTK is what wry uses on Linux. Two recurring issues we've documented elsewhere:

* **The "duplicate dashboard" bug** — was caused by server-side compile errors (`postgres` driver in client bundle) producing a Next.js error overlay that left the layout tree double-mounted. **Fixed** by `'use server-only'` guards in `lib/sync-sse.ts` + `lib/operator-scans.ts` plus the `<div id="papercusp-app">` wrapper in `app/layout.tsx` so React hydrates a real child of `<body>` instead of `<body>` itself. See [troubleshooting](/internal/docs/build-system/troubleshooting).
* **The "access control checks" CORS-on-same-origin spam** — wildcard `Access-Control-Allow-Origin: *` headers added in `next.config.js`. Same origin requests in WebKitGTK occasionally trip its strict CORS path when `Vary` headers are present. The wildcard is a no-op for production (where the sidecar serves itself) so there's no security cost.
