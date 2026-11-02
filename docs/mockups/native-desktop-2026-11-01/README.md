# Native Papercup desktop studies

Three design directions cover five interfaces: Quick Access, terminal HUD panels, window organization, Papercup chat, and accounts. Open `index.html` directly; it has no external dependencies and performs no network requests.

- **A · Focus:** compact floating windows, full terminal side panels when useful, and a small account popover.
- **B · Workbench:** persistent detail panes, a visible fleet rail, conversation history, and expanded account routing details.
- **C · Orbit:** edge controls, drawers, and a docked Papercup conversation beside the terminal.

Use the direction buttons or keys 1–3, the five interface tabs, and the Ubuntu/macOS/Windows chrome selector. Search, agent selection, plan/report previews, layout selection, panel collapse, and account Default/Force/Exclude controls work as simulations. Every action is a preview; nothing is sent to an agent or account service.

Remote connections reuse psu's saved profile and connection mechanism. Sources checked: `apps/operator/scripts/psu-connection-front-controller.mjs`, `apps/tui/src/remote_connect.rs`, and `packages/operator-ui/src/accounts/AccountsTab.tsx`. Sample identities, counts, usage, and reset times are illustrative.

The HTML represents native interface designs; it is not the proposed production renderer. The native implementation would use GNOME/GTK, AppKit/SwiftUI, and WinUI/WPF while retaining existing backend contracts.

`native-desktop.ir.json` records the interaction and component vocabulary. The current registry contains React primitives, so native presentation is represented as an explicit custom surface while preserving registered controls and existing product semantics.

`render.mjs` exports the fifteen interface screenshots, three direction boards, and three platform-chrome samples. Run from the repository root:

```sh
node docs/mockups/native-desktop-2026-11-01/render.mjs
```

The renderer verifies the intended controls and collects browser errors before writing `verification.json`. These checks validate the mockup, not production native behavior.
