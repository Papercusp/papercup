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

use crate::hives::HiveGroup;

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
/// desktop-docked native terminal runs. A **three-tab** zellij session
/// (hive-network-surface-2026-06-11 P-007 / B-10; plans tab added
/// pui-plans-status-board-2026-06-14):
///   * tab **"this hive"** (focus) — the live-TUI dock VERBATIM: the queen
///     split (`psu --brain` + her data boards) over the agent stack
///     (operator/sentinel chat, the reactive dock-driver, the fleet wake board).
///     No workbench HUD, no work-area agent panes, no swap presets.
///   * tab **"network"** — `pui network-pane`, the cross-hive capability-ladder
///     board (own hives, shared-Hive peer Swarms, foreign directory hives);
///     selecting a row drills into an on-demand per-hive tab (`hive_tab_kdl`).
///   * tab **"plans"** — `pui plans-pane`, the plans status board: every plan's
///     status, whether it is being worked on, its agent count, and item
///     progress (done / wip / todo + blocked + needs-human).
/// The tab-bar + status-bar move into a `default_tab_template` shared by all
/// tabs; "this hive" is the FIRST tab + focus=true so the dock opens where it
/// always did (and tier-1 `GoToTab(1)` lands on it). The workbench swap presets
/// are untouched.
///
/// Pane DISPLAY names route through the active Hive lexicon (`lex`): the
/// operator pane is the `operator` term (Queen). The pinned-pane ARGS
/// (`network-pane`, `wake-pane`, …) are internal identifiers and never change.
/// `brain_argv` is the brain pane's command; its first element is the command,
/// the rest are quoted args. Pure (no I/O) so it is unit-tested.
/// (hive-agent-tabs P-014 retired the `pui chat-pane` flag-off dock shape — the
/// queen-split layout is the only dock now.)
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
    // Lexicon-resolved, kdl-safe pane display names ("chat" is fixed). Under
    // the-hive pack: operator → sentinel, brain → queen (owner naming, 2026-06-07;
    // operator renamed "Sentinel Bee"→"Sentinel" 2026-06-09 — hive-agent-tabs P-003).
    // P-010: prefix the per-type glyph into the zellij pane NAME (zellij has no
    // per-pane color — D-008 — so the glyph is how a type reads at a glance).
    // colony (the driver) is infrastructure, not an agent type → left unglyphed.
    use crate::agent_pane_kind::AgentPaneKind;
    let glyph_name = |term: &str, fallback: &str, kind: AgentPaneKind| {
        let n = kdl_pane_name(&lex.lex(term), fallback);
        format!("{} {n}", kind.glyph())
    };
    let operator_name = glyph_name("operator", "operator", AgentPaneKind::Sentinel);
    let brain_name = glyph_name("brain", "brain", AgentPaneKind::Queen);
    // P-003 (hive-agent-tabs): the Sentinel pane is a REAL psu/Claude TUI
    // (operator role) so it renders like the Queen (the `pui chat-pane` widget it
    // replaced was retired by P-014). It MUST be a FULLY-SCOPED, no-picker launch
    // (owner ask 2026-06-09): `psu --no-picker --agent=claude --role=operator`.
    //   - `--no-picker` → strict scripting launch, no interactive picker.
    //   - `--agent=claude` → required by --no-picker; the Claude TUI backend.
    //   - `--role=operator` → MUST use `=` (psu-launcher parses `--role=<v>`, NOT
    //     space-separated — `--role operator` is silently dropped → role picker).
    //   - workspace/harness/plan are omitted → psu falls back to the operator's
    //     active-workspace defaults (selectionsFromArgs), which is the right scope.
    let operator_cmd_block =
        "command \"psu\"\n            args \"--no-picker\" \"--agent=claude\" \"--role=operator\"";
    // P-004 / D-009: the operator pane is psu, so the reactive agent stack has a
    // dedicated driver — the `pui dock-driver` pane runs the reactive loop
    // (dock_agent_panes) and renders the fleet roster as the dock's controller.
    // The bee panes it appends resume as real Claude TUIs
    // (RosterEntry::dock_pane_argv → claude --resume). Named via the `fleet`
    // lexicon term.
    let driver_name = kdl_pane_name(&lex.lex("fleet"), "fleet");
    // 12-space indent: the driver is a member of the `chat` stack, which is
    // nested one level deep inside the queen|stack split.
    let driver_pane_block = format!(
        "\n            pane name=\"{driver_name}\" {{\n                command \"pui\"\n                args \"dock-driver\"\n            }}"
    );
    // The fleet-wide staged-wake board (EI-312): every manual-mode agent's
    // pending wakes (queen first) with release / edit / skip + the release-all/
    // skip-all drains. A stack member alongside the bees + driver (the wake-mode
    // UI, P-008/P-009).
    let wake_pane_block =
        "\n            pane name=\"⏸ wakes\" {\n                command \"pui\"\n                args \"wake-pane\"\n            }";
    // The dock body between the tab-bar and status-bar (hive-agent-tabs flag
    // RETIRED 2026-06-12 — the flag-on shape is the only shape; the classic
    // pui-chat-pane single stack is gone with it):
    //
    // EVERY agent chat in the dock is a LIVE TUI (owner directive 2026-06-11)
    // — never a pui-rendered substitute. The QUEEN is the real interactive
    // `psu --brain` session with her staged-wake board (`pui wake-pane
    // --queen`) in a pane directly beside it (zellij owns the split). A
    // one-pane pui-internal [chat | wakes] split (`pui agent-pane`) was tried
    // 2026-06-11 and REVERTED: pui cannot embed the live session — it could
    // only render a DIFFERENT conversation (the sentinel's), which both showed
    // the wrong agent and dropped the interactive queen. Below her: the agent
    // STACK — the sentinel (ElevenLabs voice) psu chat, the dock-driver (which
    // reactively appends one live `claude --resume` TUI per bee), and the
    // fleet-wide wake board (per-bee queues grouped there).
    //
    // The queen's side column (dock 4-pane split, owner ask 2026-06-11): the
    // 38% column right of her chat is FOUR stacked data boards — the prompt
    // the agent runs on (brief led first), the staged-wake queue, her coord mail, and her
    // work items + plan linkage. Each is its own `pui <x>-pane --queen`
    // process (one pinned Tab each); zellij owns the vertical stack.
    let dock_body = {
        format!(
            r#"    pane split_direction="horizontal" {{
        pane name="♛ queen" split_direction="vertical" size="46%" {{
            pane name="{brain_name}" {{
                command "{brain_cmd}"{args_line}
            }}
            pane split_direction="horizontal" size="38%" {{
                pane name="♛✉ prompt" {{
                    command "pui"
                    args "prompt-pane" "--queen"
                }}
                pane name="♛⏸ wakes" {{
                    command "pui"
                    args "wake-pane" "--queen"
                }}
                pane name="♛✉ mail" {{
                    command "pui"
                    args "mail-pane" "--queen"
                }}
                pane name="♛☑ work" {{
                    command "pui"
                    args "work-pane" "--queen"
                }}
            }}
        }}
        pane name="chat" stacked=true {{
            pane name="{operator_name}" focus=true expanded=true {{
                {operator_cmd_block}
            }}{driver_pane_block}{wake_pane_block}
        }}
    }}"#
        )
    };
    format!(
        r#"// Papercusp chat dock (owner directive 2026-06-11): every agent chat is a
// LIVE TUI. The QUEEN is the real interactive `psu --brain` session with her
// staged-wake board in a pane directly beside it; below her, the agent
// STACK — the operator (ElevenLabs voice) sentinel chat, the dock-driver that
// reactively appends one live `claude --resume` TUI per bee, and the fleet-wide
// wake board. Alt+↑/↓ (or clicking a title bar) scrolls the stack through ALL
// active agents. Pane display names route through the lexicon. (The
// hive-agent-tabs flag is RETIRED — this shape is the only shape.)
//
// Dock tabs (hive-network-surface-2026-06-11 P-007 / B-10; plans tab added
// pui-plans-status-board-2026-06-14): the dock is a THREE-TAB zellij session.
// Tab 1 "this hive" holds the whole dock above VERBATIM (the queen split /
// agent stack — nothing about it changed); tab 2 "network" hosts `pui
// network-pane`, the cross-hive capability-ladder board; tab 3 "plans" hosts
// `pui plans-pane`, the plans status board. The tab-bar + status-bar move into
// a `default_tab_template` so ALL tabs carry them; "this hive" is the first tab
// + focus=true so the dock opens exactly where it always did. Selecting a row
// in the network board opens an on-demand per-hive drill-in tab (see
// `hive_tab_kdl`). The workbench swap presets are untouched.
//
// Tab → fullscreen the focused pane (owner ask 2026-06-11): focus an agent
// chat and press Tab to zoom it full (hiding its wakes pane + the rest); Tab
// again restores the split. zellij `ToggleFocusFullscreen` is its native zoom,
// bound here at the LAYOUT level so it MERGES with the user's config and applies
// only inside this dock session. Trade-off: plain Tab no longer reaches a pane's
// program here (it's the zoom toggle) — but Shift+Tab is a separate bind, so
// Claude's permission-mode toggle is unaffected; only plain-Tab prompt
// completion in the chat panes is given up.
keybinds {{
    normal {{
        bind "Tab" {{ ToggleFocusFullscreen; }}
    }}
}}
layout {{
    default_tab_template {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        children
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
    tab name="this hive" focus=true {{
{dock_body}
    }}
    tab name="network" {{
        pane name="network" {{
            command "pui"
            args "network-pane"
        }}
    }}
    tab name="plans" {{
        pane name="plans" {{
            command "pui"
            args "plans-pane"
        }}
    }}
}}
"#
    )
}

