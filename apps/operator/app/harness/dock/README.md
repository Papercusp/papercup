# `app/harness/dock` — Dockview migration foundation

Status: **Phases 0–2 complete, Phases 3–6 scaffolded and demo-able at
`/harness/<slug>/dock-preview`.** The big integration (replacing
`HarnessDashboard`'s `react-resizable-panels` and `ChromeShell`'s tab
strip) is the remaining work.

See `apps/operator/docs/dockview-migration-plan-v4.md` for the full plan.

## Layout

```
dock/
├── panel-registry.ts          # type → component map, late-register notify
├── useNavHistory.ts           # per-panel back/forward stack
├── useNavShortcuts.ts         # Cmd+[/] → focused panel
├── useLayoutResetShortcut.ts  # Shift+Esc 1s → reseed
├── useDockLayout.ts           # client hook for /api/dock-layouts/:name
├── HarnessDock.tsx            # root DockviewReact + persistence + bind
├── layout-adapter.ts          # LayoutDoc ↔ dockview JSON
├── dock-actions.ts            # openPanel/focusPanel/listPanels (singleton api)
├── MissingPanel.tsx           # fallback for unregistered types
├── IframePanel.tsx            # portal-pattern wrapper (§7 of plan)
├── iframe-host.ts             # off-DOM iframe registry (no reload on drag)
├── NavChevrons.tsx            # back/forward UI in panel chrome
├── HarnessSelectorChip.tsx    # ?focusSlug= driver (sidebar header)
├── RealFeaturesPanel.tsx      # first real panel — fetches /api/harness/:slug/status
└── sample-panels.tsx          # registerSamplePanels() — stubs for non-real types
```

## How to mount a dock

```tsx
'use client';
import { useEffect } from 'react';
import { HarnessDock } from './dock/HarnessDock';
import { registerSamplePanels } from './dock/sample-panels';

export default function MyDockPage() {
  useEffect(() => { registerSamplePanels(); }, []);
  return <HarnessDock layoutName="my-named-layout" />;
}
```

## How to register a real panel type

```tsx
import { panelRegistry } from './dock/panel-registry';
import type { PanelComponentProps } from './dock/panel-registry';

function MyPanel({ params, api }: PanelComponentProps) {
  return <div>My panel for slug={String(params.slug)}</div>;
}

// Register once at module load or on plugin onLoad.
panelRegistry.register('my:type', MyPanel, { keepAlive: true });
```

## How to open / focus / close a panel from anywhere

```ts
import { openPanel, focusPanel, closePanel } from './dock/dock-actions';

const id = openPanel({
  type: 'data:features',
  params: { harnessSlug: 'sheets' },
  title: 'Features',
  floating: { width: 480, height: 360 },  // optional — docked by default
});
focusPanel(id);
closePanel(id);
```

## How to opt into back/forward chevrons

```tsx
import { useNavHistory } from './dock/useNavHistory';
import { NavChevrons } from './dock/NavChevrons';

function DocsPanel({ params, api }: PanelComponentProps) {
  const nav = useNavHistory<{ doc: string }>(
    { doc: 'index' },
    { params, setParams: api.setParams, capacity: 50 },
  );
  return (
    <div>
      <NavChevrons nav={nav} />
      <h1>{nav.current.doc}</h1>
      <button onClick={() => nav.push({ doc: 'next' })}>Next</button>
    </div>
  );
}
```

Cmd+[ / Cmd+] dispatch to the focused panel automatically via
`useNavShortcuts` (mounted by `HarnessDock`).

## Persistence model

- `/api/dock-layouts/:name` (Hono routes in `app/api/_hono/dock-layouts.ts`)
- Table: `harness_shared.harness_dock_layouts` (migration 071)
- PK: `(workspace_id, user_id, layout_name)`
- Body: `LayoutDoc` (schemaVersion=1) for new dock, or opaque
  `schemaVersion=0` for pi-tab's raw dockview JSON
- Optimistic concurrency via `If-Match: <updatedTs>` → 409 on stale
- Seed-on-miss: `defaultDashboardLayout()` (or empty for pi)
- Reset: DELETE → next GET reseeds

## Tests

```bash
# Unit (63 tests)
cd apps/operator && npx vitest run app/harness/dock/ lib/dock-layouts.test.ts

# Integration (9 tests, requires operator running on :3055)
cd apps/operator && npx vitest run --config vitest.integration.config.ts \
  app/api/_hono/dock-layouts.integration.test.ts
```

## What's still TODO

- **Phase 3**: Replace `react-resizable-panels` block in
  `HarnessDashboard.tsx` with a nested `<HarnessDock layoutName="dashboard:<slug>">`.
  Largest single piece of remaining work. ~1 day. Needs paperclip pause.
- **Phase 4**: Mount `<HarnessSelectorChip>` in `OperatorChatSidebar`
  header (24px sub-row, header grows ~63px → ~90px). Rewrite all
  `?phase=` reads in `HarnessDashboard.tsx` to use per-panel
  `params.phase`. Wire `harness_phase_last_used` for default-on-reopen.
- **Phase 5 main**: Mount `<HarnessDock layoutName="default">` at root of
  `ChromeShell.tsx` under `/harness/*`; remove top-level tab strip;
  remove ReactActivity-based switching.
- **Phase 6**: Plugin host runtime reads manifest `panels[]`, calls
  `panelRegistry.register` at plugin onLoad. Synthesize panel entries
  from existing `dashboardTabs[]` as back-compat shim. Right-click
  "Pin as panel" on feature/issue rows.

The current preview at `/harness/<slug>/dock-preview` exercises the full
stack and is safe to share with users for feedback before the bigger
integrations land.
