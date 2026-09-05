# Portal (:3081) vs desktop parity inventory — su-e8071, 2026-09-05 19:30Z

Lane: WI-1965083 [owner:Avi 2026-09-05 ~18:28Z, interactive: "keep working through the whole app and achieving parity yourself on AUTO mode"].
Instrument: verdict (headless Chromium) against http://127.0.0.1:3081; desktop reference read from apps/operator-vite source (boot via scripts/verify-tauri-headless.sh only when behaviour is in question).

## Portal app registry (portal/packages/contracts/src/index.ts) — 19 apps, ALL render real content on :3081 (verdict sweep 19:2xZ, release WK6iaiR1NQ7y3gTLmXxmC)
| portal app | mount | operator href | live on :3081 |
|---|---|---|---|
| home | module | — | yes ("Papercusp in your terminal", Inbox, Today) |
| mail / calendar / phone | module | — | yes (portal-native modules) |
| desktops | embedded-pane | /cloud-workspaces?step=operate&tab=desktops | yes |
| plans | embedded-pane | /plans | yes |
| inbox | embedded-pane | /inbox | yes |
| workspaces | module | — | yes (WorkspacesSurface) |
| overview | embedded-pane | /adv?tab=overview | yes |
| hud | embedded-pane | /adv?tab=hud | yes |
| work | embedded-pane | /adv?tab=harnesses | yes |
| learning | embedded-pane | /adv?tab=learning | yes |
| workflows | embedded-pane | /adv?tab=workflows | yes |
| brainstorm | embedded-pane | /adv?tab=brainstorm | yes (per-pot; needs pot pick) |
| cloud | embedded-pane | /cloud-workspaces | yes |
| cupboard | embedded-pane | /cupboard | yes |
| dev | embedded-pane | /dev | yes |
| support | embedded-pane | /support | yes |
| settings | embedded-pane | /settings (+ PortalSettingsCard) | yes |

`mount:"embedded-pane"` mounts the operator's route component NATIVELY in-process via `OPERATOR_SURFACES[kind]` (portal/packages/ui/src/operator-host.tsx `OperatorSurfaceBody`), with the operator's pot bar when `potScopeForSurface(kind).show`. No iframes.

## Desktop reference
- Left sidebar (apps/operator-vite/src/components/left-sidebar/LeftSidebar.tsx): accounts, sentinel (Papercup), pulse, conversations (flag-gated CONVERSATIONS_RAIL_TAB). Portal steering pane (/portal-panes/steering) = Accounts / Papercup / Pulse → PARITY (Convos is flag-gated on the desktop too).
- ADV shell tabs (apps/operator-vite/src/components/adv/AdvShell.tsx ADV_TAB_IDS, 20): overview, hud, brainstorm, harnesses, health, prs, insights, conversations, learning, settings, docs, history, git, stats, testing, plans(Create), workflows, calendar, frames, evals.
- Portal retains ONLY PORTAL_EMBED_ADV_CONTENT_IDS = overview, hud, harnesses, learning, workflows, brainstorm; `portalEmbedAdvTab` forces every other tab to `overview` inside an embed; PORTAL_EMBED_ADV_TAB_IDS (tabs that render the strip in an embed) is EMPTY. Owner pattern [owner:Avi 2026-09-01, quoted in AdvShell.tsx]: "pull out the HUD, WORK and Learning tab like we did for the other tabs".
- Other desktop routes with no portal counterpart: pi, workbench, quick-panel (global-shortcut popup), tasks-roster (chromeless iframe target for the portal's process pill — portal-owned), coord (multi-agent coordination dashboard), harness, wiki, design, users, admin/*, onboarding/setup/signup/login (auth — portal has its own).

## GAP LIST (ordered by value)
G1. 14 desktop ADV tabs unreachable in the portal: health, prs, insights, conversations, settings(adv), docs, history, git, stats, testing, plans(Create), calendar(adv), frames, evals. Mechanism to close: register OPERATOR_SURFACES kinds + portal app entries (contracts registry, PORTAL_APP_KINDS, shell ICONS) + add ids to PORTAL_EMBED_ADV_CONTENT_IDS — the "one id here, not a second code path" seam. Rail budget: 19 apps already; consider one grouped rail entry that renders the AdvShell STRIP (PORTAL_EMBED_ADV_TAB_IDS) for the long tail vs pulling each out.
G2. coord (/coord multi-agent coordination dashboard) — no portal surface.
G3. quick-panel — desktop global-shortcut popup (saved prompts …); portal has launcher panel — compare contents.
G4. Per-embedded-pane sub-section coverage NOT yet verified: settings (22 desktop sections), dev (gym/tokens/…), cupboard/$id, cloud-workspaces steps. Needs a per-section sweep.
G5. wiki / design / users / admin — desktop-only; probably intentionally desktop-local (admin) — decide with disclosed assumption.

## Done this lane (19:03–19:20Z)
- Triage of b33-b62 bugs: 12/14 done by peers; WI-2142706 + WI-2142889 fixed by me, closed; portal release WK6iaiR1NQ7y3gTLmXxmC deployed 19:15Z.
