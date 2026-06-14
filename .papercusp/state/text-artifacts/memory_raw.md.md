---
rel_path: "memory/raw.md"
updated_at: 1781443424969
_body: "content"
---


[2026-06-14T13:30:00Z] worker EI-9: headless zellij `pipe --plugin` companions get a focused FLOATING pane by default (zellij 0.44.3 floating_plugin default) — call hide_self() (SuppressPane, permission-free) in load() to suppress it; when it's the only float, zellij also hides the float layer + returns focus to the tiled pane. An external `toggle-floating-panes` on a ready-event RACES pane creation; hide_self() from inside load() + a one-shot retry on first PaneUpdate is the reliable fix.

