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

/// Name for an app-managed zellij session: `pui-<kind>-<pid>` (kind = `wb` |
/// `dock`). Encoding OUR pid is what makes the leak reapable (EI-186): a later
/// launch can tell a session whose owning pui died (host terminal closed, dock
/// relaunched) from one still in use, and [`crate::reap`] kills only the former.
pub fn session_name(kind: &str) -> String {
    format!("pui-{kind}-{}", std::process::id())
}

/// Argv to start a zellij session with the workbench layout. The session is
/// explicitly named (see [`session_name`]) so exits/crashes can be reaped
/// instead of leaking an auto-named detached server. The `options` subcommand
/// layers per-session config overrides WITHOUT replacing the user's config:
/// startup tips are suppressed — these are app-managed sessions (the workbench
/// / the desktop chat dock), and the tips pane floats over the app's panes
/// blocking everything until dismissed.
///
/// ⚠ The layout MUST be passed as `--new-session-with-layout`, NOT `--layout`:
/// on zellij 0.44 `--layout` + `--session` does not create a session — it is
/// dispatched as "open this layout as a new tab IN the existing session
/// `<name>`" (`send_action_to_session`), which exits 1 with "There is no
/// active session!" / "Session '<name>' not found" since our freshly-named
/// session never exists yet. That regression broke every dock/workbench
/// launch when EI-186 added `--session` for reapability (2026-06-09).
pub fn launch_argv(layout_path: &str, session: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--session".to_string(),
        session.to_string(),
        "--new-session-with-layout".to_string(),
        layout_path.to_string(),
        "options".to_string(),
        "--show-startup-tips".to_string(),
        "false".to_string(),
    ]
}