/// A deployed frame's zellij TAB layout (hive-agent-tabs P-013): one tab named
/// for the frame, holding a single shell pane as the placeholder. (P-014
/// retired the read-only `pui watch-pane` surface, and remote agents have no
/// local PTY to attach a real TUI to — so the frame tab is a marker; the
/// remote agents' live view is the STREAMED desktop in the webview Frames tab,
/// `hive-frame-desktops-live-view`.) Pure (no I/O) — unit-tested. The
/// companion's `new_tabs_with_layout` consumes the whole `layout { tab … }`
/// string.
pub fn frame_tab_kdl(tab_name: &str) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"layout {{
    tab name="{name}" {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        pane {{
            pane
        }}
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
}}
"#,
        name = esc(tab_name),
    )
}

/// The input to [`hive_tab_kdl`] — a selected `network`-board row reduced to
/// what the per-hive drill-in tab needs (hive-network-surface-2026-06-11 P-008 /
/// B-10). B-09's network-pane Enter handler maps a C-3 `NetworkBoardRow` into
/// this and sends `Command::NewTab { name: hive_tab_name(&spec), layout: hive_tab_kdl(&spec) }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HiveTabSpec {
    /// The C-3 capability tier (1|2|3|4). Tiers 2/3 are substrate-backed (own
    /// hives / shared-Hive peer Swarms); tier 4 is a foreign directory hive.
    /// Tier 1 is the local hive — the dock's own "this hive" tab — which B-09
    /// routes to GoToTab(1), never here (treated as substrate if it ever lands).
    pub tier: u8,
    /// The C-3 row key — a hive slug (tiers 1–2) or a peer pubkey-b64 (tiers
    /// 3–4). Passed to the pui detail/watch panes as-is; NOT lexicon-routed.
    pub key: String,
    /// The C-3 row title — the human label shown in the tab + detail-pane name.
    pub title: String,
}

