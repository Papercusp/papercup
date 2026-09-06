# Unit 6 — portal global shortcuts: build, deploy and live probe evidence

Plan: portal-global-shortcuts-2026-09-06 (P-005). Work-item: WI-1965083 / WI-2147547. Session su-e8071b9d.

## Build + deploy chain (/tmp/e8071-u6-build-deploy-1.log, task 0mtpag0fh1nh8p9wagz)
- CHAIN_START 2026-09-06T04:04:55Z, load 211; `scripts/pc-heavy.sh npm run build` in ~/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal
- Next.js compiled in 116s; build-standalone promoted TJuwLhkMI4Q8N69bJTIST-20260906033829389 → **W3cjJPhObD2WSHvgxfQQv-20260906041004645-3941054-0dd1daef**; BUILD_RC=0 04:10:28Z
- `bash apps/operator/scripts/systemd/deploy-cloud-portal.sh --handoff`: source digest fresh, handoff complete, health check passed; DEPLOY_RC=0 04:10:59Z
- Served release (readlink of the :3801 listener's cwd): releases/W3cjJPhObD2WSHvgxfQQv-20260906041004645-3941054-0dd1daef
- Marker grep over served client chunks: `panel.quick` in 1 file, `kbd-cheat` in 2 files (both absent from the previous release); GET / on :3081 → 200

## Live probe (.papercusp/reports/portal-global-shortcuts-2026-09-06/live-probe-20260906T041112Z.txt) — real CDP key events via verdict, mod=Control (Linux headless Chromium)
| # | keys | expected | observed |
|---|---|---|---|
| B | Shift+/ | cheat sheet `.kbd-cheat` | opens: aria-label "Keyboard shortcuts", 66 `<kbd>` keys, lists quick panel + settings, position fixed; URL gains `shortcuts=true`; Escape closes |
| C | Mod+, | Settings | `?app=settings` |
| D | g then b | Brainstorm | `?app=brainstorm&scope=all` |
| E | Mod+F | find bar `.pc-find` | opens, focus INPUT, `find=true`; Escape closes |
| F | Mod+Shift+F | global search dialog | opens (aria-label "Search everywhere"), focus INPUT, `gsearch=true`; Escape closes |
| G | Mod+K, Mod+P | launcher toggles | `panel=launcher` on, off, on, off (Mod+P did not print) |
| H | Mod+J | quick panel toggles; switches from launcher | `panel=quick` on/off; launcher → Mod+J → `panel=quick` (one exclusive slot) |
| I | Alt+↓ / Alt+↑ | next / previous visible rail app | home → mail → calendar → mail |
| J | Mod+I | Inbox | `?app=inbox` |
| K | Mod+U | agents panel toggles | `panel=agents` on/off |
| L | Alt+← | history back | settings → previous history entry (nuqs replaces same-load app changes, so back lands on the prior page load: inbox) |
| M | Mod+Shift+N | Overview + create dialog (root fallback) | `?app=overview&create=true` (nuqs boolean renders `true`, not the `1` the plan text wrote) |
- Console: no messages. Screenshots: screenshot-cheat-sheet.png, screenshot-find-bar.png, screenshot-global-search.png, screenshot-create-pot.png