/// Lowercase + kdl-safe a lexicon label for use as a zellij pane `name`
/// (pui-hive-lexicon-2026-06-06). Keeps ASCII alphanumerics + dash; collapses
/// any run of other chars (spaces, etc.) to a single dash; trims dashes. So
/// "Hive Mind" → "hive-mind", "Queen" → "queen". Never returns empty (a wholly
/// unsafe label falls back to `fallback`).
fn kdl_pane_name(label: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut prev_dash = false;
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// The chat-only DOCK layout (native-terminal-desktop-2026-06-06 P-013 / D-011;
/// consolidated pui-dock-consolidation-2026-06-07): the surface the
/// desktop-docked native terminal runs. TWO panes — the **chat** column
/// (a stack: operator chat ⇄ the brain) and the **main** pane (ONE pui
/// restricted to the Hives · Voice · Swarm tabs, switchable via its tab
/// strip) — and NOTHING
/// else: no workbench HUD, no work-area agent panes, no swap presets. The old
/// standalone apiary/voice/swarm/bee panes are TABS (or Swarm-tab sections) of
/// the main pane now; the bee/contributor dossier renders inside the Swarm tab.
///
/// Pane DISPLAY names route through the active Hive lexicon (`lex`): the
/// operator pane is the `operator` term (Queen). The pinned-pane ARGS
/// (`chat-pane`, `main-pane`) are internal identifiers and never change.
/// `brain_argv` is the brain pane's command; its first element is the command,
/// the rest are quoted args. Pure (no I/O) so it is unit-tested.
pub fn chat_dock_kdl(
    brain_argv: &[String],
    lex: &crate::lexicon::Lexicon,
    hive_agent_tabs: bool,
) -> String {
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
    // Lexicon-resolved, kdl-safe pane display names ("chat" is fixed). Under
    // the-hive pack: operator → sentinel, brain → queen (owner naming, 2026-06-07;
    // operator renamed "Sentinel Bee"→"Sentinel" 2026-06-09 — hive-agent-tabs P-003).
    // P-010: flag-on, prefix the per-type glyph into the zellij pane NAME (zellij
    // has no per-pane color — D-008 — so the glyph is how a type reads at a glance).
    // Flag-off → the bare lexicon name (current dock unchanged). colony (the driver)
    // is infrastructure, not an agent type → left unglyphed.
    use crate::agent_pane_kind::AgentPaneKind;
    let glyph_name = |term: &str, fallback: &str, kind: AgentPaneKind| {
        let n = kdl_pane_name(&lex.lex(term), fallback);
        if hive_agent_tabs { format!("{} {n}", kind.glyph()) } else { n }
    };
    let operator_name = glyph_name("operator", "operator", AgentPaneKind::Sentinel);
    let brain_name = glyph_name("brain", "brain", AgentPaneKind::Queen);
    // P-003 (hive-agent-tabs): under HIVE_AGENT_TABS the Sentinel pane is a REAL
    // psu/Claude TUI (operator role), replacing the `pui chat-pane` widget so it
    // renders like the Queen. It MUST be a FULLY-SCOPED, no-picker launch (owner
    // ask 2026-06-09): `psu --no-picker --agent=claude --role=operator`.
    //   - `--no-picker` → strict scripting launch, no interactive picker.
    //   - `--agent=claude` → required by --no-picker; the Claude TUI backend.
    //   - `--role=operator` → MUST use `=` (psu-launcher parses `--role=<v>`, NOT
    //     space-separated — `--role operator` is silently dropped → role picker).
    //   - workspace/harness/plan are omitted → psu falls back to the operator's
    //     active-workspace defaults (selectionsFromArgs), which is the right scope.
    // Flag-off keeps the chat-pane (which also drives the reactive stack + the pui
    // tab surfaces; relocating those flag-on is the rest of the D-009 restructure).
    let operator_cmd_block = if hive_agent_tabs {
        "command \"psu\"\n            args \"--no-picker\" \"--agent=claude\" \"--role=operator\""
    } else {
        "command \"pui\"\n            args \"chat-pane\""
    };
    // P-004 / D-009: flag-OFF the pui chat-pane both renders the operator chat AND
    // drives the reactive agent stack (one pane per active bee). Flag-ON the operator
    // pane is psu, so that driver must relocate — a dedicated `pui dock-driver` pane
    // runs the reactive loop (dock_agent_panes) with HIVE_AGENT_TABS on and renders
    // the fleet roster as the dock's controller. It exists ONLY in the flag-on layout,
    // so it can assume the flag is on (no fetch). The bee panes it appends resume as
    // real Claude TUIs (RosterEntry::dock_pane_argv → claude --resume). Named via the
    // `fleet` lexicon term. Flag-off → empty (chat-pane drives, layout unchanged).
    let driver_name = kdl_pane_name(&lex.lex("fleet"), "fleet");
    let driver_pane_block = if hive_agent_tabs {
        format!(
            "\n        pane name=\"{driver_name}\" {{\n            command \"pui\"\n            args \"dock-driver\"\n        }}"
        )
    } else {
        String::new()
    };
    // Wake-queue panes (EI-312, owner asks 2026-06-11): the staged-wake board
    // with release / edit / skip + the release-all/skip-all drains, so a
    // paused Queen's queue is reviewable from the dock without tools. TWO
    // panes, both flag-on only (the wake-mode gate's UI rides hive-agent-tabs,
    // P-008/P-009), both stacked with the agents like the colony driver:
    //   "♛⏸ wakes" — the QUEEN's queue only (`wake-pane --queen`), sitting
    //     directly under her chat pane (zellij stacks can't nest splits, so a
    //     sibling stack pane is the per-agent surface);
    //   "⏸ wakes"  — the fleet-wide board (every agent, queen first).
    let queen_wake_pane_block = if hive_agent_tabs {
        "\n        pane name=\"♛⏸ wakes\" {\n            command \"pui\"\n            args \"wake-pane\" \"--queen\"\n        }"
    } else {
        ""
    };
    let wake_pane_block = if hive_agent_tabs {
        "\n        pane name=\"⏸ wakes\" {\n            command \"pui\"\n            args \"wake-pane\"\n        }"
    } else {
        ""
    };
    format!(
        r#"// Papercusp chat dock — ONE full-width agent stack (zellij reserved for the
// truly console-driven surface — owner ask, pui-dock-agent-stack-2026-06-07;
// supersedes the chat|main split of pui-dock-consolidation-2026-06-07).
// The stack opens with the operator (ElevenLabs voice) chat — the sentinel
// bee — expanded over the brain (a psu engineer session resumed at launch via
// the D-013 brain pin). The chat-pane pui then reactively appends ONE pane per
// active swarm agent (`pui watch-pane <owner>` — live dossier + activity +
// mail) and per new local launch, so Alt+↑/↓ (or clicking a title bar) scrolls
// through ALL active agents. Tab-style pui surfaces (Hives · Voice · Swarm …)
// live in the pui app's own tab strip, NOT in zellij. Pane display names route
// through the lexicon.
layout {{
    pane size=1 borderless=true {{
        plugin location="zellij:tab-bar"
    }}
    pane name="chat" stacked=true {{
        pane name="{operator_name}" focus=true expanded=true {{
            {operator_cmd_block}
        }}
        pane name="{brain_name}" {{
            command "{brain_cmd}"{args_line}
        }}{queen_wake_pane_block}{driver_pane_block}{wake_pane_block}
    }}
    pane size=2 borderless=true {{
        plugin location="zellij:status-bar"
    }}
}}
"#
    )
}

/// A deployed frame's zellij TAB layout (hive-agent-tabs P-013): one tab named
/// for the frame, holding that frame's agents as a stack of read-only
/// `pui watch-pane <owner>` panes. Remote agents have no local PTY, so the
/// PG-backed watch-pane IS the terminal-side remote view; the STREAMED desktop
/// view stays the webview Frames tab (`hive-frame-desktops-live-view`, OQ-5
/// settlement). No agents yet → a single shell pane as the placeholder.
/// Pure (no I/O) — unit-tested. The companion's `new_tabs_with_layout` consumes
/// the whole `layout { tab … }` string.
pub fn frame_tab_kdl(tab_name: &str, agents: &[(String, String)]) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let panes = if agents.is_empty() {
        "\n        pane".to_string()
    } else {
        agents
            .iter()
            .map(|(owner, title)| {
                format!(
                    "\n        pane name=\"{}\" {{\n            command \"pui\"\n            args \"watch-pane\" \"{}\"\n        }}",
                    esc(title),
                    esc(owner)
                )
            })
            .collect::<String>()
    };
    // `stacked` needs ≥2 children to be meaningful (and zellij is picky about a
    // one-pane stack) — a lone/placeholder pane renders unstacked.
    let stacked = if agents.len() >= 2 { " stacked=true" } else { "" };
    format!(
        r#"layout {{
    tab name="{name}" {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        pane{stacked} {{{panes}
        }}
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
}}
"#,
        name = esc(tab_name),
        stacked = stacked,
        panes = panes
    )
}

