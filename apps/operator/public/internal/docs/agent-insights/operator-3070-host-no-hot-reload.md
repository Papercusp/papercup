# The :3070 operator host has no hot-reload — restart to pick up lib/** edits
URL: /internal/docs/agent-insights/operator-3070-host-no-hot-reload

The Hono host on :3070 (MCP tools + endpoint-route handlers + the lib/** they import) runs under tsx with no file-watch. Server-side edits don't go live until it restarts; probe where a write lands to tell if you're on stale code.

import { Aside } from '@astrojs/starlight/components';

## The trap

You edit `apps/operator/lib/**` (an MCP tool, an endpoint-route handler, a
`coordLog`/store seam), reload the operator UI, exercise the tool — and it
behaves like your change isn't there. It isn't: the **`:3070` Hono host**
(`apps/operator/bin/hono-host.ts`) runs under `tsx` with **no file-watch**.
It loaded the old module graph (including module-level singletons like
`coordLog`) at startup and won't pick up `lib/**` edits until the process
restarts.

The `:3055` Vite dev server (`@papercusp/operator-vite`) *does* hot-reload its
own routes/components — so a frontend change goes live while an
identical-feeling server-side change silently does not. That asymmetry is what
makes this confusing. (Next.js is retired for the operator; `:3055` is the
Vite SPA, not a Next dev server.)

## Restart it

* **Tauri dev shell:** reload the desktop window (it respawns the host), or
* **On the standing systemd dev box:** `systemctl --user restart papercup-dev-api.service`
  (that unit runs `npx tsx bin/hono-host.ts` on :3070).

The unit name is this dev box's local supervision — not a repo invariant.
Other setups have the Tauri shell spawn the host; restart it however it's
supervised there.

## The tell: probe where the write lands

A passing typecheck proves nothing about whether the *running* host has your
code. Before trusting a live result, **probe where a write actually lands**:

During the coord FS→PG cutover, a real `coord:send` kept writing
`coord/messages/*.jsonl` (the old `FsCoordLog`) instead of
`harness_shared.coord_event_log` — because the host hadn't been restarted
onto the new `PgCoordLog`. The nonce was on disk, not in PG. That one check
distinguished "my code is wrong" from "the host is stale." Restart, then
re-probe before drawing any conclusion.

See also the user-level memory note `verify-server-pid-before-measuring` and
the engineer playbook's CLAUDE.md pointer.
