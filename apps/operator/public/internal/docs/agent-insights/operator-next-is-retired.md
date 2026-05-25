# Operator Next app is retired — ship UI in operator-vite only
URL: /internal/docs/agent-insights/operator-next-is-retired

The Next.js operator app at `apps/operator/app/**` no longer serves the live Tauri shell. Routes there are dead code. All new UI ships in `apps/operator-vite/src/routes/**` as TanStack-Router file routes. API routes still live in apps/operator/lib/endpoint-route/ and are mounted by bin/hono-host.ts.

## What's true now

* `:3070` is served by **operator-vite** (a TanStack Router SPA bundle
  produced by Vite, run via the `bin/hono-host.ts` Hono server).
* `apps/operator/app/**` (Next-style `page.tsx` files) is **dead
  code**. Pages there compile in the type-checker but no request
  ever reaches them.
* `apps/operator/lib/endpoint-route/routes/**` is **still live** —
  these are `defineTool`-based API routes mounted into the Hono app.
  Hitting `/api/...` from the Tauri shell hits these.
* `apps/operator/lib/**` (loaders, pure-logic helpers, ensure
  schemas, etc.) is **still live** — imported by the API route
  handlers, by `instrumentation-node.ts`, and by operator-vite
  client components via the `@/` alias.

## What this means for new UI

Shipping a new screen requires **two** files, not one:

1. **The route** at `apps/operator-vite/src/routes/<path>.tsx` using
   `createFileRoute('/<path>')({ component: ... })`. Mount in any
   existing shell (`AdminShell`, the harness shell, the dock, etc.)
   as appropriate.
2. **Pure-UI + client wrappers** you can import via `@/` — these
   live anywhere under `apps/operator/app/_components/` or
   `apps/operator/app/harness/insights/`. operator-vite has
   `vite.config.ts → resolve.alias['@'] = '../operator/...'` so the
   imports resolve.

A new SSR `page.tsx` under `apps/operator/app/<route>/page.tsx`
**does nothing** — the file is never resolved by any router. Stop
making them.

## What about the existing SSR pages?

Several `page.tsx` files still exist under `apps/operator/app/` from
the pre-retirement era. They are:

* **Dead**: not routed by anything. No need to migrate them all in a
  hurry; migrate as you touch the surfaces.
* **Safe to delete** when you migrate one — there's no fall-back
  consumer.
* **Type-checked** still, so don't break their imports without
  intent.

## What about the existing Next imports?

`'next/dynamic'`, `'next/link'`, `'next/navigation'`, `'next/image'`
etc. still resolve at type-check time because `next` is a workspace
dep, but **nothing renders them**. When migrating a screen to
operator-vite, swap:

| Next import                       | TanStack Router equivalent                             |
| --------------------------------- | ------------------------------------------------------ |
| `Link from 'next/link'` (`href=`) | `Link from '@tanstack/react-router'` (`to=`)           |
| `useRouter().push()`              | `const nav = useNavigate(); nav({ to: ... })`          |
| `usePathname()`                   | `useRouterState({ select: s => s.location.pathname })` |
| `useSearchParams()`               | nuqs (`useQueryState(...)`)                            |
| dynamic SSR data                  | `useEffect` + `fetch('/api/...')`                      |

## Common gotchas this catches

* **"I shipped a page and it 404s"** — almost always: you wrote
  `apps/operator/app/.../page.tsx`. Vite doesn't see it. Move to
  `apps/operator-vite/src/routes/.../<name>.tsx`.
* **"My API route shows up but the page doesn't"** — the API path
  is fine; only the SSR page is dead. Drop a Vite route that fetches
  the API.
* **"AdminShell doesn't show my tab"** — add an entry to the `TABS`
  array in `apps/operator-vite/src/components/admin/AdminShell.tsx`.

## Why this isn't auto-detected

Type-check + tests both pass on a dead `page.tsx` — the file imports
real modules, exports a valid component, and the tests render it
in jsdom. The only place it fails is at the route layer in a running
shell, where nothing imports it. Stay in the habit of verifying via
the running Tauri shell + `tauri-agent-tools` per the testing playbook.