/// The chat dock's brain-pane command (native-terminal-desktop D-013): the
/// canonical brain — `psu --brain` resumes THE pinned brain session exactly
/// (no picker; psu launches + pins a fresh one when no pin exists or it no
/// longer resolves). `env` is PAPERCUSP_BRAIN_CMD's value when set — a
/// whitespace-split full-command override (e.g. "psu --resume <id>" to drive
/// a different session, or "psu --resume" for the picker). Pure — unit-tested.
pub fn default_brain_argv(env: Option<&str>) -> Vec<String> {
    match env {
        Some(s) if !s.trim().is_empty() => s.split_whitespace().map(|x| x.to_string()).collect(),
        _ => vec!["psu".to_string(), "--brain".to_string()],
    }
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

/// Write the chat-dock KDL (for `brain_argv`, with pane names resolved through
/// `lex`) to `~/.papercusp/pui-chat-dock.kdl` and return it. Launched the same
/// way as the workbench (`launch_argv`). (P-013 / pui-hive-lexicon-2026-06-06)
pub fn materialize_chat_dock(
    brain_argv: &[String],
    lex: &crate::lexicon::Lexicon,
    hive_agent_tabs: bool,
) -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_chat_dock_at(&base, brain_argv, lex, hive_agent_tabs)
}

