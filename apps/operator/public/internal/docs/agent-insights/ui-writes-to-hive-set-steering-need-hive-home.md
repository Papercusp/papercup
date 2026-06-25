# A UI write to hive:set-steering MUST pass hive:<home> — it defaults to '*' and silently rejects
URL: /internal/docs/agent-insights/ui-writes-to-hive-set-steering-need-hive-home

Any SPA caller of hive:set-steering (sidebar model overrides, Queen tab, throttles) must resolve the home hive and pass it; the tool's default hive '*' is not a real Hive, so setHiveSetting throws and the write is lost. Unit tests miss it because they pass hive explicitly.

## The trap

`hive:set-steering` (and its store `owner-steering.ts`) is **per-hive**:
`setOwnerSteering(workspaceId, installSlug, patch)` → `setHiveSetting`, which
**throws** when `installSlug` is not a real Hive:

```
setHiveSetting: no Hive '*' in workspace 'papercusp-workspace' — settings belong to a Hive
```

The tool resolves its hive from `resolveHiveHomeSlug(args.hive, ctx.harnessSlug)`.
A browser `fetch('/api/agent-mcp/run-tool', …)` carries **no** `ctx.harnessSlug`,
so when the SPA omits `hive` it defaults to **`'*'`** and the write is rejected.
The HTTP call returns `200 { ok:true }` at the transport layer but the tool body
is `{ ok:false, error:"… no Hive '*' …" }`, so the failure is easy to miss.

## The rule

**Every SPA caller of `hive:set-steering` must resolve the workspace's HOME hive
and pass it as `hive`.** The proven helper is `resolveHomeHive(projects, rows)`
(exported from `QueenTab.tsx`): first `harnessProjects.lite` row with
`harness_kind === 'hive'`, else the first `hive.steering` row. Query both:

```ts
const steeringQ = useSyncQuery({ queryName: 'hive.steering', args: {} });
const projectsQ = useSyncQuery({ queryName: 'harnessProjects.lite', args: { includeHiveHomes: true } });
const home = resolveHomeHive(projectsQ.data ?? [], steeringQ.data ?? []);
// …
runSetSteering({ hive: home, /* …patch */ });
```

Two corollaries:

1. **`hive.steering` returns MULTIPLE rows** (one per hive). Read the home row
   with `rows.find(r => r.slug === home)`, **not** `rows[0]` — `[0]` is whatever
   hive sorted first, not necessarily the home.
2. **Guard the load race.** `home` is `''` until `harnessProjects.lite` resolves;
   a click in that window sends `hive:''` (same rejection). Bail with a retry
   message when `!home` (QueenTab does this; `useModelOverride` does too).

## Why unit tests didn't catch it

The 99 store/tool unit tests all pass `hive` explicitly (they call
`setOwnerSteering(ws, 'somehive', …)` directly), so they never exercise the
default-`'*'` path. This bug was found only by driving the real Tauri webview
(`tauri-agent-tools eval` → instrument `window.fetch` → read the captured body).
The regression guard now lives in `useModelOverride.test.tsx` ("writes
hive:set-steering WITH hive: `<home>`") — assert the **request body** carries
`args.hive`, not just that a fetch happened.

## Verifying a SPA steering write live

The integration tree's fresh dist is served on **:3270** (not :3170, which runs
the separate `papercup-staging` checkout and lags until staging-sync). Reload a
:3270 Tauri webview, instrument `window.fetch` to capture `run-tool` bodies,
drive the control via the native `HTMLSelectElement` value setter +
`dispatchEvent(new Event('change',{bubbles:true}))`, then read back with
`hive:get-steering { hive }`. For the Sentinel override also confirm
`~/.papercusp/sentinel-model` materializes (the `materializeSentinelModelFile`
projection the dock wrapper reads).
