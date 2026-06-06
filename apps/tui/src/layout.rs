//! Workbench zellij layout (D-001, dockview-workbench-2026-06-05). The workbench
//! is a zellij session whose `pui` HUD pane rides alongside a "work" area where
//! native agent panes (claude/codex/omp) open via the companion plugin
//! (`open_command_pane` + imperative `stack_panes`) or the `zellij action
//! new-pane` fallback (`mux::MuxAction`). pui is NOT a zellij plugin — the WASM
//! plugin sandbox can't reach our Unix-socket IPC — so it runs as a normal pane
//! and drives the session from the outside.
//!
//! ## Dockview shape (Brief 50)
//! The work area is a **stacked** group by default (tab-like: one agent expanded,
//! the rest collapsed to title rows) so N agents stay readable instead of tiling
//! ever-thinner. Four `swap_tiled_layout` presets cycle with `Alt+[`/`Alt+]`
//! (zellij's default Previous/NextSwapLayout binds — we ship layouts, never
//! config, D-006):
//!   * `stacked`      — work stack 60% │ HUD 40%  (the default; best for many agents)
//!   * `stacked-left` — the mirror (HUD docked left; the `:dock left` target, D-008)
//!   * `split`        — work area as even rows │ HUD  (good for 2–3 visible at once)
//!   * `grid`         — work area auto-tiled 2D, no split_direction → zellij BSP (4/6 visible)
//!
//! Each preset's work container holds the single `children` placeholder where
//! zellij flows the runtime panes. The fixed HUD command pane (`pui hud`) and the
//! tab/status bars are re-declared in every preset so a swap re-slots them into
//! place — verified in an isolated zellij 0.44.3 session that the HUD command
//! pane reliably lands in its declared slot, including the mirrored template
//! (D-007). Materialising + launching is the same single command as before; only
//! the KDL grew the stacked default + the presets.

use std::path::{Path, PathBuf};

/// The workbench layout in zellij KDL: a stacked work area beside the fixed `pui`
/// HUD, plus four swap presets (see the module doc). The base arrangement
/// matches the `stacked` preset so the session opens docked-and-stacked.
pub const WORKBENCH_KDL: &str = r#"// Papercusp workbench — stacked work area + pui HUD, with dockview swap presets.
// (dockview-workbench-2026-06-05 / Brief 50). Alt+[ / Alt+] cycle the presets.
layout {
    pane size=1 borderless=true {
        plugin location="zellij:tab-bar"
    }
    pane split_direction="vertical" {
        pane name="work" stacked=true focus=true size="60%" {
            pane
        }
        pane name="pui" size="40%" {
            command "pui"
            args "hud"
        }
    }
    pane size=2 borderless=true {
        plugin location="zellij:status-bar"
    }

    // ── Preset: stacked (default) — agents stack tab-like beside the HUD ──
    swap_tiled_layout name="stacked" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="work" stacked=true size="60%" {
                    children
                }
                pane name="pui" size="40%" {
                    command "pui"
                    args "hud"
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }

    // ── Preset: stacked-left — the mirror; HUD docked on the left (:dock left) ──
    swap_tiled_layout name="stacked-left" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="pui" size="40%" {
                    command "pui"
                    args "hud"
                }
                pane name="work" stacked=true size="60%" {
                    children
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }

    // ── Preset: split — work area as even rows beside the HUD (2–3 agents) ──
    swap_tiled_layout name="split" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="work" split_direction="horizontal" size="60%" {
                    children
                }
                pane name="pui" size="40%" {
                    command "pui"
                    args "hud"
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }

    // ── Preset: grid — work area auto-tiled 2D (no split_direction → zellij BSP) ──
    swap_tiled_layout name="grid" {
        tab {
            pane size=1 borderless=true {
                plugin location="zellij:tab-bar"
            }
            pane split_direction="vertical" {
                pane name="work" size="65%" {
                    children
                }
                pane name="pui" size="35%" {
                    command "pui"
                    args "hud"
                }
            }
            pane size=2 borderless=true {
                plugin location="zellij:status-bar"
            }
        }
    }
}
"#;

/// The swap-preset names, in cycle order (matches the `swap_tiled_layout` blocks
/// in [`WORKBENCH_KDL`]). `pui` uses this to label the active preset + to drive
/// `:dock`/`:layout` (D-008). The first entry is the default arrangement.
pub const SWAP_PRESETS: &[&str] = &["stacked", "stacked-left", "split", "grid"];