fn materialize_chat_dock_at(
    base: &Path,
    brain_argv: &[String],
    lex: &crate::lexicon::Lexicon,
    hive_agent_tabs: bool,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-chat-dock.kdl");
    std::fs::write(&path, chat_dock_kdl(brain_argv, lex, hive_agent_tabs))?;
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
        // `--session` names the session so it is reapable (EI-186);
        // `--new-session-with-layout` (NEVER `--layout`: combined with
        // `--session` zellij dispatches that as new-tab-in-EXISTING-session
        // and exits "There is no active session!") creates the named session;
        // `options --show-startup-tips false` layers a per-session override
        // (no user-config replacement): the tips pane floats over the
        // app-managed session blocking the panes until dismissed.
        assert_eq!(
            launch_argv("/home/u/.papercusp/pui-workbench.kdl", "pui-wb-42"),
            vec![
                "zellij",
                "--session",
                "pui-wb-42",
                "--new-session-with-layout",
                "/home/u/.papercusp/pui-workbench.kdl",
                "options",
                "--show-startup-tips",
                "false"
            ]
        );
    }

    #[test]
    fn session_name_encodes_kind_and_own_pid() {
        let name = session_name("dock");
        assert_eq!(
            name,
            format!("pui-dock-{}", std::process::id()),
            "owner pid in the name is what makes the session reapable"
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

    use crate::lexicon::Lexicon;
    use crate::models::{LexiconPackPayload, TermForms};
    use std::collections::HashMap;

    /// A the-hive lexicon for the pane-name tests.
    fn hive_lex() -> Lexicon {
        let mut terms = HashMap::new();
        for (k, one, other) in [
            ("operator", "Sentinel", "Sentinels"),
            ("brain", "Queen", "Queens"),
            ("fleet", "Swarm", "Swarms"),
            ("contributor", "Bee", "Bees"),
        ] {
            terms.insert(
                k.to_string(),
                TermForms {
                    one: one.to_string(),
                    other: other.to_string(),
                },
            );
        }
        Lexicon::from_payload(&LexiconPackPayload {
            pack_id: "the-hive".into(),
            label: "The Hive".into(),
            terms,
        })
    }

    #[test]
    fn chat_dock_is_one_agent_stack() {
        // The dock (pui-dock-agent-stack-2026-06-07): ONE full-width zellij
        // stack — operator (expanded) ⇄ brain; active agents append at runtime.
        // No main pane, no tab-subset pui, no side-by-side split.
        let lex = Lexicon::default();
        let kdl = chat_dock_kdl(&["psu".to_string(), "--resume".to_string()], &lex, false);
        assert!(kdl.contains("name=\"chat\""));
        assert!(kdl.contains("name=\"operator\"")); // lex("operator") = Operator
        assert!(kdl.contains("name=\"brain\""));
        assert!(kdl.contains("stacked=true"));
        assert!(kdl.contains("expanded=true"));
        // The pinned-pane ARGS are internal identifiers — NEVER lexicon-driven.
        assert!(kdl.contains("args \"chat-pane\""));
        assert!(kdl.contains("command \"psu\""));
        assert!(kdl.contains("args \"--resume\""));
        // The main pane (tab-subset pui) + the old single-tab panes are GONE —
        // tab surfaces live in the pui app, not zellij.
        for gone in [
            "main-pane",
            "apiary-pane",
            "voice-pane",
            "swarm-pane",
            "bee-pane",
            "name=\"main\"",
            "split_direction",
        ] {
            assert!(!kdl.contains(gone), "stale dock artifact: {gone}");
        }
        // Operator leads the stack (expanded + focused), brain under it.
        let (o, b) = (
            kdl.find("name=\"operator\"").unwrap(),
            kdl.find("name=\"brain\"").unwrap(),
        );
        assert!(o < b, "stack order must be operator ⇄ brain");
        assert!(kdl.find("expanded=true").unwrap() < b);
        // And NOTHING of the workbench: no HUD, no work area, no swap presets.
        assert!(!kdl.contains("args \"hud\""));
        assert!(!kdl.contains("name=\"work\""));
        assert!(!kdl.contains("swap_tiled_layout"));
        // Exactly ONE pui pane (the chat) + one psu (the brain).
        assert_eq!(kdl.matches("command \"pui\"").count(), 1);
        assert_eq!(kdl.matches("command \"psu\"").count(), 1);
    }

    #[test]
    fn chat_dock_stack_children_carry_no_sizes() {
        // The stack gives the expanded pane everything but title bars; only the
        // bar panes carry fixed sizes (tab-bar 1 / status-bar 2).
        let kdl = chat_dock_kdl(&["psu".to_string()], &Lexicon::default(), false);
        assert!(!kdl.contains("size=\""), "no percent sizes in the stack dock");
        assert!(kdl.contains("pane size=1 borderless=true"));
        assert!(kdl.contains("pane size=2 borderless=true"));
    }

    #[test]
    fn chat_dock_pane_names_route_through_the_hive_lexicon() {
        // With the-hive active: operator→sentinel, brain→queen (lowercased,
        // kdl-safe). The fixed "chat" stays verbatim. (renamed from "sentinel-bee",
        // owner directive 2026-06-09 / hive-agent-tabs P-003.)
        let kdl = chat_dock_kdl(&["psu".to_string()], &hive_lex(), false);
        assert!(kdl.contains("name=\"sentinel\""));
        assert!(kdl.contains("name=\"queen\""));
        assert!(kdl.contains("name=\"chat\""));
        // The classic labels must NOT leak when the-hive is on.
        assert!(!kdl.contains("name=\"operator\""));
        assert!(!kdl.contains("name=\"brain\""));
        // The internal pinned-pane arg is unchanged regardless of pack.
        assert!(kdl.contains("args \"chat-pane\""));
    }

    #[test]
    fn chat_dock_hive_agent_tabs_makes_sentinel_a_psu_session() {
        // hive-agent-tabs P-003: flag ON → the operator/Sentinel pane is a real
        // psu/Claude TUI (`psu --role operator`), NOT the `pui chat-pane` widget,
        // so it renders like the Queen. Two psu commands now (Sentinel + brain).
        let on = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default(), true);
        // Fully-scoped, no-picker launch (owner ask): the role is auto-selected.
        assert!(on.contains("args \"--no-picker\" \"--agent=claude\" \"--role=operator\""));
        assert!(on.contains("--role=operator")); // `=` form — psu drops `--role operator`
        assert!(!on.contains("args \"--role\" \"operator\"")); // never the dropped space form
        assert!(!on.contains("args \"chat-pane\""));
        assert_eq!(on.matches("command \"psu\"").count(), 2); // sentinel + queen
        // P-004/D-009: flag-on the reactive driver relocates to a `pui dock-driver`
        // pane (the chat-pane no longer drives); EI-312 adds the staged-wake
        // board panes: the queen's own queue ("♛⏸ wakes", `wake-pane --queen`,
        // directly under her chat pane) + the fleet-wide board ("⏸ wakes").
        assert!(on.contains("args \"dock-driver\""));
        assert!(on.contains("args \"wake-pane\" \"--queen\""));
        assert!(on.contains("name=\"♛⏸ wakes\""));
        assert!(on.contains("args \"wake-pane\"\n"));
        assert!(on.contains("name=\"⏸ wakes\""));
        // The queen's wake pane rides directly under the brain pane, before the
        // colony driver (it IS the queen pane's companion surface).
        let queen_wakes_at = on.find("♛⏸ wakes").expect("queen wake pane");
        let driver_at = on.find("dock-driver").expect("driver pane");
        assert!(queen_wakes_at < driver_at, "queen wakes pane precedes the driver");
        assert_eq!(on.matches("command \"pui\"").count(), 3);

        // Flag OFF → unchanged: the pui chat-pane widget drives the dock (no
        // driver pane, no wake panes).
        let off = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default(), false);
        assert!(off.contains("args \"chat-pane\""));
        assert!(!off.contains("--role=operator"));
        assert!(!off.contains("args \"dock-driver\""));
        assert!(!off.contains("args \"wake-pane\""));
        assert_eq!(off.matches("command \"pui\"").count(), 1);
    }

    #[test]
    fn chat_dock_hive_agent_tabs_glyphs_the_static_pane_names() {
        // P-010: flag-on, the sentinel/queen pane NAMES carry their per-type glyph
        // (zellij has no per-pane color, D-008). Flag-off → bare names (unchanged).
        let on = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default(), true);
        assert!(on.contains("name=\"🛡 operator\""), "sentinel glyph missing: {on}");
        assert!(on.contains("name=\"♛ brain\""), "queen glyph missing");
        let off = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default(), false);
        assert!(off.contains("name=\"operator\""));
        assert!(!off.contains("🛡") && !off.contains("♛"));
    }

    #[test]
    fn chat_dock_fresh_brain_omits_args_line() {
        // A bare `psu` brain (fresh, no resume) renders no `args` line.
        let kdl = chat_dock_kdl(&["psu".to_string()], &Lexicon::default(), false);
        assert!(kdl.contains("command \"psu\""));
        assert!(!kdl.contains("args \"--resume\""));
    }

    #[test]
    fn chat_dock_brain_argv_threads_extra_args() {
        let kdl = chat_dock_kdl(
            &[
                "psu".to_string(),
                "--resume".to_string(),
                "abc-123".to_string(),
            ],
            &Lexicon::default(),
            false,
        );
        assert!(kdl.contains("args \"--resume\" \"abc-123\""));
    }

    #[test]
    fn brain_default_is_the_canonical_pinned_brain() {
        // D-013 auto-pin: the dock's brain pane resumes THE pinned brain
        // (`psu --brain`), not the recent-session picker.
        assert_eq!(default_brain_argv(None), vec!["psu", "--brain"]);
        assert_eq!(default_brain_argv(Some("")), vec!["psu", "--brain"]);
        assert_eq!(default_brain_argv(Some("   ")), vec!["psu", "--brain"]);
    }

    #[test]
    fn brain_env_override_is_whitespace_split() {
        assert_eq!(
            default_brain_argv(Some("psu --resume abc-123")),
            vec!["psu", "--resume", "abc-123"]
        );
    }

    #[test]
    fn materialize_chat_dock_writes_the_kdl() {
        let d = tempfile::tempdir().unwrap();
        let p = materialize_chat_dock_at(
            d.path(),
            &["psu".to_string(), "--resume".to_string()],
            &Lexicon::default(),
            false,
        )
        .unwrap();
        assert!(p.ends_with("pui-chat-dock.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(written.contains("name=\"brain\""));
        assert!(written.contains("args \"chat-pane\""));
        assert!(written.contains("stacked=true"));
    }

    // ── P-013 per-frame tabs ─────────────────────────────────────────────────

    #[test]
    fn frame_tab_kdl_stacks_the_frames_agents_as_watch_panes() {
        let agents = vec![
            ("su-aaa".to_string(), "🐝 su · su-aaa".to_string()),
            ("su-bbb".to_string(), "🐝 su · su-bbb".to_string()),
        ];
        let kdl = frame_tab_kdl("☁ papercup-cloud", &agents);
        assert!(kdl.contains("tab name=\"☁ papercup-cloud\""));
        assert!(kdl.contains("stacked=true"));
        assert!(kdl.contains("args \"watch-pane\" \"su-aaa\""));
        assert!(kdl.contains("args \"watch-pane\" \"su-bbb\""));
        assert!(kdl.contains("name=\"🐝 su · su-aaa\""));
        assert_eq!(kdl.matches("command \"pui\"").count(), 2);
        // The tab keeps its own bars (each zellij tab lays out independently).
        assert!(kdl.contains("zellij:tab-bar"));
        assert!(kdl.contains("zellij:status-bar"));
    }

    #[test]
    fn frame_tab_kdl_placeholder_and_single_pane_are_unstacked() {
        // No agents → a bare shell pane, no one-pane stack (zellij is picky).
        let empty = frame_tab_kdl("☁ idle-frame", &[]);
        assert!(!empty.contains("stacked=true"));
        assert!(!empty.contains("watch-pane"));
        let one = frame_tab_kdl(
            "☁ one",
            &[("su-x".to_string(), "🐝 x".to_string())],
        );
        assert!(!one.contains("stacked=true"));
        assert!(one.contains("args \"watch-pane\" \"su-x\""));
    }

    #[test]
    fn frame_tab_kdl_escapes_quotes() {
        let kdl = frame_tab_kdl(
            "☁ q\"uote",
            &[("o-1".to_string(), "ti\"tle".to_string())],
        );
        assert!(kdl.contains("tab name=\"☁ q\\\"uote\""));
        assert!(kdl.contains("name=\"ti\\\"tle\""));
    }

    #[test]
    fn kdl_pane_name_is_lowercase_and_safe() {
        assert_eq!(kdl_pane_name("Queen", "operator"), "queen");
        assert_eq!(kdl_pane_name("Hive Mind", "substrate"), "hive-mind");
        assert_eq!(kdl_pane_name("", "fallback"), "fallback");
        assert_eq!(kdl_pane_name("!!!", "fallback"), "fallback");
        assert_eq!(kdl_pane_name("Bees", "contributor"), "bees");
    }
}
