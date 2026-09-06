# Workspaces surface design pass — 2026-09-06

Plan: `portal-design-iteration-2026-09-05#P-007` · Work item: `WI-10000284` · Driver: `WI-2146962`.

The Portal no longer offers a desktop session for a workspace that its own control plane says cannot serve. The fix is live on `:3081`, preserves the established running/degraded semantics, and remains contained with both side panes open.

## Finding and design ruling

The live card for `p018-canary-20260905-r7` supplied all sides of the contradiction:

- observed state `running`, desired state `provisioning`;
- terminal operation `repair / succeeded`;
- durable operation message: the provider work completed but the host `CANNOT SERVE` until initialization runs;
- “Open desktop” still enabled with title `Open the desktop for p018-canary-20260905-r7`.

The button read only `observedState`. That field says the provider VM is up; it is not the complete serving verdict. The existing `hostIsRunning` predicate remains the one owner of the running/degraded vocabulary, but desktop availability now applies it to both the observed state and any supplied desired state. A missing desired state preserves compatibility with the older projection. Thus running/degraded → running/degraded remains available, while running → provisioning/stopped/absent/repairing/destroying does not advertise a usable desktop.

`design-phase.search_registry` found no matching workspace-status card/action composition. This pass therefore extends the existing `WorkspaceCard` and CTA rather than introducing a parallel component or styling system.

## Source change

Canonical Portal checkout: `/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal` (`staging`).

- `packages/ui/src/workspaces.tsx` — adds `hostCanOpenDesktop`, derives one `desktopReady`/`desktopTitle`, and disables the CTA while desired state is non-serving.
- `tests/workspaces-ui.test.tsx` — covers both state axes, legacy missing-desired compatibility, degraded hosts, and the exact live post-repair shape.
- `tests/disabled-not-louder-than-enabled.test.ts` — follows the named title writer and guards both unavailable explanations.

No CSS, backend schema, provider action, or workspace-host data was changed.

## Verification

- `npx vitest run tests/workspaces-ui.test.tsx tests/disabled-not-louder-than-enabled.test.ts`: **47/47 passed**.
- `npm run typecheck`: **clean**, 0 errors across 2,424 files.
- Scoped `git diff --check`: **passed**.
- Guarded production build: **exit 0**. The build held the exclusive materialization/source-manifest fences and published immutable release `kHk9RNQhAOYdviOL0QIri-20260906182721325-964268-fb22ee90` from stable root source digest `693a815e1f45…`.
- `bash apps/operator/scripts/systemd/deploy-cloud-portal.sh --handoff`: source digest matched, the stale serving child restarted, and the health check passed. A process read confirmed `standalone-entry.mjs` running from that exact release; unmocked `:3081` returned HTTP 200.

## Real `:3081` acceptance

After handoff, the same live card reported:

- `disabled: true`;
- title `The desktop is unavailable while this workspace is reconciling (running → provisioning)`;
- the unchanged `CANNOT SERVE` operation evidence beside the quiet disabled CTA.

Collapsed-pane content widths were 1,216px at 1440×900 and 1,056px at 1280×800. With both panes expanded at 1280×800, the real host box was 537.6px; the surface and first card each had zero horizontal overflow. Provider rows, state/outcome chips, timestamps, long operation copy, lifecycle actions, and card borders remained contained. All five images below were reopened and inspected at original resolution:

- [Light 1440×900](workspaces-live-light-1440x900.png)
- [Light 1280×800](workspaces-live-light-1280x800.png)
- [Dark 1440×900](workspaces-live-dark-1440x900.png)
- [Dark 1280×800](workspaces-live-dark-1280x800.png)
- [Light 1280×800, both panes expanded](workspaces-live-light-1280x800-expanded.png)

## Final state

The browser was restored to Dark, `/?app=phone`, both 48px side-pane strips collapsed, Phone / Call current, call orb `phase-idle`, no dialog, and the same 13 pinned destinations observed at the beginning of this pass. Verdict was stopped. No desktop was opened and no workspace lifecycle/provider/connector action was invoked.
