---
title: Feature flags
description: The complete feature-flag system — every flag, how to flip them, where they're enforced, the V1 ship contract, and the admin UI.
---

Feature flags are how Papercusp ships V1 with a minimal feature set while keeping the cut features in the codebase, ready to re-enable. Every flag defaults to **off**, the operator falls back to bundled defaults when offline, and admins flip flags through the operator's own UI — no PostHog dashboard required for day-to-day use.

## The 9 flags

| Key | TS constant | Default | What it gates |
|---|---|---|---|
| `papercusp-snapshots` | `FLAGS.SNAPSHOTS` | `false` | Save / restore mission state. Toolbar button, `/installed/snapshots`, `/snapshots/*`, 7 API routes, 2 MCP tools. |
| `papercusp-templates` | `FLAGS.TEMPLATES` | `false` | Save / install harness templates. Toolbar button, `/installed/templates`, 6 API routes. |
| `papercusp-marketplace` | `FLAGS.MARKETPLACE` | `false` | Plugin + template + snapshot marketplace. Top-nav entry, `/marketplace/*`, plugins-page "Add" button, 6 API routes (including the CORS-allowed `/api/marketplace/install`). |
| `papercusp-cloudflare-publish` | `FLAGS.CLOUDFLARE_PUBLISH` | `false` | Publish-to-Cloudflare flow. `/settings/publishing` page, settings sidebar entry, `/api/publish-credentials*` routes. |
| `papercusp-oracle` | `FLAGS.ORACLE` | `false` | Always-on tutorial Oracle dock. Top-nav launcher button, `/settings/oracle` page, all `/api/oracle/*` Hono endpoints (404 when off). |
| `papercusp-rust-port-ui` | `FLAGS.RUST_PORT_UI` | `false` | **Reserved**. Intended for Tauri build-time gating of Rust-port surfaces; no operator UI consumes it today. |
| `papercusp-harness-phases` | `FLAGS.HARNESS_PHASES` | `false` | Multi-phase harness (staging / testing / production). Top phase strip in HarnessDashboard, the IssuesPanel "tests" tab, the two `harness.use('/:slug/tests*')` Hono endpoints. |
| `papercusp-design` | `FLAGS.DESIGN` | `false` | In-harness "design" tab + DesignDashboard render, `/design` index, `/design/[slug]`, 4 `/api/design/*` routes. |
| `papercusp-admin` | `FLAGS.ADMIN` | `false` | The admin section itself. Top-nav "Admin" entry + `/admin/*` routes. Disabling hides the entry from chrome and 404s the route. |

All keys also live in `libs/flags/src/types.ts` as the single source of truth — adding a new flag means editing **one file**, then creating the matching definition in PostHog. The TypeScript `FlagKey` type is derived from the object, so call sites get autocomplete and any rename is a compile error at every site.

## Defaults and the V1 ship contract

`FLAG_DEFAULTS` in `libs/flags/src/types.ts` hard-codes all 9 flags as `false`. The operator returns this map whenever PostHog is unreachable or unconfigured. That's the V1 ship state: every cut feature stays cut, no network call required to discover it.

Two statements that hold for every shipped binary:

1. A freshly installed Papercusp binary on Linux / macOS / Windows makes **zero** outbound HTTP requests to `flags.papercuspai.com` under normal use.
2. All nine flags resolve `false`, so every cut surface is unreachable: routes redirect, nav entries are absent, API routes return 404, Hono endpoints return 404, MCP tools are not registered.

Both hold without any post-install configuration. Verified by the build-agent handoff via a clean-machine smoke test.

## The two-knob model

There are two things that need to be set to enable a feature for a user:

**Knob 1 — `testingFeatures` in `~/.papercusp/posthog.json`**

A single boolean. `true` → operator phones home to PostHog and reads live flag definitions. `false` (default) → operator never contacts PostHog and uses bundled defaults. This is the per-machine privacy toggle.

**Knob 2 — individual flag values in PostHog**

The 9 actual on/off switches. Only consulted when `testingFeatures: true`. With `testingFeatures: false`, PostHog values are irrelevant; the operator never reads them.

Combined behavior:

| `testingFeatures` | PostHog value | Effective |
|---|---|---|
| `false` (default) | any | `false` (bundled default) |
| `true` | `false` | `false` |
| `true` | `true` | `true` |

You can't get a flag to evaluate `true` without `testingFeatures: true`. That's the privacy moat.

## How to flip flags

### Through the admin UI

Open **Admin → Features** (`/admin/features`). You'll see:

