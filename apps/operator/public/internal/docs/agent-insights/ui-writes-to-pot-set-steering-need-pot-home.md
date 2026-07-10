# A UI write to pot:set-steering MUST pass pot:<home> — it defaults to '*' and silently rejects
URL: /internal/docs/agent-insights/ui-writes-to-pot-set-steering-need-pot-home

Any SPA caller of pot:set-steering (sidebar model overrides, Mug tab, throttles) must resolve the home pot and pass it; the tool's default pot '*' is not a real Pot, so setHiveSetting throws and the write is lost. Unit tests miss it because they pass pot explicitly.

## The trap

`pot:set-steering` (and its store `owner-steering.ts`) is **per-pot**:
`setOwnerSteering(workspaceId, installSlug, patch)` → `setHiveSetting`, which
**throws** when `installSlug` is not a real Pot:

```
setHiveSetting: no Pot '*' in workspace 'papercusp-workspace' — settings belong to a Pot
```

The tool resolves its pot from `resolveHiveHomeSlug(args.pot, ctx.harnessSlug)`.
A browser `fetch('/api/agent-mcp/run-tool', …)` carries **no** `ctx.harnessSlug`,
so when the SPA omits `pot` it defaults to **`'*'`** and the write is rejected.
The HTTP call returns `200 { ok:true }` at the transport layer but the tool body
is `{ ok:false, error:"… no Pot '*' …" }`, so the failure is easy to miss.

## The rule

**Every SPA caller of `pot:set-steering` must resolve the workspace's HOME pot
and pass it as `pot`.** The proven helper is `resolveHomeHive(projects, rows)`
(exported from `QueenTab.tsx`): first `harnessProjects.lite` row with
`harness_kind === 'pot'`, else the first `pot.steering` row. Query both:

```ts
const steeringQ = useSyncQuery({ queryName: 'pot.steering', args: {} });
const projectsQ = useSyncQuery({ queryName: 'harnessProjects.lite', args: { includeHiveHomes: true } });
const home = resolveHomeHive(projectsQ.data ?? [], steeringQ.data ?? []);
// …
runSetSteering({ pot: home, /* …patch */ });
```

Two corollaries:

1. **`pot.steering` returns MULTIPLE rows** (one per pot). Read the home row
   with `rows.find(r => r.slug === home)`, **not** `rows[0]` — `[0]` is whatever
   pot sorted first, not necessarily the home.
2. **Guard the load race.** `home` is `''` until `harnessProjects.lite` resolves;
   a click in that window sends `pot:''` (same rejection). Bail with a retry
   message when `!home` (QueenTab does this; `useModelOverride` does too).

## Why unit tests didn't catch it

The 99 store/tool unit tests all pass `pot` explicitly (they call
`setOwnerSteering(ws, 'somehive', …)` directly), so they never exercise the
default-`'*'` path. This bug was found only by driving the real Tauri webview
(`tauri-agent-tools eval` → instrument `window.fetch` → read the captured body).
The regression guard now lives in `useModelOverride.test.tsx` ("writes
pot:set-steering WITH pot: `<home>`") — assert the **request body** carries
`args.pot`, not just that a fetch happened.

## Verifying a SPA steering write live

The integration tree's fresh dist is served on **:3270** (not :3170, which runs
the separate `papercup-staging` checkout and lags until staging-sync). Reload a
:3270 Tauri webview, instrument `window.fetch` to capture `run-tool` bodies,
drive the control via the native `HTMLSelectElement` value setter +
`dispatchEvent(new Event('change',{bubbles:true}))`, then read back with
`pot:get-steering { pot }`. For the Papercup override also confirm
`~/.papercusp/papercup-model` materializes (the `materializeSentinelModelFile`
projection the dock wrapper reads).
