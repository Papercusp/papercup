//! `pui-companion` — a thin companion zellij plugin: `pui`'s eyes + hands inside
//! zellij (SP-TUI P-004 / D-008).
//!
//! It holds **no backend connection** and renders nothing. It does only what
//! needs zellij internals:
//!   * **observe** the live session — `PaneUpdate` / `TabUpdate` /
//!     `CommandPaneExited` / `PaneClosed` (via `ReadApplicationState`); and
//!   * **execute** in-zellij orchestration — focus / close / open-command-pane /
//!     new-tab / rename (via `ChangeApplicationState`).
//!
//! It is linked full-duplex to the external `pui` binary over ONE long-lived
//! `zellij pipe -p <this-plugin>` child: `pui` writes [`Command`] lines to the
//! child's stdin (→ `ZellijPlugin::pipe`); this plugin writes [`PluginEvent`]
//! lines back via `cli_pipe_output` (→ the child's stdout → `pui`). The whole
//! contract lives in `pui-companion-proto` so both ends can't drift.
//!
//! ## Routing fact (verified in zellij 0.44.3 source — do not "simplify")
//! `cli_pipe_output(pipe_name, …)` routes back to a CLI pipe by its **`pipe_id`**
//! (a per-invocation UUID), NOT by its `--name`: the server's
//! `associate_pipe_with_client` and the CLI's `if pipe_name == pipe_id` both key
//! on the id. So we capture the id from `PipeSource::Cli(id)` on the first
//! inbound message and echo every event back on it. We *match* on `--name`
//! (`pui`) only to ignore unrelated CLI pipes.
//!
//! ## Build / test split — and why this is a `bin`, not a `cdylib`
//! zellij's loader requires a callable `_start` (it runs the module's `fn main`
//! once, then calls the `#[no_mangle]` load/update/pipe/render exports). On
//! modern Rust a `wasm32-wasip1` *cdylib* is a "reactor" (only `_initialize`, no
//! `_start`) → zellij fails with "could not find exported function". So this is
//! a **`bin`** (a "command" module): `register_plugin!`'s generated `fn main`
//! becomes `_start`, while the `#[no_mangle]` exports are still emitted.
//!
//! Every host-shim call is `#[cfg(target_arch = "wasm32")]`-gated; on wasm the
//! macro supplies `fn main`, off-wasm a tiny empty `fn main` lets the same crate
//! build so `cargo test` runs the pure [`build_topology`] unit tests (zellij's
//! wasm host imports don't link natively, so the `ZellijPlugin` impl is absent
//! off-wasm by design).

// Native is purely the unit-test vehicle: the `PuiCompanion` runtime half is
// wasm-only, so off-wasm it is legitimately dead. Allow it there only — the real
// `wasm32` target stays fully strict, so genuine dead code in the plugin is still
// caught by `cargo clippy --target wasm32-wasip1`.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

// Off-wasm, `register_plugin!` (which generates `fn main`) is gated out, so this
// `bin` needs a no-op entry point to build for the native test harness.
#[cfg(not(target_arch = "wasm32"))]
fn main() {}

// Data types are pure (no host imports) and used by `build_topology` + tests on
// every target. The shim functions + event/command enums are wasm-only.
#[cfg(not(target_arch = "wasm32"))]
use zellij_tile::prelude::{PaneManifest, TabInfo};
#[cfg(target_arch = "wasm32")]
use zellij_tile::prelude::*;

use pui_companion_proto::{PaneNode, TabNode, Topology};

/// The `--name` `pui` opens the pipe with. We bind only to this name.
const PIPE_NAME: &str = "pui";

#[derive(Default)]
struct PuiCompanion {
    /// CLI pipe id we echo events back on (see the routing fact above). `None`
    /// until `pui`'s first message arrives, which gates [`PuiCompanion::emit`].
    pipe_id: Option<String>,
    /// Latest pane manifest (tab position → panes) from `PaneUpdate`.
    panes: PaneManifest,
    /// Latest tab list from `TabUpdate`.
    tabs: Vec<TabInfo>,
}