/// The zellij tab name for a per-hive drill-in (P-008). The ⌕ prefix marks it a
/// drill-in (distinct from the dock's "this hive"/"network" tabs and the ☁
/// frame tabs) and keeps it from colliding with a user-named tab. Names by the
/// row title, falling back to the key when the title is blank. B-09 passes this
/// as the companion `Command::NewTab { name }` so it matches the KDL's own
/// `tab name=`. Pure.
pub fn hive_tab_name(spec: &HiveTabSpec) -> String {
    let label = if spec.title.trim().is_empty() {
        spec.key.as_str()
    } else {
        spec.title.as_str()
    };
    format!("⌕ {label}")
}

/// One on-demand per-hive DRILL-IN tab (hive-network-surface-2026-06-11 P-008 /
/// B-10), opened when a row in the `network` board (`pui network-pane`) is
/// selected. Mirrors [`frame_tab_kdl`]: a standalone `layout {{ tab … }}` string
/// the companion's `new_tabs_with_layout` injects into the running dock session.
///
/// Composition rides the capability ladder (D-001) via `spec.tier`:
///   * tiers 2/3 (own hives / shared-Hive peer Swarms — substrate-backed): the
///     `pui hive-pane <key>` queen-status / live-counts DETAIL pane (focused).
///     (Per-bee read-only watch panes rode here until hive-agent-tabs P-014
///     retired the `pui watch-pane` surface — live-bee counts stay on the
///     detail pane.)
///   * tier 2 ONLY additionally gets the hive-scoped WAKE board pane
///     (`pui wake-pane --hive <key>`, P-014 item 3 / D-007 GAP 1 closed):
///     tier-2 keys are hive slugs the `network.hive.wakes` query scopes by.
///     Tier-3 keys are peer DEVICE pubkeys — that peer's wake queue lives in
///     their PG, not ours, so tier 3 keeps the detail-header wake summary.
///   * tier 4 (foreign directory hives): a lone `pui hive-pane <key>` DOSSIER
///     (tier badge, trust, beacon fields, grants in/out, ask counts from the
///     C-3 row, plus beacon HISTORY + the C-1 ask log via the dossier
///     queries — P-014 item 2 / D-007 GAP 2 closed).
///
/// Every pane is `close_on_exit=true` — the drill-in tab is never auto-opened
/// and tears itself down when its panes exit (no EXITED husk). The detail pane
/// invokes `pui hive-pane <key>`, rendered tier-aware by B-09. Pure — unit-tested.
pub fn hive_tab_kdl(spec: &HiveTabSpec) -> String {
    // The transient drill-in (P-008): ⌕-named, close-on-exit so it tears down.
    hive_tab_kdl_named(spec, &hive_tab_name(spec), true)
}