/// Argv to start a zellij session with the workbench layout.
pub fn launch_argv(layout_path: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--layout".to_string(),
        layout_path.to_string(),
    ]
}

/// The chat-only DOCK layout (native-terminal-desktop-2026-06-06 P-013 / D-011):
/// the surface the desktop-docked native terminal runs. Two panes side-by-side —
/// the **operator chat** (a chat-only `pui chat-pane`) and the **brain** (a `psu`
/// engineer-collaborator session) — and NOTHING else: no workbench HUD, no
/// work-area agent panes, no swap presets. `brain_argv` is the brain pane's
/// command (e.g. `["psu", "--resume"]`); its first element is the command, the
/// rest are quoted args. Pure (no I/O) so it is unit-tested.
pub fn chat_dock_kdl(brain_argv: &[String]) -> String {
    let (brain_cmd, brain_args) = brain_argv
        .split_first()
        .map(|(c, rest)| (c.as_str(), rest))
        .unwrap_or(("psu", &[]));
    let args_line = if brain_args.is_empty() {
        String::new()
    } else {
        let quoted = brain_args
            .iter()
            .map(|a| format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(" ");
        format!("\n            args {quoted}")
    };
    format!(
        r#"// Papercusp chat dock — operator chat | brain (native-terminal-desktop
// P-013 / D-011). The desktop-docked native terminal surface: TWO panes only,
// NO workbench HUD and NO work-area agent panes. Left = the operator (ElevenLabs
// voice) chat as a chat-only pui pane; right = the brain (a psu engineer
// session, resumed at launch).
layout {{
    pane size=1 borderless=true {{
        plugin location="zellij:tab-bar"
    }}
    pane split_direction="vertical" {{
        pane name="operator" focus=true size="50%" {{
            command "pui"
            args "chat-pane"
        }}
        pane name="brain" size="50%" {{
            command "{brain_cmd}"{args_line}
        }}
    }}
    pane size=2 borderless=true {{
        plugin location="zellij:status-bar"
    }}
}}
"#
    )
}

fn base_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".papercusp"))
}

/// Write the workbench KDL to `~/.papercusp/pui-workbench.kdl` and return it.
pub fn materialize() -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_at(&base)
}

fn materialize_at(base: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-workbench.kdl");
    std::fs::write(&path, WORKBENCH_KDL)?;
    Ok(path)
}

/// Write the chat-dock KDL (for `brain_argv`) to `~/.papercusp/pui-chat-dock.kdl`
/// and return it. Launched the same way as the workbench (`launch_argv`). (P-013)
pub fn materialize_chat_dock(brain_argv: &[String]) -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_chat_dock_at(&base, brain_argv)
}