/// Build the compact wire [`Topology`] from the latest manifest + tab list.
/// Pure (no host calls) so it is unit-testable off-wasm — this is the plugin's
/// "serialize side" the brief asks to cover.
fn build_topology(panes: &PaneManifest, tabs: &[TabInfo]) -> Topology {
    let tab_nodes = tabs
        .iter()
        .map(|t| TabNode {
            pos: t.position as u32,
            name: t.name.clone(),
            active: t.active,
        })
        .collect();
    let mut pane_nodes = Vec::new();
    for (tab_pos, list) in &panes.panes {
        for p in list {
            pane_nodes.push(PaneNode {
                id: p.id,
                tab: *tab_pos as u32,
                title: p.title.clone(),
                focused: p.is_focused,
                is_plugin: p.is_plugin,
                exited: p.exited,
                command: p.terminal_command.clone(),
            });
        }
    }
    Topology {
        tabs: tab_nodes,
        panes: pane_nodes,
    }
}

// ───────────────────────────── wasm-only plugin ─────────────────────────────

#[cfg(target_arch = "wasm32")]
use pui_companion_proto::{Command, PluginEvent};
#[cfg(target_arch = "wasm32")]
use std::collections::BTreeMap;
#[cfg(target_arch = "wasm32")]
use std::path::PathBuf;

#[cfg(target_arch = "wasm32")]
register_plugin!(PuiCompanion);

#[cfg(target_arch = "wasm32")]
impl ZellijPlugin for PuiCompanion {
    fn load(&mut self, _configuration: BTreeMap<String, String>) {
        // ReadApplicationState  → PaneUpdate/TabUpdate/CommandPaneExited/PaneClosed
        // ChangeApplicationState → focus / close / new-tab / rename
        // RunCommands           → open_command_pane (the agent-launch path; zellij
        //                         gates command panes behind RunCommands, NOT
        //                         ChangeApplicationState — verified in
        //                         zellij_exports.rs check_command_permission)
        // ReadCliPipes          → cli_pipe_output / block / unblock (the link!)
        request_permission(&[
            PermissionType::ReadApplicationState,
            PermissionType::ChangeApplicationState,
            PermissionType::RunCommands,
            PermissionType::ReadCliPipes,
        ]);
        subscribe(&[
            EventType::PaneUpdate,
            EventType::TabUpdate,
            EventType::CommandPaneExited,
            EventType::PaneClosed,
        ]);
    }

    fn update(&mut self, event: Event) -> bool {
        match event {
            Event::PaneUpdate(manifest) => {
                self.panes = manifest;
                self.emit_topology();
            }
            Event::TabUpdate(tabs) => {
                self.tabs = tabs;
                self.emit_topology();
            }
            // A command pane's command exited (pane is held) — the crash/finish
            // signal `pui` uses to offer/auto-relaunch an agent.
            Event::CommandPaneExited(terminal_pane_id, exit_code, _ctx) => {
                self.emit(&PluginEvent::PaneExited {
                    pane_id: terminal_pane_id,
                    exit_code,
                });
            }
            Event::PaneClosed(pane_id) => {
                let id = match pane_id {
                    PaneId::Terminal(i) | PaneId::Plugin(i) => i,
                };
                self.emit(&PluginEvent::PaneClosed { pane_id: id });
            }
            _ => {}
        }
        // Headless plugin (loaded in the background via `zellij pipe -p`): there
        // is no pane to render to, so never request a render.
        false
    }

    fn pipe(&mut self, pipe_message: PipeMessage) -> bool {
        // Bind only to the `pui` pipe; ignore other CLI pipes / plugin messages.
        if pipe_message.name != PIPE_NAME {
            return false;
        }
        // Capture (or refresh) the id we must echo events back on.
        if let PipeSource::Cli(id) = &pipe_message.source {
            self.pipe_id = Some(id.clone());
        }
        // A `None` payload signals pipe completion (`pui` closed stdin). Nothing
        // to execute; we simply stop emitting once `pui` is gone.
        let Some(payload) = pipe_message.payload else {
            return false;
        };
        // The CLI delivers one stdin line per message; be defensive anyway and
        // handle a payload that happens to carry several lines.
        for line in payload.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(cmd) = Command::from_line(line) {
                self.handle_command(cmd);
            }
            // Malformed lines are ignored on purpose: `pui` validates + logs its
            // own send errors, and a bad line must never wedge the plugin.
        }
        false
    }

    fn render(&mut self, _rows: usize, _cols: usize) {
        // Intentionally empty — D-008: the plugin renders little/nothing.
    }
}