1. **Preset row** — two one-click buttons:
   - **🚀 V1 Production** → sets `testingFeatures: false`. Operator stops contacting PostHog. Cuts stay cut. PostHog values are left untouched (irrelevant).
   - **🧪 Full testing** → sets `testingFeatures: true` + flips all 9 PostHog flags to `active=true` with `rollout_percentage: 100`. Everything on.
2. **Master switch** — the `testingFeatures` toggle with a status pill (`on` / `off`) and its current source (`discovery-file`, `env`, `unconfigured`).
3. **Per-flag toggles** — all 9 flags listed with label, blurb, raw key. Toggles are disabled (greyed) when `testingFeatures` is off — turn that on first.

Every toggle round-trips through the operator's HTTP endpoints, which:

- Persist the change (discovery file for `testingFeatures`, PostHog API for individual flags)
- Invalidate the in-process PostHog config cache
- Re-init the flag backend if `testingFeatures` was just turned on
- Publish a `flag_changed` event on the in-process SSE bus

Other open tabs subscribed to `/api/flags/stream` reflect the change within ~10 seconds (the PostHog SDK's polling interval).

### Through the PostHog UI

`https://flags.papercuspai.com` is the authoritative dashboard. Admins can flip flags, edit rollout percentages, target specific users/cohorts, view history. The operator's admin UI is a convenience layer over the PostHog API — anything you do in PostHog directly propagates back via the SDK polling.

Use this when you need targeting (cohort A/B, gradual rollout) beyond the binary on/off the admin UI exposes.

### Through MCP

For agents:

| Tool | Action |
|---|---|
| `flags:list` | Lists all flags with current values. |
| `flags:get` | Reads a single flag value. |
| `flags:set` | Flips a flag in PostHog. Requires `audit:write` capability. Writes an audit log row in `harness_shared.audit_log`. |

`flags:set` writes both `active` and `filters.groups[].rollout_percentage` so the binary on/off semantics work as expected — see "Bug 1" in the [Wire-up gotchas](#wire-up-gotchas) section for why.

### Through env vars

For CI and ephemeral overrides:

| Env var | Effect |
|---|---|
| `PAPERCUSP_POSTHOG_HOST` | Override the host. Must be paired with `PAPERCUSP_POSTHOG_KEY`. |
| `PAPERCUSP_POSTHOG_KEY` | Override the project key. |
| `PAPERCUSP_POSTHOG_PERSONAL_KEY` | Override the personal API key. Defaults to `KEY` if not set. |
| `PAPERCUSP_POSTHOG_TESTING_FEATURES` | Set to `"true"` to flip the master switch on without touching the discovery file. |

Env vars are checked **before** the discovery file. They never get written into the desktop binary at build time — that would defeat the privacy contract.

## How flags are enforced

Each cut feature has gating at multiple layers; the goal is that no path — direct URL, deep-link, command palette, API call, MCP tool — surfaces a cut feature when its flag is off.

### Route layer (Next.js pages)

Server components call `requireFlag(FLAGS.X)` at the top of the page. The helper redirects to `/` (or 404s) if the flag is off:

```tsx
// apps/operator/app/installed/snapshots/page.tsx
import { FLAGS } from '@papercusp/flags';
import { requireFlag } from '@/lib/require-flag';

export default async function Page() {
  await requireFlag(FLAGS.SNAPSHOTS);
  // …existing UI…
}
```

### Nav layer

Top-nav entries in `apps/operator/app/_components/ChromeShell.tsx` are wrapped in `useFlag(FLAGS.X) && …`:

```tsx
const marketplaceFlag = useFlag(FLAGS.MARKETPLACE);
// …
{marketplaceFlag ? (
  <a href="/marketplace/" {...navLinkProps('/marketplace')}>Marketplace</a>
) : null}
```

Same for settings-sidebar entries (see `apps/operator/app/settings/layout.tsx`).

### Component layer (defense-in-depth)

Modal panels like `<SnapshotsPanel>` and `<TemplatesModal>` use `useQueryState` for their open/closed state, so anyone can deep-link `?snapshots=true` and trigger a render. The render conditions additionally check the flag:

```tsx
{showSnapshots && activeSlug && snapshotsEnabled && (
  <SnapshotsPanel … />
)}
```

Command-palette entries that would open these panels are similarly gated:

```tsx
if (snapshotsEnabled) cs.push({ id: 'snapshots', … });
```

### API route layer

For Next.js API routes, the `gateApiRoute` helper returns a 404 response when the flag is off:

```ts
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';

export async function GET(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.SNAPSHOTS);
  if (blocked) return blocked;
  // …handler logic…
}
```

For Hono-mounted routes (Oracle, harness tests), middleware on the path returns 404:

```ts
// apps/operator/app/api/_hono/oracle.ts
app.use('/oracle/*', async (c, next) => {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const enabled = await getFlag(FLAGS.ORACLE, 'system');
  if (!enabled) return c.notFound();
  return next();
});
```

### MCP tool layer

Each gated MCP tool checks the flag at registration time and at runtime. Tools that are off-gated don't register their schema; agents can't call what isn't there.

### Configuration

The single source of truth for which surfaces each flag gates is **not** documented in code comments — it's expressed in the gating itself. `grep -rln "FLAGS.SNAPSHOTS" apps/operator` is the canonical answer.

## File structure

The system lives in three places:

| Path | What |
|---|---|
| `libs/flags/` | The package. Types, defaults, server SDK wrapper, client cache, test overrides. Versioned, exported as `@papercusp/flags`. |
| `apps/operator/lib/flag-bus.ts` | In-process pub/sub + boot-time backend init. Wraps the @restart/sse channel. |
| `apps/operator/lib/posthog-config.ts` | Discovery-file resolver. The three-tier env → file → unconfigured fallback lives here. |
| `apps/operator/lib/require-flag.ts` | The `requireFlag` / `gateApiRoute` helpers used by pages + API routes. |
| `apps/operator/lib/flag-hooks.tsx` | `useFlag` React hook with SSE subscription. |
| `apps/operator/app/api/flags/*` | The 5 endpoints: `bootstrap`, `stream`, `webhook`, `testing-features`, `set`, `preset`, `dashboard-url`. |
| `apps/operator/app/admin/features/` | The admin UI. |
| `apps/operator/app/settings/flags/` | **Removed.** Used to be a read-only viewer; replaced by the interactive admin page. |

## HTTP API

| Method + path | Body | Returns |
|---|---|---|
| `GET /api/flags/bootstrap` | — | `{ flags: { [key]: bool }, evaluatedAt, source }`. The client's main read endpoint. |
| `GET /api/flags/stream` | — | SSE stream of `flag_changed` events. Used by the React client to refresh after flips. |
| `POST /api/flags/webhook` | PostHog webhook payload | Auth header `X-Papercusp-Webhook-Secret`. Publishes a `flag_changed` event on the SSE bus. |
| `GET /api/flags/testing-features` | — | `{ testingFeatures: bool, source }` |
| `POST /api/flags/testing-features` | `{ enabled: bool }` | Writes the discovery file, resets the in-process config cache, re-inits the flag backend. |
| `POST /api/flags/set` | `{ key: FlagKey, enabled: bool }` | PATCHes the flag in PostHog. Sets `active` + `rollout_percentage` (100 or 0). |
| `POST /api/flags/preset` | `{ name: 'production' \| 'testing' }` | Atomic preset apply. `production` writes `testingFeatures: false`; `testing` sets `testingFeatures: true` + flips all 9 flags on. |
| `GET /api/flags/dashboard-url` | — | Returns the PostHog UI URL for deep-linking out of the admin page. |

All endpoints require `runtime: 'nodejs'` and `dynamic: 'force-dynamic'`. They run in the operator's bundled server, not at the edge.

## How a flag flip propagates

```
1. User clicks toggle in /admin/features.
   └─> POST /api/flags/set { key, enabled }

2. Handler invokes setFlag(key, enabled) in @papercusp/flags/server.
   └─> PATCH flags.papercuspai.com/api/projects/1/feature_flags/<id>/
       body: { active, filters.groups[0].rollout_percentage }

3. Handler publishes 'flag_changed' on the in-process flag bus.
   └─> SSE channel @restart/sse fan-out.

4. Every open tab connected to /api/flags/stream gets the event.
   └─> The React client calls loadFlags() → GET /api/flags/bootstrap.

5. The operator's posthog-node SDK has its own 10s polling interval.
   Either the SDK's local cache is already fresh (rare — flips are
   pushed via the bus) or it refreshes on its next poll.

6. All useFlag() hooks re-render. Components that subscribe to flag
   state via SSR don't auto-update; a navigation or refresh picks them up.
```

End-to-end: a flag flip typically reflects in the UI within 1–2 seconds for client-rendered components, and on next navigation for server-rendered pages.

## The admin UI architecture

The Admin section is structured like Restart's `DashboardShell` (separate routes per tab, not in-page state):

- `/admin` → 302 redirect to `/admin/run`
- `/admin/run` → `<AdminShell><AdminOps /></AdminShell>` — existing build/run/simulators commands.
- `/admin/features` → `<AdminShell><FeaturesAdmin /></AdminShell>` — the flag console.

`AdminShell` is the chrome (header with title + tabs + host pill). Each tab is a `<Link>` so navigations are full route transitions. URL is the source of truth for the active tab; no `useState` for tab selection.

The whole `/admin/*` tree is wrapped in `await requireFlag(FLAGS.ADMIN)`. If the flag is off, every page returns 404. The nav entry in ChromeShell is also gated, so an end-user without admin access never sees the link.

## Wire-up gotchas

Three bugs surfaced during the initial wire-up that future contributors should know about. All are fixed in `main` but the explanations are worth keeping.

### Bug 1: `setFlag` only flipped `active`

PostHog flags have a hierarchical evaluation: `active` is the master switch, but `filters.groups[].rollout_percentage` decides which fraction of users see it. The original `setFlag` only PATCHed `active`. Flags were created with `rollout_percentage: 0`, so even `active: true` evaluated `false` for every user.

Fix: `setFlag` now PATCHes both `active` and `rollout_percentage` (100 when enabling, 0 when disabling). For binary on/off semantics that's correct; for gradual rollouts use the PostHog UI directly.

### Bug 2: SDK missing `personalApiKey`

`initFlagBackend` initially constructed the `posthog-node` client with only `projectKey` and `host`. Without `personalApiKey`, the SDK can't fetch flag definitions and falls back to remote evaluation (per-call `/flags/` endpoint hits, slower and different semantics).

Fix: pass `personalApiKey` + set `featureFlagsPollingInterval: 10_000`. The SDK now polls flag definitions every 10s and evaluates locally — sub-millisecond per call, no per-request network.

### Bug 3: One-shot `booted` latch in flag-bus

`apps/operator/lib/flag-bus.ts` had `let booted = false` at module scope, set to `true` after the first `bootIfNeeded()` call. The intent was "init the PostHog client once at startup." But if `testingFeatures` was off at startup and got flipped to `true` later, the latch had already fired, so no init ever happened.

Fix: added `reinitFlagBackend()` which the `testing-features` and `preset` endpoints call after writing the discovery file. The latch is now a debounce, not a guard against re-init.

## Testing

The flag system has a test override hook:

```ts
import { setFlagOverridesForTest } from '@papercusp/flags/test';

beforeEach(() => {
  setFlagOverridesForTest({
    [FLAGS.SNAPSHOTS]: true,
    [FLAGS.MARKETPLACE]: false,
  });
});
```

When overrides are set, the server's `getAllFlags()` returns them directly with `source: "override"`, bypassing PostHog entirely. Tests don't need to mock the SDK or run a real PostHog instance.

The hook is currently defined but unused — there's no test consumer yet. When the operator gets a real test suite, this is how to neutralize flag state.

## Common operations

### "Flip everything on for a dev session"

Admin → Features → **🧪 Full testing**. Or:

```bash
curl -X POST http://localhost:3055/api/flags/preset \
  -H 'content-type: application/json' \
  -d '{"name":"testing"}'
```

### "Go back to V1 ship state"

Admin → Features → **🚀 V1 Production**. Or:

```bash
curl -X POST http://localhost:3055/api/flags/preset \
  -H 'content-type: application/json' \
  -d '{"name":"production"}'
```

### "Verify the ship state on a freshly built binary"

```bash
# On a clean install, before any admin opt-in:
curl -s http://localhost:3055/api/flags/bootstrap | jq

# Expected: source="unconfigured", every flag false
```

### "Add a new flag"

1. Add the key + default to `libs/flags/src/types.ts` (`FLAGS` + `FLAG_DEFAULTS`).
2. Create the matching flag in the PostHog UI at `flags.papercuspai.com` (default to `active: false`, `rollout_percentage: 0`). Key must match the TS string exactly.
3. Add the entry to `FLAG_LABELS` + `FLAG_BLURBS` in `apps/operator/app/admin/features/FeaturesAdmin.tsx`.
4. Gate the actual surfaces — pages with `requireFlag`, nav entries with `useFlag`, API routes with `gateApiRoute`, MCP tools with the same.
5. `tsc --noEmit` on the operator to confirm no surface forgot the gate.

### "Discover what a flag gates"

```bash
grep -rln "FLAGS.SNAPSHOTS" apps/operator
```

The gating sites are the documentation.