fn materialize_chat_dock_at(base: &Path, brain_argv: &[String]) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-chat-dock.kdl");
    std::fs::write(&path, chat_dock_kdl(brain_argv))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kdl_defines_pui_and_work_panes() {
        assert!(WORKBENCH_KDL.contains("command \"pui\""));
        assert!(WORKBENCH_KDL.contains("args \"hud\"")); // HUD pane runs `pui hud`, never bare `pui` (no nesting)
        assert!(WORKBENCH_KDL.contains("name=\"work\""));
        assert!(WORKBENCH_KDL.contains("name=\"pui\""));
        assert!(WORKBENCH_KDL.contains("layout {"));
    }

    #[test]
    fn base_work_area_is_stacked_by_default() {
        // The base arrangement (before any swap) opens docked-and-stacked so N
        // agents are tab-like, not ever-thinner tiles (Brief 50 / D-001).
        assert!(WORKBENCH_KDL.contains("name=\"work\" stacked=true"));
    }

    #[test]
    fn declares_all_four_swap_presets_in_cycle_order() {
        for name in SWAP_PRESETS {
            assert!(
                WORKBENCH_KDL.contains(&format!("swap_tiled_layout name=\"{name}\"")),
                "missing swap preset {name}"
            );
        }
        // SWAP_PRESETS order matches the order they appear in the KDL (so the
        // label pui shows tracks the actual Alt+[/] cycle).
        let mut last = 0usize;
        for name in SWAP_PRESETS {
            let at = WORKBENCH_KDL
                .find(&format!("swap_tiled_layout name=\"{name}\""))
                .unwrap();
            assert!(at >= last, "preset {name} out of cycle order");
            last = at;
        }
        // The default (first) preset is `stacked`.
        assert_eq!(SWAP_PRESETS.first().copied(), Some("stacked"));
    }

    #[test]
    fn every_preset_keeps_the_hud_and_a_children_placeholder() {
        // Each swap preset re-declares the HUD command pane (so a swap re-slots
        // it, D-007) and has exactly one `children` placeholder for runtime panes.
        // 4 presets + the base arrangement = 5 HUD command panes.
        assert_eq!(WORKBENCH_KDL.matches("command \"pui\"").count(), 5);
        // One `children` per preset (the base uses a bare `pane`, not children).
        assert_eq!(
            WORKBENCH_KDL.matches("children").count(),
            SWAP_PRESETS.len()
        );
        // Both stacked presets keep the work group stacked.
        assert_eq!(
            WORKBENCH_KDL.matches("stacked=true").count(),
            3 // base + `stacked` + `stacked-left`
        );
        // `split` lays the work area out as rows; `grid` leaves it unconstrained
        // (no split_direction → zellij's adaptive 2D BSP tiling).
        assert!(WORKBENCH_KDL.contains("name=\"work\" split_direction=\"horizontal\""));
    }

    #[test]
    fn keeps_the_tab_and_status_bars_in_every_preset() {
        // 4 presets + base = 5 of each bar.
        assert_eq!(
            WORKBENCH_KDL.matches("zellij:tab-bar").count(),
            SWAP_PRESETS.len() + 1
        );
        assert_eq!(
            WORKBENCH_KDL.matches("zellij:status-bar").count(),
            SWAP_PRESETS.len() + 1
        );
    }

    #[test]
    fn launch_argv_shape() {
        assert_eq!(
            launch_argv("/home/u/.papercusp/pui-workbench.kdl"),
            vec!["zellij", "--layout", "/home/u/.papercusp/pui-workbench.kdl"]
        );
    }

    #[test]
    fn materialize_writes_the_kdl() {
        let d = tempfile::tempdir().unwrap();
        let p = materialize_at(d.path()).unwrap();
        assert!(p.ends_with("pui-workbench.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert_eq!(written, WORKBENCH_KDL);
    }

    // ── P-013 chat dock ──────────────────────────────────────────────────────

    #[test]
    fn chat_dock_has_just_operator_and_brain_panes() {
        let kdl = chat_dock_kdl(&["psu".to_string(), "--resume".to_string()]);
        // The two panes: operator chat (chat-only pui) | brain (psu --resume).
        assert!(kdl.contains("name=\"operator\""));
        assert!(kdl.contains("name=\"brain\""));
        assert!(kdl.contains("command \"pui\""));
        assert!(kdl.contains("args \"chat-pane\""));
        assert!(kdl.contains("command \"psu\""));
        assert!(kdl.contains("args \"--resume\""));
        // Side-by-side.
        assert!(kdl.contains("split_direction=\"vertical\""));
        // And NOTHING of the workbench: no HUD, no work area, no swap presets.
        assert!(!kdl.contains("args \"hud\""));
        assert!(!kdl.contains("name=\"work\""));
        assert!(!kdl.contains("swap_tiled_layout"));
        // Exactly one pui + one psu command (the two panes).
        assert_eq!(kdl.matches("command \"pui\"").count(), 1);
        assert_eq!(kdl.matches("command \"psu\"").count(), 1);
    }

    #[test]
    fn chat_dock_fresh_brain_omits_args_line() {
        // A bare `psu` brain (fresh, no resume) renders no `args` line.
        let kdl = chat_dock_kdl(&["psu".to_string()]);
        assert!(kdl.contains("command \"psu\""));
        assert!(!kdl.contains("args \"--resume\""));
    }

    #[test]
    fn chat_dock_brain_argv_threads_extra_args() {
        let kdl = chat_dock_kdl(&[
            "psu".to_string(),
            "--resume".to_string(),
            "abc-123".to_string(),
        ]);
        assert!(kdl.contains("args \"--resume\" \"abc-123\""));
    }

    #[test]
    fn materialize_chat_dock_writes_the_kdl() {
        let d = tempfile::tempdir().unwrap();
        let p =
            materialize_chat_dock_at(d.path(), &["psu".to_string(), "--resume".to_string()]).unwrap();
        assert!(p.ends_with("pui-chat-dock.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(written.contains("name=\"brain\""));
        assert!(written.contains("args \"chat-pane\""));
    }
}