/// The zellij tab name for a PERSISTENT per-hive AXIS tab (B4 / P-004). The ◆
/// prefix marks it a STANDING hive tab — distinct from the ⌕ transient drill-in
/// (P-008), the ☁ frame tabs, and the plain "this hive"/"network" dock tabs — so
/// the axis reads as a coherent group and a persistent tab never collides with a
/// transient drill-in of the same hive. Pure.
pub fn hive_axis_tab_name(spec: &HiveTabSpec) -> String {
    let label = if spec.title.trim().is_empty() {
        spec.key.as_str()
    } else {
        spec.title.as_str()
    };
    format!("◆ {label}")
}

/// One PERSISTENT per-hive AXIS tab (B4 / P-004): the same tier-aware pane
/// composition as the transient drill-in [`hive_tab_kdl`], but ◆-named and NOT
/// close-on-exit — it stays for as long as the hive is on the axis (the sync diff
/// in `main.rs` opens it when the hive appears and lets it ride until the hive
/// goes quiet). B5 (P-005) adds the presence-roster pane inside it. Pure.
pub fn hive_axis_tab_kdl(spec: &HiveTabSpec) -> String {
    hive_tab_kdl_named(spec, &hive_axis_tab_name(spec), false)
}

/// Shared generator for the per-hive tab KDL — the transient drill-in
/// ([`hive_tab_kdl`], close-on-exit) and the persistent axis tab
/// ([`hive_axis_tab_kdl`]) differ only in their tab NAME and whether the panes
/// close on exit, so they share this body (no duplicated KDL). Pure.
fn hive_tab_kdl_named(spec: &HiveTabSpec, tab_name: &str, close_on_exit: bool) -> String {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let tab = esc(tab_name);
    let key = esc(&spec.key);
    let detail_label = esc(if spec.title.trim().is_empty() {
        spec.key.as_str()
    } else {
        spec.title.as_str()
    });
    // tier 2 only: the hive-scoped wake board (`network.hive.wakes` scopes by
    // hive SLUG — exactly the tier-2 key; tier-3 keys are peer device pubkeys
    // whose wake queues aren't in our PG).
    let wake_pane = spec.tier == 2;
    // A stack needs ≥2 children (zellij is picky about a one-pane stack); the
    // lead (detail) pane is the expanded one.
    let stacked = wake_pane;
    let detail_attrs = if stacked {
        "focus=true expanded=true"
    } else {
        "focus=true"
    };
    // A persistent axis tab omits close_on_exit so it rides the hive's lifetime;
    // the transient drill-in keeps it so it leaves no EXITED husk.
    let coe = if close_on_exit { " close_on_exit=true" } else { "" };
    let mut panes = format!(
        "\n            pane name=\"{detail_label}\" {detail_attrs}{coe} {{\n                command \"pui\"\n                args \"hive-pane\" \"{key}\"\n            }}",
    );
    if wake_pane {
        panes.push_str(&format!(
            "\n            pane name=\"⏸ wakes\"{coe} {{\n                command \"pui\"\n                args \"wake-pane\" \"--hive\" \"{key}\"\n            }}",
        ));
    }
    let stacked_attr = if stacked { " stacked=true" } else { "" };
    format!(
        r#"layout {{
    tab name="{tab}" {{
        pane size=1 borderless=true {{
            plugin location="zellij:tab-bar"
        }}
        pane{stacked_attr} {{{panes}
        }}
        pane size=2 borderless=true {{
            plugin location="zellij:status-bar"
        }}
    }}
}}
"#,
    )
}