#[cfg(target_arch = "wasm32")]
impl PuiCompanion {
    fn handle_command(&mut self, cmd: Command) {
        match cmd {
            Command::Hello => {
                self.emit(&PluginEvent::Hello {
                    plugin_version: env!("CARGO_PKG_VERSION").to_string(),
                });
                self.emit_topology();
            }
            Command::Ping | Command::Snapshot => self.emit_topology(),
            Command::FocusPane { pane_id } => {
                // not floating, not in-place — focus the tiled terminal pane.
                focus_terminal_pane(pane_id, false, false);
            }
            Command::ClosePane { pane_id } => close_terminal_pane(pane_id),
            Command::OpenCommandPane {
                command,
                args,
                cwd,
                title,
            } => {
                let to_run = CommandToRun {
                    path: PathBuf::from(command),
                    args,
                    cwd: cwd.map(PathBuf::from),
                };
                // `context` is opaque metadata echoed back in CommandPaneOpened;
                // stash the pui-side title there for traceability (it does not
                // set the pane title — pui keeps its own label).
                let mut context = BTreeMap::new();
                if let Some(t) = title {
                    context.insert("pui_title".to_string(), t);
                }
                open_command_pane(to_run, context);
            }
            Command::NewTab { name, layout } => {
                // new_tabs_with_layout needs a stringified KDL layout. An explicit
                // layout wins; a bare name → synthesize a minimal single-pane tab
                // so `{name}` alone still opens a usable named tab.
                match layout {
                    Some(l) => {
                        new_tabs_with_layout(&l);
                    }
                    None => {
                        if let Some(n) = name {
                            let n = n.replace('"', "\\\"");
                            new_tabs_with_layout(&format!("layout {{ tab name=\"{n}\" {{ pane }} }}"));
                        }
                    }
                }
            }
            Command::RenameTab { tab_id, name } => {
                rename_tab_with_id(tab_id as u64, name);
            }
        }
    }

    fn emit_topology(&self) {
        self.emit(&PluginEvent::Topology(build_topology(&self.panes, &self.tabs)));
    }

    /// Emit one event line to `pui` over the captured CLI pipe id. No-op until
    /// the id is known (i.e. before `pui`'s first message). The trailing `\n` is
    /// what makes `pui`'s line-buffered stdout reader frame each event.
    fn emit(&self, ev: &PluginEvent) {
        if let Some(id) = &self.pipe_id {
            cli_pipe_output(id, &format!("{}\n", ev.to_line()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use zellij_tile::prelude::PaneInfo;

    fn pane(id: u32, title: &str, focused: bool) -> PaneInfo {
        PaneInfo {
            id,
            title: title.to_string(),
            is_focused: focused,
            ..Default::default()
        }
    }

    #[test]
    fn build_topology_flattens_manifest_and_tabs() {
        let mut panes = HashMap::new();
        panes.insert(0usize, vec![pane(1, "claude · F-12", true), pane(2, "pui", false)]);
        panes.insert(1usize, vec![pane(5, "docs", false)]);
        let manifest = PaneManifest { panes };
        let tabs = vec![
            TabInfo { position: 0, name: "papercup".into(), active: true, ..Default::default() },
            TabInfo { position: 1, name: "docs".into(), active: false, ..Default::default() },
        ];

        let topo = build_topology(&manifest, &tabs);

        assert_eq!(topo.tabs.len(), 2);
        assert!(topo.tabs.iter().any(|t| t.pos == 0 && t.name == "papercup" && t.active));
        assert_eq!(topo.panes.len(), 3);
        let p1 = topo.panes.iter().find(|p| p.id == 1).unwrap();
        assert_eq!(p1.tab, 0);
        assert!(p1.focused);
        assert!(topo.panes.iter().any(|p| p.id == 5 && p.tab == 1));
    }

    #[test]
    fn topology_command_pane_carries_terminal_command() {
        let mut panes = HashMap::new();
        let mut p = pane(9, "agent", false);
        p.terminal_command = Some("psu --no-picker".into());
        p.exited = true;
        panes.insert(0usize, vec![p]);
        let topo = build_topology(&PaneManifest { panes }, &[]);
        let node = &topo.panes[0];
        assert_eq!(node.command.as_deref(), Some("psu --no-picker"));
        assert!(node.exited);
    }

    #[test]
    fn empty_session_is_empty_topology() {
        let topo = build_topology(&PaneManifest::default(), &[]);
        assert!(topo.tabs.is_empty() && topo.panes.is_empty());
    }
}
