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

/// Argv to start a zellij session with the workbench layout. The `options`
/// subcommand layers per-session config overrides WITHOUT replacing the
/// user's config: startup tips are suppressed — these are app-managed
/// sessions (the workbench / the desktop chat dock), and the tips pane
/// floats over the app's panes blocking everything until dismissed.
pub fn launch_argv(layout_path: &str) -> Vec<String> {
    vec![
        "zellij".to_string(),
        "--layout".to_string(),
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
/// bee pane added pui-bee-dossier-pane-2026-06-06): the surface the desktop-docked
/// native terminal runs. SIX panes side-by-side — the **apiary** (the hive
/// browser: the Cupboard's browse/join surface, `pui apiary-pane`), the **voice**
/// channels (`pui voice-pane`), the **operator chat** (`pui chat-pane`), the
/// **brain** (a `psu` engineer-collaborator session), the **swarm** (fleet
/// activity, `pui swarm-pane`) and the **bee** dossier (the swarm-selected bee's
/// task list + coord inbox/outbox, `pui bee-pane`, RIGHT of swarm) — and NOTHING
/// else: no workbench HUD, no work-area agent panes, no swap presets.
///
/// Pane DISPLAY names route through the active Hive lexicon (`lex`): the operator
/// pane is the `operator` term (Queen), swarm is `fleet` (Swarm), bee is
/// `contributor` (Bee). The pinned-pane ARGS (`chat-pane`, `swarm-pane`,
/// `bee-pane`, …) are internal identifiers and never change. `brain_argv` is the
/// brain pane's command; its first element is the command, the rest are quoted
/// args. Pure (no I/O) so it is unit-tested.
pub fn chat_dock_kdl(brain_argv: &[String], lex: &crate::lexicon::Lexicon) -> String {
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
    // Lexicon-resolved, kdl-safe pane display names. Fixed names (apiary, voice,
    // brain) have no lexicon term and stay verbatim.
    let operator_name = kdl_pane_name(&lex.lex("operator"), "operator");
    let swarm_name = kdl_pane_name(&lex.lex("fleet"), "swarm");
    let bee_name = kdl_pane_name(&lex.lex("contributor"), "bee");
    format!(
        r#"// Papercusp chat dock — apiary | voice | operator | brain | swarm | bee
// (native-terminal-desktop P-013 / D-011; bee dossier pane added
// pui-bee-dossier-pane-2026-06-06). The desktop-docked native terminal surface:
// SIX panes only, NO workbench HUD and NO work-area agent panes. Left→right: the
// apiary (the hive browser — the Cupboard's browse/join surface), the P2P voice
// channels, the operator (ElevenLabs voice) chat, the brain (a psu engineer
// session, resumed at launch via the D-013 brain pin), the swarm (fleet
// activity) and the bee dossier (the swarm-selected bee's task list + coord
// inbox/outbox). Pane display names route through the active Hive lexicon.
layout {{
    pane size=1 borderless=true {{
        plugin location="zellij:tab-bar"
    }}
    pane split_direction="vertical" {{
        pane name="apiary" size="12%" {{
            command "pui"
            args "apiary-pane"
        }}
        pane name="voice" size="15%" {{
            command "pui"
            args "voice-pane"
        }}
        pane name="{operator_name}" focus=true size="22%" {{
            command "pui"
            args "chat-pane"
        }}
        pane name="brain" size="22%" {{
            command "{brain_cmd}"{args_line}
        }}
        pane name="{swarm_name}" size="14%" {{
            command "pui"
            args "swarm-pane"
        }}
        pane name="{bee_name}" size="15%" {{
            command "pui"
            args "bee-pane"
        }}
    }}
    pane size=2 borderless=true {{
        plugin location="zellij:status-bar"
    }}
}}
"#
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
) -> std::io::Result<PathBuf> {
    let base = base_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
    materialize_chat_dock_at(&base, brain_argv, lex)
}

fn materialize_chat_dock_at(
    base: &Path,
    brain_argv: &[String],
    lex: &crate::lexicon::Lexicon,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base)?;
    let path = base.join("pui-chat-dock.kdl");
    std::fs::write(&path, chat_dock_kdl(brain_argv, lex))?;
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
        // `options --show-startup-tips false` layers a per-session override
        // (no user-config replacement): the tips pane floats over the
        // app-managed session blocking the panes until dismissed.
        assert_eq!(
            launch_argv("/home/u/.papercusp/pui-workbench.kdl"),
            vec![
                "zellij",
                "--layout",
                "/home/u/.papercusp/pui-workbench.kdl",
                "options",
                "--show-startup-tips",
                "false"
            ]
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
            ("operator", "Queen", "Queens"),
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
    fn chat_dock_has_six_panes_apiary_voice_operator_brain_swarm_bee() {
        // Classic lexicon: operator→"operator", swarm→"fleet", bee→"contributor".
        let lex = Lexicon::default();
        let kdl = chat_dock_kdl(&["psu".to_string(), "--resume".to_string()], &lex);
        // The six panes (classic pane names).
        assert!(kdl.contains("name=\"apiary\""));
        assert!(kdl.contains("name=\"voice\""));
        assert!(kdl.contains("name=\"operator\"")); // lex("operator") = Operator
        assert!(kdl.contains("name=\"brain\""));
        assert!(kdl.contains("name=\"fleet\"")); // lex("fleet") = Fleet (swarm pane)
        assert!(kdl.contains("name=\"contributor\"")); // lex("contributor") = Contributor (bee pane)
        // The pinned-pane ARGS are internal identifiers — NEVER lexicon-driven.
        assert!(kdl.contains("args \"apiary-pane\""));
        assert!(kdl.contains("args \"voice-pane\""));
        assert!(kdl.contains("args \"chat-pane\""));
        assert!(kdl.contains("args \"swarm-pane\""));
        assert!(kdl.contains("args \"bee-pane\"")); // the 6th pane
        assert!(kdl.contains("command \"psu\""));
        assert!(kdl.contains("args \"--resume\""));
        // Side-by-side, left→right: apiary | voice | operator | brain | swarm | bee.
        assert!(kdl.contains("split_direction=\"vertical\""));
        let (a, v, o, b, s, e) = (
            kdl.find("name=\"apiary\"").unwrap(),
            kdl.find("name=\"voice\"").unwrap(),
            kdl.find("name=\"operator\"").unwrap(),
            kdl.find("name=\"brain\"").unwrap(),
            kdl.find("name=\"fleet\"").unwrap(),
            kdl.find("name=\"contributor\"").unwrap(),
        );
        assert!(
            a < v && v < o && o < b && b < s && s < e,
            "pane order must be apiary | voice | operator | brain | swarm | bee (bee RIGHT of swarm)"
        );
        // And NOTHING of the workbench: no HUD, no work area, no swap presets.
        assert!(!kdl.contains("args \"hud\""));
        assert!(!kdl.contains("name=\"work\""));
        assert!(!kdl.contains("swap_tiled_layout"));
        // Exactly FIVE pui panes (apiary + voice + chat + swarm + bee) + one psu.
        assert_eq!(kdl.matches("command \"pui\"").count(), 5);
        assert_eq!(kdl.matches("command \"psu\"").count(), 1);
    }

    #[test]
    fn chat_dock_pane_sizes_sum_to_100() {
        let kdl = chat_dock_kdl(&["psu".to_string()], &Lexicon::default());
        // apiary 12 | voice 15 | operator 22 | brain 22 | swarm 14 | bee 15 = 100.
        for pct in ["12%", "15%", "22%", "14%"] {
            assert!(kdl.contains(pct), "missing pane size {pct}");
        }
        assert_eq!(kdl.matches("size=\"15%\"").count(), 2); // voice + bee
        assert_eq!(kdl.matches("size=\"22%\"").count(), 2); // operator + brain
    }

    #[test]
    fn chat_dock_pane_names_route_through_the_hive_lexicon() {
        // With the-hive active: operator→queen, swarm→swarm, bee→bee (lowercased,
        // kdl-safe). The fixed panes (apiary/voice/brain) stay verbatim.
        let kdl = chat_dock_kdl(&["psu".to_string()], &hive_lex());
        assert!(kdl.contains("name=\"queen\""));
        assert!(kdl.contains("name=\"swarm\""));
        assert!(kdl.contains("name=\"bee\""));
        assert!(kdl.contains("name=\"apiary\""));
        // Classic labels must NOT leak when the-hive is on.
        assert!(!kdl.contains("name=\"operator\""));
        assert!(!kdl.contains("name=\"contributor\""));
        // The internal pinned-pane args are unchanged regardless of pack.
        assert!(kdl.contains("args \"chat-pane\""));
        assert!(kdl.contains("args \"swarm-pane\""));
        assert!(kdl.contains("args \"bee-pane\""));
    }

    #[test]
    fn chat_dock_fresh_brain_omits_args_line() {
        // A bare `psu` brain (fresh, no resume) renders no `args` line.
        let kdl = chat_dock_kdl(&["psu".to_string()], &Lexicon::default());
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
        )
        .unwrap();
        assert!(p.ends_with("pui-chat-dock.kdl"));
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(written.contains("name=\"brain\""));
        assert!(written.contains("args \"chat-pane\""));
        assert!(written.contains("args \"bee-pane\""));
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