/// The PERSISTENT per-hive tab axis (B4 / shared-hive-collaboration P-004): which
/// hives earn a STANDING dock tab, as opposed to the on-demand ⌕ drill-in (P-008,
/// transient/close-on-exit). Owner decision (2026-06-14): member hives + LIVE
/// federated peers. So a quiet/stale hive drops OFF the axis (the sync diff in
/// `main.rs` retires its tab), and self-reported gossip never earns one (it stays
/// browseable on the Network board until a join admits it).
///
/// One [`HiveTabSpec`] per LIVE federated peer device (C-3 tier 3, substrate-
/// verified — the only multi-hive source the TUI roster carries today). The LOCAL
/// hive is the dock's own `this hive` tab (tier 1, always first) and is
/// intentionally NOT re-emitted here. Pure (no I/O) — `main.rs` diffs this against
/// the open tab set (`hive_tabs_to_create`, mirroring the frame-tab reactive-open)
/// and opens each missing one with the persistent KDL; B5 (P-005) renders the
/// presence roster inside the tab.
pub fn desired_hive_tabs(groups: &[HiveGroup]) -> Vec<HiveTabSpec> {
    groups
        .iter()
        .filter(|g| !g.stale) // the axis tracks who is ACTUALLY here — a quiet hive's tab is retired
        .map(|g| {
            let key = if g.device_pubkey.is_empty() {
                g.machine.clone()
            } else {
                g.device_pubkey.clone()
            };
            let title = if g.machine.is_empty() {
                key.clone()
            } else {
                g.machine.clone()
            };
            HiveTabSpec { tier: 3, key, title }
        })
        .collect()
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
    fn chat_dock_is_the_queen_split_over_the_agent_stack() {
        // The dock (hive-agent-tabs, sole shape since P-014): the queen split
        // (psu --brain + her data boards) over the agent stack (psu sentinel,
        // dock-driver, fleet wake board). The retired `pui chat-pane` widget
        // must never reappear.
        let lex = Lexicon::default();
        let kdl = chat_dock_kdl(&["psu".to_string(), "--resume".to_string()], &lex);
        assert!(kdl.contains("name=\"chat\""));
        assert!(kdl.contains("name=\"🛡 operator\"")); // lex("operator"), P-010 glyph
        assert!(kdl.contains("name=\"♛ brain\""));
        assert!(kdl.contains("stacked=true"));
        assert!(kdl.contains("expanded=true"));
        assert!(kdl.contains("command \"psu\""));
        assert!(kdl.contains("args \"--resume\""));
        // The retired pane modes + old single-tab panes are GONE — tab
        // surfaces live in the pui app, not zellij (chat-pane/watch-pane
        // retired by P-014).
        for gone in [
            "chat-pane",
            "watch-pane",
            "main-pane",
            "apiary-pane",
            "voice-pane",
            "swarm-pane",
            "bee-pane",
            "name=\"main\"",
        ] {
            assert!(!kdl.contains(gone), "stale dock artifact: {gone}");
        }
        // Operator leads the agent stack (expanded + focused), under the queen.
        let (q, o) = (
            kdl.find("name=\"♛ brain\"").unwrap(),
            kdl.find("name=\"🛡 operator\"").unwrap(),
        );
        assert!(q < o, "the queen split precedes the agent stack");
        // And NOTHING of the workbench: no HUD, no work area, no swap presets.
        assert!(!kdl.contains("args \"hud\""));
        assert!(!kdl.contains("name=\"work\" "));
        assert!(!kdl.contains("swap_tiled_layout"));
        assert!(kdl.contains("args \"network-pane\""));
    }

    #[test]
    fn chat_dock_is_a_three_tab_session_this_hive_network_plans() {
        // P-007 (hive-network-surface B-10) + pui-plans-status-board: the dock
        // is a THREE-tab zellij session. Tab 1 "this hive" holds the dock
        // VERBATIM; tab 2 "network" hosts `pui network-pane`; tab 3 "plans"
        // hosts `pui plans-pane`. The bars live in a `default_tab_template`
        // shared by all tabs. The workbench swap presets never appear here.
        let kdl = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default());
        // A shared tab template carries the bars exactly once.
        assert!(kdl.contains("default_tab_template {"), "no default_tab_template");
        assert!(kdl.contains("children"), "template has no children placeholder");
        assert_eq!(
            kdl.matches("zellij:tab-bar").count(),
            1,
            "tab-bar declared once in the template"
        );
        assert_eq!(
            kdl.matches("zellij:status-bar").count(),
            1,
            "status-bar declared once in the template"
        );
        // All three tabs, in order: "this hive" (focus) → "network" → "plans".
        assert!(
            kdl.contains("tab name=\"this hive\" focus=true"),
            "missing focused this-hive tab"
        );
        assert!(kdl.contains("tab name=\"network\""), "missing network tab");
        assert!(kdl.contains("tab name=\"plans\""), "missing plans tab");
        let th = kdl.find("tab name=\"this hive\"").unwrap();
        let nw = kdl.find("tab name=\"network\"").unwrap();
        let pl = kdl.find("tab name=\"plans\"").unwrap();
        assert!(
            th < nw && nw < pl,
            "this hive must be the FIRST tab so tier-1 GoToTab(1) lands on it"
        );
        // The dock body moved VERBATIM inside the this-hive tab (the chat
        // stack sits between the first two tab headers).
        let chat = kdl.find("name=\"chat\"").unwrap();
        assert!(
            th < chat && chat < nw,
            "the dock body must live inside the this-hive tab"
        );
        // The network + plans tabs host their respective pinned pui boards.
        let net_pane = kdl.find("args \"network-pane\"").unwrap();
        assert!(net_pane > nw && net_pane < pl, "network-pane must be inside the network tab");
        let plans_pane = kdl.find("args \"plans-pane\"").unwrap();
        assert!(plans_pane > pl, "plans-pane must be inside the plans tab");
        // The dock is never the workbench.
        assert!(!kdl.contains("swap_tiled_layout"), "no swap presets in the dock");
    }

    #[test]
    fn chat_dock_pane_names_route_through_the_hive_lexicon() {
        // With the-hive active: operator→sentinel, brain→queen (lowercased,
        // kdl-safe, P-010 glyph-prefixed). The fixed "chat" stays verbatim.
        // (renamed from "sentinel-bee", owner directive 2026-06-09 / P-003.)
        let kdl = chat_dock_kdl(&["psu".to_string()], &hive_lex());
        assert!(kdl.contains("name=\"🛡 sentinel\""));
        assert!(kdl.contains("name=\"♛ queen\""));
        assert!(kdl.contains("name=\"chat\""));
        // The classic labels must NOT leak when the-hive is on.
        assert!(!kdl.contains("name=\"🛡 operator\""));
        assert!(!kdl.contains("name=\"♛ brain\""));
    }

    #[test]
    fn chat_dock_sentinel_is_a_psu_session() {
        // hive-agent-tabs P-003: the operator/Sentinel pane is a real
        // psu/Claude TUI (`psu --role operator`) — the `pui chat-pane` widget
        // it replaced was retired by P-014.
        let on = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default());
        // Fully-scoped, no-picker launch (owner ask): the role is auto-selected.
        assert!(on.contains("args \"--no-picker\" \"--agent=claude\" \"--role=operator\""));
        assert!(on.contains("--role=operator")); // `=` form — psu drops `--role operator`
        assert!(!on.contains("args \"--role\" \"operator\"")); // never the dropped space form
        assert!(!on.contains("args \"chat-pane\""));
        // Owner directive 2026-06-11: every dock agent chat is a LIVE TUI — the
        // queen is the real `psu --brain` session (so TWO psu commands:
        // sentinel + brain), with her wake board (`pui wake-pane --queen`) in a
        // pane directly beside it inside the `♛ queen` split container. The
        // one-pane `pui agent-pane` variant was reverted (it could only render
        // the WRONG conversation — the sentinel's).
        assert_eq!(on.matches("command \"psu\"").count(), 2); // sentinel + brain
        assert!(!on.contains("agent-pane"), "the reverted one-pane variant must not return: {on}");
        assert!(on.contains("name=\"♛ queen\" split_direction=\"vertical\""), "queen split container: {on}");
        // The queen's side column is the FOUR stacked data boards (dock 4-pane
        // split, owner ask 2026-06-11): prompt → wakes → mail → work, top-down.
        assert!(on.contains("args \"prompt-pane\" \"--queen\""));
        assert!(on.contains("args \"wake-pane\" \"--queen\""));
        assert!(on.contains("args \"mail-pane\" \"--queen\""));
        assert!(on.contains("args \"work-pane\" \"--queen\""));
        assert!(on.contains("name=\"♛✉ prompt\""));
        assert!(on.contains("name=\"♛⏸ wakes\""));
        assert!(on.contains("name=\"♛✉ mail\""));
        assert!(on.contains("name=\"♛☑ work\""));
        let brief_at = on.find("♛✉ prompt").expect("prompt pane");
        let queen_wakes_at = on.find("♛⏸ wakes").expect("queen wake pane");
        let mail_at = on.find("♛✉ mail").expect("mail pane");
        let work_at = on.find("♛☑ work").expect("work pane");
        assert!(brief_at < queen_wakes_at && queen_wakes_at < mail_at && mail_at < work_at,
            "side column order is prompt → wakes → mail → work");
        // P-004/D-009: the reactive driver + the fleet-wide wake board remain
        // stack members.
        assert!(on.contains("args \"dock-driver\""));
        assert!(on.contains("args \"wake-pane\"\n")); // the fleet-wide pane (bare wake-pane)
        assert!(on.contains("name=\"⏸ wakes\""));
        // queen prompt/wakes/mail/work + driver + fleet-wakes + the network tab's
        // network-pane + the plans tab's plans-pane (P-007 + plans board) = 8.
        assert_eq!(on.matches("command \"pui\"").count(), 8);
        assert!(on.contains("args \"network-pane\""));
        assert!(on.contains("args \"plans-pane\""));
        // Order: brain precedes her side column; the queen container precedes
        // the agent `chat` stack; the driver is inside the stack.
        let queen_at = on.find("name=\"♛ queen\"").expect("queen container");
        let stack_at = on.find("name=\"chat\" stacked=true").expect("chat stack");
        let driver_at = on.find("args \"dock-driver\"").expect("driver pane");
        assert!(queen_at < brief_at, "brain precedes her side column");
        assert!(work_at < stack_at, "the queen split precedes the agent stack");
        assert!(stack_at < driver_at, "the driver is inside the stack");
    }

    #[test]
    fn chat_dock_binds_tab_to_fullscreen_zoom_at_the_layout_level() {
        // owner ask 2026-06-11: Tab fullscreens the focused pane (chat → hide
        // its wakes pane; Tab again restores). A layout-level keybind (merges
        // with the user's config, dock-session-only).
        let kdl = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default());
        assert!(kdl.contains("keybinds {"), "keybinds block missing: {kdl}");
        assert!(
            kdl.contains("bind \"Tab\" { ToggleFocusFullscreen; }"),
            "Tab→fullscreen bind missing: {kdl}",
        );
        // The keybinds block precedes the layout block (zellij wants it as a
        // top-level sibling, not nested in `layout`).
        assert!(
            kdl.find("keybinds {").unwrap() < kdl.find("layout {").unwrap(),
            "keybinds must precede layout",
        );
    }

    #[test]
    fn chat_dock_glyphs_the_static_pane_names() {
        // P-010: the sentinel/queen pane NAMES carry their per-type glyph
        // (zellij has no per-pane color, D-008).
        let kdl = chat_dock_kdl(&["psu".to_string(), "--brain".to_string()], &Lexicon::default());
        assert!(kdl.contains("name=\"🛡 operator\""), "sentinel glyph missing: {kdl}");
        assert!(kdl.contains("name=\"♛ brain\""), "queen/brain glyph missing: {kdl}");
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
        assert!(written.contains("name=\"♛ brain\""));
        assert!(written.contains("args \"dock-driver\""));
        assert!(written.contains("stacked=true"));
    }

    // ── P-013 per-frame tabs ─────────────────────────────────────────────────

    #[test]
    fn frame_tab_kdl_is_a_named_placeholder_tab() {
        // P-014 retired the watch-pane surface, so the frame tab is a marker:
        // a named tab holding a shell placeholder (the remote agents' live
        // view is the streamed desktop in the webview Frames tab).
        let kdl = frame_tab_kdl("☁ papercup-cloud");
        assert!(kdl.contains("tab name=\"☁ papercup-cloud\""));
        assert!(!kdl.contains("watch-pane"));
        assert!(!kdl.contains("command \"pui\""));
        assert!(!kdl.contains("stacked=true"));
        // The tab keeps its own bars (each zellij tab lays out independently).
        assert!(kdl.contains("zellij:tab-bar"));
        assert!(kdl.contains("zellij:status-bar"));
    }

    #[test]
    fn frame_tab_kdl_escapes_quotes() {
        let kdl = frame_tab_kdl("☁ q\"uote");
        assert!(kdl.contains("tab name=\"☁ q\\\"uote\""));
    }

    // ── P-008 per-hive drill-in tabs ─────────────────────────────────────────

    #[test]
    fn desired_hive_tabs_emits_one_persistent_tab_per_live_federated_peer() {
        use crate::hives::HiveGroup;
        let live = HiveGroup {
            machine: "mbp".into(),
            device_pubkey: "key-a".into(),
            stale: false,
            ..Default::default()
        };
        let stale = HiveGroup {
            machine: "tower".into(),
            device_pubkey: "key-b".into(),
            stale: true,
            ..Default::default()
        };
        let specs = desired_hive_tabs(&[live, stale]);
        // Only the LIVE peer earns a standing tab; the stale hive drops off the axis.
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].tier, 3); // federated, substrate-verified
        assert_eq!(specs[0].key, "key-a");
        assert_eq!(specs[0].title, "mbp");
    }

    #[test]
    fn desired_hive_tabs_keys_by_machine_when_pubkey_is_empty() {
        use crate::hives::HiveGroup;
        let g = HiveGroup {
            machine: "tower".into(),
            device_pubkey: String::new(),
            stale: false,
            ..Default::default()
        };
        let specs = desired_hive_tabs(&[g]);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].key, "tower"); // falls back to the machine label as the key
        assert_eq!(specs[0].title, "tower");
    }

    #[test]
    fn hive_axis_tab_kdl_is_persistent_and_distinctly_named() {
        let spec = HiveTabSpec { tier: 3, key: "key-a".into(), title: "mbp".into() };
        let axis = hive_axis_tab_kdl(&spec);
        let drill = hive_tab_kdl(&spec);
        // ◆ marks the standing axis tab; ⌕ marks the transient drill-in.
        assert!(axis.contains("tab name=\"◆ mbp\""));
        assert!(drill.contains("tab name=\"⌕ mbp\""));
        // The axis tab rides the hive's lifetime (no close_on_exit); the drill-in tears down.
        assert!(!axis.contains("close_on_exit"));
        assert!(drill.contains("close_on_exit=true"));
        // Both still open the tier-aware hive-pane detail for the key.
        assert!(axis.contains("args \"hive-pane\" \"key-a\""));
    }

    #[test]
    fn hive_axis_tab_name_falls_back_to_key_when_title_blank() {
        assert_eq!(
            hive_axis_tab_name(&HiveTabSpec { tier: 3, key: "k".into(), title: "mbp".into() }),
            "◆ mbp"
        );
        assert_eq!(
            hive_axis_tab_name(&HiveTabSpec { tier: 3, key: "k".into(), title: String::new() }),
            "◆ k"
        );
    }

    fn hive_spec(tier: u8, key: &str, title: &str) -> HiveTabSpec {
        HiveTabSpec {
            tier,
            key: key.to_string(),
            title: title.to_string(),
        }
    }

    #[test]
    fn hive_tab_name_prefixes_and_falls_back_to_key() {
        // Names by the row title; the ⌕ prefix marks a drill-in. Blank title →
        // the key (a foreign pubkey-b64 still gets a usable tab name).
        assert_eq!(hive_tab_name(&hive_spec(4, "AbC+/d", "Acme Hive")), "⌕ Acme Hive");
        assert_eq!(hive_tab_name(&hive_spec(2, "papercup", "")), "⌕ papercup");
        assert_eq!(hive_tab_name(&hive_spec(2, "papercup", "   ")), "⌕ papercup");
    }

    #[test]
    fn hive_tab_kdl_tier4_is_a_lone_dossier_pane() {
        // tier 4 (foreign): ONE `pui hive-pane <key>` dossier pane, not
        // stacked. Carries its own bars (injected into the live session, like
        // frame_tab_kdl).
        let kdl = hive_tab_kdl(&hive_spec(4, "k3y+b64", "Foreign Hive"));
        assert!(kdl.contains("tab name=\"⌕ Foreign Hive\""));
        assert_eq!(kdl.matches("args \"hive-pane\" \"k3y+b64\"").count(), 1);
        assert!(!kdl.contains("stacked=true"), "a lone dossier pane is not stacked");
        assert!(kdl.contains("focus=true close_on_exit=true"));
        assert!(kdl.contains("zellij:tab-bar"));
        assert!(kdl.contains("zellij:status-bar"));
        // Exactly the one detail pane runs pui.
        assert_eq!(kdl.matches("command \"pui\"").count(), 1);
    }

    #[test]
    fn hive_tab_kdl_tier2_stacks_detail_plus_wake_board() {
        // tier 2 (own hive): the focused detail pane LEADS a stack with the
        // hive-scoped wake board (P-014 item 3 / D-007 GAP 1 —
        // `network.hive.wakes` scopes by the tier-2 hive slug). Every pane is
        // close_on_exit. (Per-bee watch panes rode here until hive-agent-tabs
        // P-014 retired the watch-pane surface.)
        let kdl = hive_tab_kdl(&hive_spec(2, "papercup", "This Box"));
        assert!(kdl.contains("args \"hive-pane\" \"papercup\""));
        assert!(kdl.contains("args \"wake-pane\" \"--hive\" \"papercup\""));
        assert!(kdl.contains("name=\"⏸ wakes\""));
        assert!(!kdl.contains("watch-pane"));
        assert!(kdl.contains("stacked=true"));
        assert!(kdl.contains("focus=true expanded=true close_on_exit=true"));
        // detail (hive-pane) leads the stack, the wake board follows.
        let detail_at = kdl.find("args \"hive-pane\"").unwrap();
        let wake_at = kdl.find("args \"wake-pane\"").unwrap();
        assert!(detail_at < wake_at, "the detail pane leads the stack");
        assert_eq!(kdl.matches("command \"pui\"").count(), 2);
        // Every command pane tears down on exit (no EXITED husk).
        assert_eq!(kdl.matches("close_on_exit=true").count(), 2);
    }

    #[test]
    fn hive_tab_kdl_tier3_is_detail_only() {
        // tier 3 (peer swarm): just the detail pane — no stack and NO wake
        // board (tier-3 keys are peer device pubkeys; that peer's wake queue
        // lives in their PG, not ours).
        let kdl = hive_tab_kdl(&hive_spec(3, "pk-peer", "Peer Swarm"));
        assert!(kdl.contains("args \"hive-pane\" \"pk-peer\""));
        assert!(!kdl.contains("wake-pane"));
        assert!(!kdl.contains("stacked=true"));
        assert!(kdl.contains("focus=true close_on_exit=true"));
        assert_eq!(kdl.matches("command \"pui\"").count(), 1);
    }

    #[test]
    fn hive_tab_kdl_tab_name_matches_hive_tab_name() {
        // The KDL's `tab name=` MUST equal hive_tab_name(spec) (escaped) so the
        // companion `Command::NewTab { name }` B-09 sends agrees with the layout
        // — otherwise zellij would show two names / fail to de-dupe the tab.
        let spec = hive_spec(3, "peer", "Peer Swarm");
        let expected = format!("tab name=\"{}\"", hive_tab_name(&spec));
        assert!(hive_tab_kdl(&spec).contains(&expected));
    }

    #[test]
    fn hive_tab_kdl_escapes_quotes() {
        let kdl = hive_tab_kdl(&hive_spec(2, "ke\"y", "Ti\"tle"));
        assert!(kdl.contains("tab name=\"⌕ Ti\\\"tle\""));
        assert!(kdl.contains("args \"hive-pane\" \"ke\\\"y\""));
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
