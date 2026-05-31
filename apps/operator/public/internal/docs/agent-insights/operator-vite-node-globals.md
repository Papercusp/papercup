# Can't find variable: Buffer — Vite drops the Node globals Next polyfilled
URL: /internal/docs/agent-insights/operator-vite-node-globals

The operator-vite SPA is bundled by Vite, which (unlike Next's webpack) does not polyfill Node globals like Buffer/process/global. Bundled deps that touch them throw a Buffer ReferenceError in the Tauri WebKit renderer. Fix is a global polyfill at the top of main.tsx. Also: the desktop serves built dist, not live src — a broken build silently freezes it on stale dist.

import { Aside } from '@astrojs/starlight/components';

If you see **`ReferenceError: Can't find variable: Buffer`** (or
`process is not defined`, `global is not defined`) in the desktop app,
this is the cause.

## Root cause

The desktop content layer migrated from `next dev` to **`apps/operator-vite`**
(a Vite SPA — see `operator-vite-migration-2026-05-20`). Next's webpack
**auto-provided a browser `Buffer`** (and shimmed other Node globals) for the
client bundle. **Vite does not** polyfill Node globals, and the operator-vite
`vite.config.ts` has no `define`/`vite-plugin-node-polyfills`. So any code
bundled into the renderer that references `Buffer` — most often a *dependency*
(e.g. the OpenAI Realtime voice SDK), not app code — throws at eval/call time.

The error wording is WebKit-specific: WebKitGTK (Tauri on Linux) says
**"Can't find variable: Buffer"** where Chrome would say "Buffer is not
defined". Both mean the same thing: a free identifier that doesn't exist.

`Buffer.byteLength?.(s, 'utf8')` still throws — the `?.` only guards
`.byteLength` being nullish, not the bare `Buffer` reference itself. In app
code, use the Web equivalent: `new TextEncoder().encode(s).length`.

## The fix

App-code accidents → rewrite to a Web API (`TextEncoder`, `crypto.subtle`,
`atob`/`btoa`). But dependencies you can't rewrite need the global restored.
`apps/operator-vite/src/buffer-polyfill.ts` exposes the `buffer` package as the
global, imported as the **first** line of `main.tsx` so it runs before any
route module or dependency body evaluates:

```ts
// main.tsx — FIRST import
import './buffer-polyfill';
```

```ts
// buffer-polyfill.ts
import { Buffer as BufferPolyfill } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = BufferPolyfill;
```

If a future dep needs `process`/`global`, add them the same way (or adopt
`vite-plugin-node-polyfills`).

## The trap that hides it: the desktop serves built `dist`, not live src

`dev:operator` → `dev:nohmr` → **`vite build --watch`**, and the desktop loads
the **`dist/` output** (HMR is off by default). Consequences:

* Editing src does nothing until the watch-build emits a fresh `dist` **and**
  you reload the Tauri window (Ctrl+R).
* A **broken build silently freezes `dist`** at its last good output. The
  desktop keeps running stale code and *no* source change reaches it. Check
  `ls -lt apps/operator-vite/dist/assets/*.js` — if the newest file is old, the
  watch build is failing. Run `npm run build:operator` to see the real error.

A stray NUL byte in a `.tsx` (e.g. a literal control char used as a map-key
delimiter) makes `rg`/`grep` treat the file as **binary and skip it** — so a
"0 stragglers" import scan can be a lie. Force text with
`grep -ra` / `grep --binary-files=text` when a build cites an import in a file
your scan claims is clean.
