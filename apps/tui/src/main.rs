//! `pui` — Papercusp terminal workbench (SP-TUI, tui-workbench-ratatui-2026-06-04).
//!
//! Architecture: `App` holds state, `event` normalises inputs onto one mpsc
//! channel, `App::update` is the single reducer, `ui::draw` is a pure renderer.
//! Data is **push-driven (D-003, no polling)**: we fetch once on startup, then
//! subscribe to the operator's `/api/zero-harness/sse` invalidation stream OVER
//! IPC and refetch the affected views when an `invalidate`/`update` arrives. A
//! slow (60s) safety-net refetch is the only timer, and it is a fallback — not a
//! poll. P1 = the Create tab (Plans / Inbox / Sessions).

mod agent_ctx;
mod agent_pane_kind;
mod app;
mod bee;
mod brain_view;
mod card_view;
mod chat_tags;
mod client;
mod companion;
mod event;
mod fleet;
mod framing;
mod glyph;
mod hives;
mod http;
mod ipc;
mod layout;
mod lexicon;
mod models;
mod mux;
mod network;
mod notify;
mod operator_voice_bus;
mod plans_board;
mod reap;
mod session_panes;
mod sse;
mod theme;
mod transcript;
mod tutorial;
mod ui;
mod voice;
mod voice_convai;
mod voice_stream;
mod voice_ui;
mod wake_board;
mod workbench;
mod zellij_theme;

use anyhow::Result;
use crossterm::{
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::Backend, backend::CrosstermBackend, Terminal};
use std::io::stdout;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use app::{Action, App, DockCmd};
use client::OperatorClient;
use companion::Companion;
use event::{spawn_input_listener, Event};
use mux::{Multiplexer, MuxAction, Zellij};

#[tokio::main]
async fn main() -> Result<()> {
    // Subcommand dispatch — bare `pui` opens the full workbench (the UX a human
    // wants from typing `pui`):
    //   pui workbench → force the zellij workbench (D-001)
    //   pui hud       → force just the HUD (what the workbench's own HUD pane runs)
    //   pui           → the workbench from a plain terminal, but just the HUD when
    //                   already inside zellij (so the HUD pane can't recursively
    //                   nest another workbench — `$ZELLIJ` is set by zellij).
    let subcommand = std::env::args().nth(1);
    match subcommand.as_deref() {
        Some("workbench") => return run_workbench(),
        // The chat-only DOCK (operator chat | brain) — the desktop-docked native
        // terminal surface (native-terminal-desktop P-013 / D-011). Materialises
        // its own 2-pane layout and hands off to zellij.
        Some("chat") => return run_chat_dock().await,
        // Manual sweep of leaked app-managed zellij sessions (EI-186) — the same
        // sweep every workbench/dock launch runs. For ops + smoke-testing.
        Some("reap") => {
            reap::reap_stale(&layout::session_name("reap"));
            return Ok(());
        }
        // Read-only live transcript view of the autonomous Queen / Overwatch
        // (queen-overwatch-live-visibility D-003): the dock's ♛ queen / 👁 overwatch
        // panes. Tails the ONE shared session transcript so every desktop instance
        // shows the SAME live agent + survives shell exit (not a per-window psu shell).
        Some("brain-view") => {
            return brain_view::run(brain_view::Scope::from_arg(
                std::env::args().nth(2).as_deref(),
            ))
            .await;
        }
        Some("hud") => {}
        // Dock pane modes — fall through to the normal run loop. The old
        // main-pane (tab-subset) + voice-/swarm-/bee-pane standalone modes are
        // GONE (tab surfaces live in the pui app, not zellij), and
        // hive-agent-tabs P-014 retired `chat-pane` (the dock's operator-chat
        // widget — the Sentinel is a real psu session now) and
        // `watch-pane <owner>` (the read-only per-bee view — claude bees
        // resume as real Claude TUIs via the dock-driver).
        // dock-driver (hive-agent-tabs P-004/D-009): the operator pane is psu,
        // so the reactive agent stack needs a dedicated driver pane — it runs
        // the reactive loop + renders the Fleet roster as the dock controller.
        // wake-pane (EI-312): the dock's staged-wake board — every manual-mode
        // agent's pending wakes (queen first) with release / edit / skip and
        // the release-all / skip-all drains. Pinned to the pane-only Tab::Wake.
        // prompt-/mail-/work-pane (dock 4-pane split, owner ask 2026-06-11): one
        // agent-context board each — the prompt the agent runs on, the coord mail, the work
        // items + plan linkage. Scope arg like wake-pane (--queen | <owner>).
        // network-pane / hive-pane (hive-network-surface-2026-06-11 B-09): the
        // dock `network` tab's cross-Hive board, and the per-hive drill-in
        // tab's dossier pane (B-10's generated tabs run `pui hive-pane <key>`).
        // plans-pane (pui-plans-status-board-2026-06-14): the dock's plans
        // status board — a pinned data board, the network-pane convention.
        Some("dock-driver") | Some("wake-pane") | Some("prompt-pane") | Some("mail-pane")
        | Some("work-pane") | Some("network-pane") | Some("hive-pane") | Some("plans-pane") => {}
        None if std::env::var_os("ZELLIJ").is_none() => return run_workbench(),
        _ => {}
    }
    // Pinned single-tab dock pane: render JUST that tab's body (no tab strip /
    // HUD / work area); the full data wiring in run() is unchanged.
    let pinned = match subcommand.as_deref() {
        // dock-driver: render the Fleet roster (the dock controller) while driving
        // the reactive bee stack (hive-agent-tabs P-004/D-009).
        Some("dock-driver") => Some(app::Tab::Fleet),
        // wake-pane: the staged-wake board (EI-312).
        Some("wake-pane") => Some(app::Tab::Wake),
        Some("prompt-pane") | Some("mail-pane") | Some("work-pane") => Some(app::Tab::AgentCtx),
        // network-pane: the cross-Hive board; hive-pane: one row's dossier
        // (same tab — `network_focus` below selects the mode).
        Some("network-pane") | Some("hive-pane") => Some(app::Tab::Network),
        // plans-pane: the dock's plans status board (pui-plans-status-board).
        Some("plans-pane") => Some(app::Tab::PlansBoard),
        _ => None,
    };
    // Slim dock theme (owner ask 2026-06-23): a pinned dock pane renders base
    // surfaces TRANSPARENT so the ratatui dock panes (Fleet/colony, the queen
    // boards, wakes) inherit the user's plain Ghostty bg — matching the slim
    // plain-text brain-view panes + the Claude TUI, instead of painting the
    // opaque `frost` panel over the dock (the colony pane was the lone holdout
    // that "didn't get the new theme"). Off in the standalone workbench
    // (pinned == None), which keeps the opaque dashboard surfaces.
    if pinned.is_some() {
        crate::theme::Theme::set_transparent_surfaces(true);
    }
    let agent_ctx_mode = match subcommand.as_deref() {
        Some("mail-pane") => app::AgentCtxMode::Mail,
        Some("work-pane") => app::AgentCtxMode::Work,
        _ => app::AgentCtxMode::Prompt,
    };
    // Hive drill-in pane (hive-network-surface B-09, the B-10 tab seam): the
    // C-3 row key (slug or pubkey-b64) this instance renders full-pane.
    // Required argv[2] for `hive-pane`; `network-pane` renders the board.
    let network_focus: Option<String> = match subcommand.as_deref() {
        Some("hive-pane") => match std::env::args().nth(2) {
            Some(k) if !k.trim().is_empty() => Some(k.trim().to_string()),
            _ => {
                eprintln!("usage: pui hive-pane <key>");
                std::process::exit(2);
            }
        },
        _ => None,
    };
    // Wake-pane scope (owner ask 2026-06-11): bare `wake-pane` = the fleet-wide
    // board; `wake-pane --queen` = the live queen's queue (resolved from the
    // roster each refresh — her owner id isn't known at layout time); `wake-pane
    // <owner-id>` = one explicit agent's queue; `wake-pane --hive <slug>` = one
    // hive's attributed owners (P-014 item 3 — the drill-in tab's wake board,
    // server-filtered via `network.hive.wakes`).
    let wake_filter: app::WakeFilter = match subcommand.as_deref() {
        Some("wake-pane") => match std::env::args().nth(2).as_deref() {
            Some("--queen") => app::WakeFilter::Queen,
            Some("--hive") => match std::env::args().nth(3) {
                Some(h) if !h.trim().is_empty() => app::WakeFilter::Hive(h.trim().to_string()),
                _ => {
                    eprintln!("usage: pui wake-pane --hive <slug>");
                    std::process::exit(2);
                }
            },
            Some(o) if !o.trim().is_empty() => app::WakeFilter::Owner(o.trim().to_string()),
            _ => app::WakeFilter::All,
        },
        // The agent-context panes share the wake-pane's scope grammar; their
        // bare default is the QUEEN (they sit in her dock column).
        Some("prompt-pane") | Some("mail-pane") | Some("work-pane") => {
            match std::env::args().nth(2).as_deref() {
                Some("--queen") | None => app::WakeFilter::Queen,
                Some(o) if !o.trim().is_empty() => app::WakeFilter::Owner(o.trim().to_string()),
                _ => app::WakeFilter::Queen,
            }
        }
        _ => app::WakeFilter::All,
    };
    // The dock-driver drives the reactive agent stack (hive-agent-tabs
    // P-004/D-009): one live `claude --resume` pane per resumable bee + one
    // interactive pane per new local launch, appended to the dock's stack.
    let dock_agent_panes = subcommand.as_deref() == Some("dock-driver");
    // EI-358: only launch-capable modes react to pending workbench launches —
    // the full TUI (no subcommand) and the dock-driver. Board panes
    // (wake/prompt/mail/work/network/hive) must never open launch panes.
    // Races among the capable modes are settled by claim-then-open.
    let reactive_launch_panes = matches!(subcommand.as_deref(), None | Some("dock-driver"));
    // The dock-driver is the only mode with the driver-only surfaces (frame
    // tabs, the regroup repair, the Fleet roster's glyph/badge columns).
    let hive_agent_tabs = subcommand.as_deref() == Some("dock-driver");

    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    // Voice hold-to-talk (voice-mode-tui-port-2026-06-05 D-007): request key
    // RELEASE events when the terminal speaks the kitty keyboard protocol, so
    // holding `v` can drive PTT. Without support no release events arrive and
    // PTT falls back to press-to-toggle. Best-effort; only REPORT_EVENT_TYPES is
    // pushed (minimal — doesn't disambiguate/alter other key reporting).
    let kbd_enhanced = crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false);
    if kbd_enhanced {
        let _ = execute!(
            out,
            crossterm::event::PushKeyboardEnhancementFlags(
                crossterm::event::KeyboardEnhancementFlags::REPORT_EVENT_TYPES
            )
        );
    }
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(
        &mut terminal,
        pinned,
        network_focus,
        wake_filter,
        agent_ctx_mode,
        dock_agent_panes,
        hive_agent_tabs,
        reactive_launch_panes,
    )
    .await;

    // Always restore the terminal, even on error.
    if kbd_enhanced {
        let _ = execute!(
            terminal.backend_mut(),
            crossterm::event::PopKeyboardEnhancementFlags
        );
    }
    disable_raw_mode().ok();
    execute!(terminal.backend_mut(), LeaveAlternateScreen).ok();
    terminal.show_cursor().ok();
    result
}

/// Materialise the workbench layout and hand off to zellij. Replaces this
/// process's foreground with the zellij session; on exit we mirror its code.
/// The session is app-managed (named via `layout::session_name`, EI-186):
/// stale leftovers are reaped before launch, and zellij returning — exit OR
/// detach — ends the workbench, so the session is killed rather than left as
/// a detached server (whose dead-pane PTYs busy-spin).
fn run_workbench() -> Result<()> {
    let session = layout::session_name("wb");
    reap::reap_stale(&session);
    let path = layout::materialize()?;
    let argv = layout::launch_argv(&path.to_string_lossy(), &session);
    let (prog, rest) = argv.split_first().expect("launch argv is never empty");
    let status = std::process::Command::new(prog).args(rest).status()?;
    reap::kill_and_delete(&session);
    std::process::exit(status.code().unwrap_or(0));
}

/// Materialise the chat-only dock (operator chat | brain) and hand off to zellij
/// — the surface the desktop-docked native terminal runs (native-terminal-desktop
/// P-013 / D-011). `psu --brain` was retired on 2026-06-21; the default brain
/// pane is the backend-neutral shared brain view. Override the whole brain
/// command with PAPERCUSP_BRAIN_CMD for local experiments.
async fn run_chat_dock() -> Result<()> {
    let env = std::env::var("PAPERCUSP_BRAIN_CMD").ok();
    let brain_argv = layout::default_brain_argv(env.as_deref());
    // Resolve the active Hive lexicon (pane DISPLAY names) from the operator;
    // unreachable → classic lexicon. (The hive-agent-tabs flag is RETIRED —
    // the live-TUI dock shape is the only shape, so no flag read here.)
    let lex = match OperatorClient::from_discovery().await {
        Ok(c) => match c.lexicon_active_pack().await {
            Ok(pack) => lexicon::Lexicon::from_payload(&pack),
            Err(_) => lexicon::Lexicon::default(),
        },
        Err(_) => lexicon::Lexicon::default(),
    };
    let path = layout::materialize_chat_dock(&brain_argv, &lex)?;
    // SINGLE dock (owner decision 2026-06-25, supersedes per-window-dock 2026-06-17):
    // exactly ONE chat dock exists at a time. Each launch is still its own PID-keyed
    // session (`session_name("dock")`, sized to its window, full interactive TUI), but
    // `reap_stale` now also KILLS every OTHER live `pui-dock-*` on launch — so opening
    // a second desktop window supersedes the first window's dock instead of running a
    // parallel one. WHY: the Sentinel voice-in path keys off a single global
    // `~/.papercusp/sentinel-pane` registration; with several live docks the
    // last-writer-wins, sending voice to a background window's pane. One dock removes
    // that race. (Trade-off vs 2026-06-17: a second window no longer keeps its own
    // dock — acceptable per the single-dock decision.) The queen/overwatch panes stay
    // read-only views of the SHARED BACKEND roster, so dock content is identical
    // regardless of which window owns it. EI-186: reap also clears stale leftovers (the
    // desktop relaunches this dock constantly — each relaunch used to leak a detached
    // server) and kills our own when zellij returns.
    let session = layout::session_name("dock");
    reap::reap_stale(&session);
    let argv = layout::launch_argv(&path.to_string_lossy(), &session);
    let (prog, rest) = argv.split_first().expect("launch argv is never empty");
    let status = std::process::Command::new(prog).args(rest).status()?;
    reap::kill_and_delete(&session);
    std::process::exit(status.code().unwrap_or(0));
}

async fn run<B: Backend>(
    terminal: &mut Terminal<B>,
    pinned: Option<app::Tab>,
    network_focus: Option<String>,
    wake_filter: app::WakeFilter,
    agent_ctx_mode: app::AgentCtxMode,
    dock_agent_panes: bool,
    hive_agent_tabs: bool,
    reactive_launch_panes: bool,
) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let mut app = App::new();
    // Attention pops (transient toast + OS desktop notification) are MUTED by
    // default (owner ask 2026-06-14); `PUI_NOTIFY=1` (or true/on/yes) re-enables
    // them. The Inbox badge + `N` history overlay stay live regardless.
    app.notify_enabled = matches!(
        std::env::var("PUI_NOTIFY").ok().as_deref(),
        Some("1" | "true" | "on" | "yes")
    );
    // Pinned single-tab dock pane (P-013 / D-011): render JUST that tab's body —
    // the renderer short-circuits to it, and the run loop re-pins on each event
    // (below) so a stray nav key can't switch to an unrendered tab.
    app.pinned = pinned;
    if let Some(p) = pinned {
        app.tab = p;
    }
    // hive-pane (B-09/B-10 drill-in): pin the dossier to one C-3 row key.
    app.network_focus = network_focus;
    app.dock_agent_panes = dock_agent_panes;
    app.hive_agent_tabs = hive_agent_tabs;
    app.reactive_launch_panes = reactive_launch_panes;
    // The wake-pane (EI-312): keep the staged-wake board fresh while pinned.
    app.wake_filter = wake_filter.clone();
    if pinned == Some(app::Tab::Wake) {
        tokio::spawn(wake_board_loop(wake_filter.clone(), tx.clone()));
    }
    // The agent-context panes (dock 4-pane split, owner ask 2026-06-11): keep
    // the brief/mail/work board fresh while pinned. The brief is launch-static
    // but the pane still polls — the agent itself can appear/exit.
    app.agent_ctx_mode = agent_ctx_mode;
    if pinned == Some(app::Tab::AgentCtx) {
        tokio::spawn(agent_ctx_loop(agent_ctx_mode, wake_filter, tx.clone()));
    }
    // pui's own zellij pane id = the HUD pane (dockview-workbench D-008). zellij
    // sets `$ZELLIJ_PANE_ID` for every pane it owns; the bare `:float`/`:dock`
    // dock-verbs target this pane. Absent outside zellij (the run loop then uses
    // focused-pane CLI fallbacks).
    app.hud_pane_id = std::env::var("ZELLIJ_PANE_ID")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok());
    // Show the first-run tutorial until this device has dismissed it once (P9).
    app.show_tutorial = !tutorial::seen();
    spawn_input_listener(tx.clone());
    spawn_sync(
        tx.clone(),
        app.active_harness.clone(),
        app.active_doc.clone(),
        app.active_plan.clone(),
        app.network_focus.clone(),
    );
    // Debounced persistence of the quiet view-state (P12 / D-002): the run loop
    // ships a snapshot on each nav change; the saver coalesces a burst + PUTs.
    let (save_tx, save_rx) = mpsc::unbounded_channel::<models::ViewState>();
    tokio::spawn(view_state_saver(save_rx));
    // Agent control surface (P12b / D-002 A6 — tui:dispatch): one task subscribes
    // the intent SSE → Event::TuiIntent (applied in the reducer); a poster ships
    // each result back. pui never polls — it holds the one SSE connection.
    let (intent_result_tx, intent_result_rx) =
        mpsc::unbounded_channel::<(i64, String, Option<String>)>();
    tokio::spawn(intent_result_poster(intent_result_rx));
    tokio::spawn(tui_intent_loop(tx.clone()));
    // Operator chat pane (tui-operator-surface-2026-06-04): load the workspace's
    // operator conversation on open so the transcript is seeded from the same
    // thread the desktop surface shares.
    tokio::spawn(chat_load_history(tx.clone()));
    // Inline cards (sentinel-tui-shared-backend-and-cards-2026-06-22 Phase 2a):
    // subscribe the state-channel snapshot SSE so open `chat:ask_choice` cards
    // render inline in the operator pane (and resolve the active workspace once
    // for the `/card-response` defense-in-depth gate).
    tokio::spawn(card_snapshot_loop(tx.clone()));
    // Companion zellij plugin (P-004 / D-008): `pui`'s eyes + hands inside
    // zellij over a long-lived `zellij pipe` child. `None` when not running
    // inside zellij / without the plugin — orchestration then falls back to
    // fire-and-forget `zellij action` (below). Its events (topology, pane-exit)
    // arrive on `tx` like any other. NOT spawned in the dock modes (P-013 /
    // pui-dock-agent-stack): there is no work area to orchestrate there, and
    // loading the plugin surfaces an empty floating pane over the dock.
    let companion = if pinned.is_some() {
        None
    } else {
        Companion::spawn(tx.clone())
    };

    // Hive lexicon (pui-hive-lexicon-2026-06-06): fetch the ACTIVE resolved term
    // pack once at startup so user-facing labels (tab titles, dock pane names)
    // route through the SAME server-twin source as the desktop — flag flips
    // respected. Fail-soft: an unreachable operator leaves the classic fallback.
    tokio::spawn(lexicon_fetch(tx.clone()));

    // Bee dossier (pui-dock-consolidation-2026-06-07): the dossier renders
    // INSIDE the Fleet tab now, driven in-process by the roster cursor (see the
    // Action::PublishBeeSelection arm) — the old relay-polling pane loop is
    // gone. The relay POST itself stays for external consumers.

    // Voice mode (voice-mode-tui-port-2026-06-05 P2): the run loop owns the
    // audio handles — the long-lived playback `Player` and the in-flight mic
    // `CaptureSession` — so `App` stays pure/testable (the cpal/rodio objects
    // never enter app state). The PTT pipeline is driven from the `Action::Voice`
    // arm + a Tick-driven mic-meter pump.
    let voice_player = voice::Player::spawn();
    let mut voice_capture: Option<voice::CaptureSession> = None;
    // Realtime operator voice (voice-realtime-tui-2026-06-05): the run loop
    // owns the session handle too. A handle whose task already ended is inert
    // (stop() goes nowhere), so Start always replaces.
    let mut convai_session: Option<voice_convai::ConvAiHandle> = None;
    // P2P voice channels (holepunch-voice-channels P-008): the run loop owns the
    // long-lived voice socket (an Arc so the cpal capture callback can hold it)
    // and the in-flight mic-capture handle (dropping it stops transmitting).
    let mut voice_chan: Option<std::sync::Arc<voice_stream::VoiceStream>> = None;
    let mut voice_mic: Option<voice_stream::MicHandle> = None;
    // Open-mic (P-010): auto-start the mic once per channel join when
    // input_mode=open-mic, so it isn't restarted after a manual MicOff.
    let mut open_mic_started = false;

    terminal.draw(|f| ui::draw(f, &app))?;

    // Tracks the last notification we surfaced to the OS so we fire exactly one
    // system notification per new event (the reducer bumps notif_seq).
    let mut last_notif_seq = app.notif_seq;
    // Persist the tutorial dismissal exactly once, the first time it closes.
    let mut tutorial_persisted = !app.show_tutorial;

    while let Some(ev) = rx.recv().await {
        let is_key = matches!(ev, Event::Key(_));
        let is_tick = matches!(ev, Event::Tick);
        // The operator voice socket dropped (P-013 reconnect-on-drop): detect it
        // before the reducer consumes the event so we can free the run-loop-owned
        // handles below.
        let voice_dropped = matches!(
            &ev,
            Event::VoiceUi(crate::voice_ui::VoiceUiEvent::Stream(
                voice_stream::VoiceEvent::Disconnected
            ))
        );
        // Plans-board initial/refresh detail load (pui-plans-status-board P-008):
        // when the plans list (re)arrives while the board is pinned, deterministically
        // fetch the selected plan's item states for the right-side work-items
        // detail — the active-plan poller is racy for the FIRST load (the cell is
        // published by THIS event, after refetch_all already read it).
        let plans_arrived = matches!(&ev, Event::Plans(_));
        let action = app.update(ev);
        if plans_arrived && app.pinned == Some(app::Tab::PlansBoard) {
            if let Some((harness, plan)) = app.selected_board_plan() {
                tokio::spawn(fetch_plan_item_states(harness, plan, tx.clone()));
            }
        }

        // Pinned dock pane (P-013 / D-011): never leave the pinned tab — re-pin
        // so a stray nav key can't switch to an unrendered tab (which on the
        // chat pane would also strand the composer: `i` composes on Operator).
        if let Some(p) = app.pinned {
            if app.tab != p {
                app.tab = p;
            }
        }
        // Per-bee wake-pane lifecycle (owner ask 2026-06-11): an Owner-scoped
        // wake-pane exits once its bee is gone AND its queue is drained — the
        // pane was opened close-on-exit, so it leaves the dock stack on its own.
        if app.wake_pane_should_exit() {
            break;
        }

        if voice_dropped {
            // Release the now-dead stream + mic so the next Connect re-establishes
            // a fresh socket. The reducer already flipped the Voice tab to
            // disconnected + surfaced the drop; clearing these run-loop handles is
            // what actually re-enables reconnection (Connect gates on is_none()).
            voice_chan = None;
            voice_mic = None;
            open_mic_started = false;
        }

        // Open-mic (P-010): once we're in a channel with input_mode=open-mic,
        // auto-start the mic (no PTT) with the VAD transmit-gate on. Fires once
        // per join (open_mic_started) so a manual MicOff isn't fought.
        if !open_mic_started && voice_mic.is_none() {
            let open_mic = app
                .voice_ui
                .prefs
                .as_ref()
                .map(|p| p.input_mode == "open-mic")
                .unwrap_or(false);
            let in_channel = app
                .voice_ui
                .status
                .as_ref()
                .map(|st| st.channel.is_some())
                .unwrap_or(false);
            if open_mic && in_channel {
                if let Some(vs) = &voice_chan {
                    match voice_stream::start_mic(vs.clone()) {
                        Ok(h) => {
                            vs.set_tx_gate(true);
                            voice_mic = Some(h);
                            open_mic_started = true;
                            let _ = tx.send(Event::VoiceUi(
                                crate::voice_ui::VoiceUiEvent::MicState(true),
                            ));
                        }
                        Err(e) => {
                            let _ = tx.send(Event::VoiceUi(crate::voice_ui::VoiceUiEvent::Error(
                                format!("open-mic: {e}"),
                            )));
                            open_mic_started = true; // don't retry-spam on failure
                        }
                    }
                }
            }
        }

        // Pump the live mic meter while recording: read the capture level on each
        // idle Tick and repaint so the meter animates (no per-frame event spam —
        // the level is an atomic the audio callback writes; plan D-007).
        if is_tick {
            if let Some(cap) = &voice_capture {
                app.set_voice_level(cap.level());
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            // P2P voice-channel mic meter (P-008): same atomic-on-Tick pump as
            // the PTT meter — no per-frame event spam.
            if voice_mic.is_some() {
                if let Some(vs) = &voice_chan {
                    app.voice_ui.mic_level = vs.mic_level();
                    terminal.draw(|f| ui::draw(f, &app))?;
                }
            }
        }

        // Persist the quiet view-state on each nav change (the saver debounces).
        // Workbench dispatches count too: `:theme` flips state the snapshot
        // carries (P1 / D-002), and saving nav state on the other palette
        // commands is an idempotent no-op.
        if is_key && matches!(action, Action::Render | Action::Workbench(_)) {
            let _ = save_tx.send(app.capture_view_state());
        }

        // Best-effort OS notification on each new attention event (P8). Gated on
        // notify_enabled (muted by default, owner ask 2026-06-14) — the badge +
        // history surfaces still update via the reducer regardless.
        if app.notif_seq != last_notif_seq {
            last_notif_seq = app.notif_seq;
            if app.notify_enabled {
                if let Some(t) = app.toast.clone() {
                    notify::os_notify("Papercusp", &t.message);
                }
            }
        }

        // Record the first-run tutorial as seen the moment it's dismissed (P9).
        if !tutorial_persisted && !app.show_tutorial {
            tutorial_persisted = true;
            tutorial::mark_seen();
        }

        match action {
            Action::Render => {
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::PublishBeeSelection { owner_id, name } => {
                // In-process selection drive (pui-dock-consolidation-2026-06-07):
                // the dossier renders inside the Fleet tab now — apply the
                // selection to app state and fetch the bee's dossier directly.
                // The relay POST stays for external consumers.
                let changed = app.bee.owner_id != owner_id;
                app.update(Event::BeeSelection {
                    owner_id: owner_id.clone(),
                    name: name.clone(),
                });
                if changed {
                    if let Some(o) = owner_id.clone() {
                        tokio::spawn(bee_dossier_fetch(o, tx.clone()));
                    }
                }
                tokio::spawn(publish_bee_selection(owner_id, name, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchFleetAssignments => {
                // Whole-fleet task list for the default Swarm dossier (#2) —
                // fetched off the UI thread → Event::FleetAssignments.
                tokio::spawn(fetch_fleet_assignments(tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::SetWakeMode { agent, mode } => {
                // P-008: set the agent's wake mode via coord:wake-mode (run_tool).
                // Best-effort; the next roster poll refreshes the ⏸MANUAL badge.
                tokio::spawn(set_wake_mode(agent, mode, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchWakeQueue { agent } => {
                // P-009: list the agent's staged wakes for the review overlay.
                tokio::spawn(fetch_wake_queue(agent, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::WakeQueueAct {
                agent,
                release,
                id,
                edited,
            } => {
                // P-009: release (as-is or edited) / skip one staged wake, then
                // re-list so the overlay refreshes.
                tokio::spawn(wake_queue_act(agent, release, id, edited, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchWakeBoard => {
                // EI-312: re-snapshot the staged-wake board (this pane's scope).
                tokio::spawn(fetch_wake_board(app.wake_filter.clone(), tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::WakeBoardAct {
                agent,
                verb,
                id,
                edited,
            } => {
                // EI-312: act on the board (release/skip one, or drain all),
                // then re-snapshot so the pane refreshes.
                tokio::spawn(wake_board_act(
                    agent,
                    verb,
                    id,
                    edited,
                    app.wake_filter.clone(),
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::CreateFrameTabs { tabs } => {
                // P-013: one zellij tab per deployed frame, created via the
                // companion's NewTab (new_tabs_with_layout). The reducer's diff
                // is topology-gated, so tabs are only ever offered while a
                // companion is linked; the None arm is a defensive no-op.
                if let Some(c) = &companion {
                    for (name, layout) in tabs {
                        c.send(pui_companion_proto::Command::NewTab {
                            name: Some(name),
                            layout: Some(layout),
                        });
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::CreateHiveTabs { tabs } => {
                // B4 (P-004): one persistent zellij tab per live federated peer,
                // created via the companion's NewTab — same path + linked-companion
                // gating as the per-frame tabs (the reducer's diff is roster-gated).
                if let Some(c) = &companion {
                    for (name, layout) in tabs {
                        c.send(pui_companion_proto::Command::NewTab {
                            name: Some(name),
                            layout: Some(layout),
                        });
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchHives => {
                // The federated p2p roster for the Hives tab — fetched off the
                // UI thread → Event::Hives (pui-hives-tab-2026-06-07). Also kick
                // the P2P directory fetch (p2p-hive-directory P-006) so entering
                // the tab populates both the live roster + the browseable hives.
                tokio::spawn(fetch_hives(tx.clone()));
                tokio::spawn(fetch_hive_directory(tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchPlansBoard => {
                // pui-plans-status-board: the plans-pane's manual `g` refresh.
                // The standard refetch loop already feeds plans + roster
                // push-driven (SSE + 60s safety net); this forces an immediate
                // re-pull so the board updates the instant the owner asks.
                tokio::spawn(fetch_plans_board(tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchPlanItemStates { harness, plan } => {
                // pui-plans-status-board P-008: the plans board's selection
                // moved — fetch the selected plan's per-item states for the
                // right-side work-items detail. → Event::PlanItemStates.
                tokio::spawn(fetch_plan_item_states(harness, plan, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchNetworkBoard => {
                // B-09: the network-pane's manual `g` refresh — the refetch
                // loop covers the push-driven cadence (SSE + 60s safety net).
                // A pinned hive-pane also re-pulls its drill-in dossier
                // (beacon history + ask log, P-014 item 2).
                tokio::spawn(fetch_network_board(tx.clone()));
                if let Some(key) = &app.network_focus {
                    tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::OpenNetworkDrillIn(req) => {
                // B-10 SEAM: the per-hive drill-in open action (hive-network-
                // surface B-09→B-10, coord 2026-06-11). Tier 1 is the local
                // hive — its "drill-in" is the dock's `this hive` tab (always
                // the FIRST tab, agreed with B-10). Tiers 2-4 open B-10's
                // generated per-hive tab (hive-pane detail; tier 2 adds the
                // hive-scoped wake board; the per-bee watch panes were dropped
                // when hive-agent-tabs P-014 retired the watch-pane surface).
                // The KDL goes through a materialized file + the zellij CLI
                // because the companion is NEVER spawned in pinned panes
                // (Companion::spawn gating above) — `Command::NewTab` over
                // the companion can't fire from the pinned network-pane.
                if req.tier <= 1 {
                    let _ = Zellij.run_action(&MuxAction::GoToTab(1));
                } else {
                    let spec = layout::HiveTabSpec {
                        tier: req.tier,
                        key: req.key.clone(),
                        title: req.title.clone(),
                    };
                    match materialize_hive_tab(&spec) {
                        Ok(path) => {
                            let _ = Zellij.run_action(&MuxAction::NewTab {
                                name: Some(layout::hive_tab_name(&spec)),
                                layout: Some(path.to_string_lossy().into_owned()),
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(Event::Error(format!("hive tab: {e}")));
                        }
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::JoinHive { slug, links } => {
                // Join every member harness of a discovered hive (P-006): POST each
                // link to /api/harness/join-link off the UI thread → Notify/Error.
                tokio::spawn(join_hive(slug, links, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::DocsAction { action, doc_id } => {
                // Fire the docs action (regenerate|verify) off the UI thread; the
                // periodic refetch loop refreshes the badges on its next tick
                // (harness-docs-integration P-009).
                tokio::spawn(apply_docs_action(
                    app.harness.clone(),
                    action,
                    doc_id,
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Launch(spec) => {
                // Record the launch into the crew roster (P12b) before spawning.
                app.record_launch(&spec);
                // Prefer the companion plugin's real host command (reliable +
                // observable — its CommandPaneExited feeds pane-exit detection);
                // fall back to fire-and-forget `zellij action new-pane` when no
                // companion is linked.
                match &companion {
                    Some(c) => c.open_pane(&spec),
                    None => {
                        if let Err(e) = Zellij.open_pane(&spec) {
                            app.update(Event::Error(format!("launch: {e}")));
                        }
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::LaunchPanes { sessions, bees } => {
                // Reactive work-area panes for new LOCAL workbench launches
                // (pui-reactive-session-panes D-006). EI-358 CLAIM-THEN-OPEN:
                // mark-launched is the ATOMIC claim (`launched_at IS NULL` —
                // stamped=true for exactly one caller across EVERY pui process),
                // so we claim FIRST and open only on a won claim. The old order
                // (open, then fire-and-forget mark) let every roster-watching
                // pui process open its own pane for one click — the owner got
                // five planner chats. A lost claim = another instance owns the
                // launch (skip forever, stays tracked); a transport error is
                // RETRYABLE (un-track via LaunchClaimRetry so a later roster
                // tick re-attempts — the row is still pending server-side).
                for p in sessions {
                    let claim = match OperatorClient::from_discovery().await {
                        Ok(c) => c.mark_session_launched(p.adv_session_id).await,
                        Err(e) => Err(e),
                    };
                    match claim {
                        Ok(true) => { /* won — open below */ }
                        Ok(false) => continue,
                        Err(_) => {
                            app.update(Event::LaunchClaimRetry(p.adv_session_id));
                            continue;
                        }
                    }
                    match &companion {
                        Some(c) => c.open_pane(&p.spec),
                        None => {
                            if let Err(e) = Zellij.open_pane(&p.spec) {
                                app.update(Event::Error(format!("launch pane: {e}")));
                            }
                        }
                    }
                }
                // Dock agent stack (hive-agent-tabs P-004): live `claude
                // --resume` panes for active fleet bees — CLI only (no
                // companion in the dock, nothing to mark consumed).
                let opened_bees = bees.len();
                for spec in bees {
                    if let Err(e) = Zellij.open_pane(&spec) {
                        app.update(Event::Error(format!("bee pane: {e}")));
                    }
                }
                // Snap focus BACK to this pane (the operator chat) after a dock
                // pane burst: zellij expands + focuses every new stacked pane as
                // it opens, so a launch-time burst of bee panes flips the dock
                // around for seconds and strands focus on the last bee (owner
                // report 2026-06-07 "keeps refreshing like crazy ... before it
                // settles"). One focus-restore per batch ends the flip on the
                // chat. Workbench (companion) launches keep their own focus
                // semantics — this is the dock-CLI path only.
                if app.dock_agent_panes && opened_bees > 0 {
                    if let Some(id) = app.hud_pane_id {
                        if let Err(e) = Zellij.run_action(&crate::mux::MuxAction::FocusPaneId(id)) {
                            app.update(Event::Error(format!("focus restore: {e}")));
                        }
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::IntentResult {
                id,
                result_json,
                error,
            } => {
                // An agent intent was applied (P12b) — ship the result back, redraw.
                let _ = intent_result_tx.send((id, result_json, error));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Workbench(cmd) => {
                // Execute a palette workbench command (P12b) off the UI thread; it
                // reports results back as toasts. SaveCrew needs the current crew
                // roster, so it's snapshotted here from App.
                tokio::spawn(execute_workbench_command(
                    cmd,
                    app.launched.clone(),
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Dock(cmd) => {
                // Dockview dock-verbs (Brief 50 / D-008). Prefer the companion
                // (id-addressed, reliable inside zellij); fall back to focused-
                // pane / cycle `zellij action` CLI verbs when no companion is
                // linked. The reducer already resolved ids/preset names + emitted
                // a friendly error for the cases a fallback can't cover.
                match cmd {
                    DockCmd::Stack { pane_ids } => match &companion {
                        // :stack is id-addressed → companion-only (the reducer
                        // already error-toasted when there was no topology).
                        Some(c) => c.stack_panes(pane_ids),
                        None => {
                            app.update(Event::Error(
                                "stack: needs the companion plugin (run inside the workbench)"
                                    .into(),
                            ));
                        }
                    },
                    DockCmd::Float { pane_id } => match (&companion, pane_id) {
                        (Some(c), Some(id)) => c.toggle_float(id),
                        // Bare :float with a known HUD id → float that pane.
                        (Some(c), None) if app.hud_pane_id.is_some() => {
                            c.toggle_float(app.hud_pane_id.unwrap())
                        }
                        // Bare :float without a HUD id, or no companion: the
                        // focused pane in the palette IS the HUD, so the CLI
                        // focused-pane toggle floats it (D-002).
                        _ => {
                            if let Err(e) = Zellij.run_action(&MuxAction::ToggleFloat) {
                                app.update(Event::Error(format!("float: {e}")));
                            }
                        }
                    },
                    DockCmd::SelectLayout { name } => match &companion {
                        Some(c) => c.select_swap_layout(name),
                        // No companion → no select-by-name primitive; :dock needs
                        // it. Tell the user (cycling can't reliably hit a target).
                        None => {
                            app.update(Event::Error(format!(
                                "dock/layout {name}: needs the companion plugin (use :layout next/prev without it)"
                            )));
                        }
                    },
                    DockCmd::CycleLayout { next } => match &companion {
                        Some(c) => {
                            if next {
                                c.next_swap_layout()
                            } else {
                                c.prev_swap_layout()
                            }
                        }
                        None => {
                            let act = if next {
                                MuxAction::NextSwapLayout
                            } else {
                                MuxAction::PrevSwapLayout
                            };
                            if let Err(e) = Zellij.run_action(&act) {
                                app.update(Event::Error(format!("layout: {e}")));
                            }
                        }
                    },
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::SendChat(text) => {
                // Operator chat turn (tui-operator-surface P1). The reducer already
                // appended the user message + a streaming bubble; spawn the converse
                // task with a snapshot of the transcript + conversation id.
                tokio::spawn(converse_send(
                    text,
                    app.conversation_id.clone(),
                    app.chat_history_for_send(),
                    workbench::workbench_owner(),
                    None, // typed turn — no spoken reply
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::CardRespond {
                correlation_id,
                workspace_id,
                action,
                payload,
            } => {
                // Inline card answer (sentinel-tui-shared-backend-and-cards Phase
                // 2a): POST /card-response so the server resolves the brain's
                // blocked tool call. The reducer already optimistically dismissed
                // the card; a fresh state-snapshot is the authoritative removal.
                // Prefer the card's OWN workspace (wire snapshot) over the
                // loop-resolved one for the defense-in-depth gate.
                let ws = workspace_id.or_else(|| app.card_workspace.clone());
                tokio::spawn(card_respond_send(
                    app.conversation_id.clone(),
                    correlation_id,
                    ws,
                    action,
                    payload,
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::SetMaxAgents(n) => {
                // Overview top-bar cap edit (Brief 23 P-005): PUT the new
                // `maxSimultaneousAgents` then refetch the read-model so the
                // optimistic local value reconciles with truth.
                tokio::spawn(set_max_agents(n, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::VoiceSessionStart => {
                // Realtime operator voice (voice-realtime-tui P-007): replace
                // any prior (possibly already-ended) session outright.
                if let Some(h) = convai_session.take() {
                    h.stop();
                }
                convai_session = Some(voice_convai::start_session(
                    workbench::workbench_owner(),
                    voice_player.clone(),
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::VoiceSessionStop => {
                if let Some(h) = convai_session.take() {
                    h.stop();
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::VoiceChan(cmd) => {
                use crate::voice_ui::{VoiceCmd as VC, VoiceUiEvent as VE};
                match cmd {
                    VC::Connect => {
                        if voice_chan.is_none() {
                            match voice_stream::VoiceStream::connect() {
                                Ok((vs, ev_rx, mix_rx)) => {
                                    let vs = std::sync::Arc::new(vs);
                                    voice_chan = Some(vs.clone());
                                    // Forward socket events (status/error/disconnect)
                                    // onto the run-loop event channel.
                                    let tx2 = tx.clone();
                                    std::thread::spawn(move || {
                                        while let Ok(ev) = ev_rx.recv() {
                                            if tx2.send(Event::VoiceUi(VE::Stream(ev))).is_err() {
                                                break;
                                            }
                                        }
                                    });
                                    // Mixed peer audio → local playback.
                                    if let Err(e) = voice_stream::start_playback(mix_rx) {
                                        let _ = tx.send(Event::VoiceUi(VE::Error(format!(
                                            "voice playback: {e}"
                                        ))));
                                    }
                                    let _ = vs.request_status();
                                    let _ = tx.send(Event::VoiceUi(VE::Connected(true)));
                                }
                                Err(e) => {
                                    let _ = tx.send(Event::VoiceUi(VE::Error(e.to_string())));
                                }
                            }
                        } else if let Some(vs) = &voice_chan {
                            let _ = vs.request_status();
                        }
                        // (Re)fetch the channel registry + voice prefs over HTTP
                        // (prefs drive the open-mic auto-start; P-010).
                        tokio::spawn(voice_channels_fetch(tx.clone()));
                        tokio::spawn(voice_prefs_get(tx.clone()));
                        terminal.draw(|f| ui::draw(f, &app))?;
                    }
                    VC::Join(id) => {
                        if let Some(vs) = &voice_chan {
                            let _ = vs.join(&id);
                        }
                    }
                    VC::Leave => {
                        if let Some(vs) = &voice_chan {
                            let _ = vs.leave();
                        }
                        voice_mic = None;
                        open_mic_started = false; // re-arm open-mic for the next join
                        let _ = tx.send(Event::VoiceUi(VE::MicState(false)));
                    }
                    VC::SetMuted(m) => {
                        if let Some(vs) = &voice_chan {
                            let _ = vs.set_muted(m);
                        }
                    }
                    VC::MicOn => match &voice_chan {
                        Some(vs) => match voice_stream::start_mic(vs.clone()) {
                            Ok(h) => {
                                // PTT → gate off (the held key IS the gate);
                                // open-mic manual restart → VAD gate on (P-010).
                                let open_mic = app
                                    .voice_ui
                                    .prefs
                                    .as_ref()
                                    .map(|p| p.input_mode == "open-mic")
                                    .unwrap_or(false);
                                vs.set_tx_gate(open_mic);
                                voice_mic = Some(h);
                                let _ = tx.send(Event::VoiceUi(VE::MicState(true)));
                            }
                            Err(e) => {
                                let _ = tx.send(Event::VoiceUi(VE::Error(format!("mic: {e}"))));
                            }
                        },
                        None => {}
                    },

                    VC::MicOff => {
                        voice_mic = None;
                        // User explicitly stopped — don't let open-mic auto-start
                        // immediately re-arm it (P-010 restart-fight guard).
                        open_mic_started = true;
                        let _ = tx.send(Event::VoiceUi(VE::MicState(false)));
                    }
                    VC::Create(name) => {
                        tokio::spawn(voice_channel_create(name, tx.clone()));
                    }
                    VC::PrefsGet => {
                        tokio::spawn(voice_prefs_get(tx.clone()));
                    }
                    VC::PrefsSet(key, value) => {
                        tokio::spawn(voice_prefs_set(key.to_string(), value, tx.clone()));
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FocusPane { intent_id, pane_id } => {
                // Operator pane-driving affordance (P2): drive the companion to
                // focus the pane, then POST the intent result back.
                let (result_json, error) = match &companion {
                    Some(c) => {
                        c.focus_pane(pane_id);
                        (format!("{{\"ok\":true,\"pane_id\":{pane_id}}}"), None)
                    }
                    None => (
                        "null".to_string(),
                        Some(
                            "focus_pane: no companion link (pui is not inside a zellij workbench)"
                                .to_string(),
                        ),
                    ),
                };
                let _ = intent_result_tx.send((intent_id, result_json, error));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FocusLocalPane { pane_id } => {
                // Enter-by-location LOCAL route (pui-workbench-usability D-001):
                // bring the selected agent's workbench pane to front. Companion-
                // only (id-addressed); without a link, tell the user.
                match &companion {
                    Some(c) => c.focus_pane(pane_id),
                    None => {
                        app.update(Event::Error(
                            "focus: needs the companion plugin (run inside the workbench)".into(),
                        ));
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FocusWindow {
                adv_session_id,
                pid,
                window_id,
                label,
            } => {
                // Enter-by-location EXTERNAL-WINDOW route (D-001): wmctrl the
                // agent's terminal window to the front off the UI thread; the
                // outcome returns as a toast (Event::Notify/Error).
                tokio::spawn(focus_session_window(
                    adv_session_id,
                    pid,
                    window_id,
                    label,
                    tx.clone(),
                ));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::LoadEarlierChat => {
                // Load-earlier history (scroll-back). The reducer set the in-flight
                // flag; spawn the fetch with a snapshot of the conversation id +
                // oldest cursor. A missing cursor/conversation just clears the flag.
                match (app.conversation_id.clone(), app.chat_oldest_seq) {
                    (Some(conv_id), Some(before_seq)) => {
                        tokio::spawn(load_earlier_chat(conv_id, before_seq, tx.clone()));
                    }
                    _ => {
                        let _ = tx.send(Event::ChatEarlier {
                            messages: Vec::new(),
                            has_more_earlier: false,
                            oldest_seq: None,
                        });
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchTestingFiles { harness, domain_id } => {
                // Testing run-on-click (D-004a): resolve the selected domain's
                // runnable files off the UI thread.
                tokio::spawn(fetch_testing_files(harness, domain_id, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::RunTest { harness, file } => {
                // The backend run is synchronous (up to ~120s); awaiting it in a
                // task keeps the UI live while the run pane shows "running…".
                tokio::spawn(run_test_file(harness, file, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::SearchMemory { query, harness } => {
                // Memory semantic search (D-006 Step 2) off the UI thread.
                tokio::spawn(search_memory(query, harness, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::ConfigEdit {
                harness,
                key,
                value,
            } => {
                // Config-tab edit (D-013): read→edit→PUT→refetch off the UI
                // thread; the refreshed effective view returns as Event::Config.
                tokio::spawn(config_edit(harness, key, value, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::LoadPluginConfig { harness, plugin } => {
                // Plugin-settings load (D-014): fetch the selected plugin's saved
                // per-harness config; returns as Event::PluginConfig.
                tokio::spawn(load_plugin_config(harness, plugin, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::PluginConfigEdit {
                harness,
                plugin,
                key,
                value,
            } => {
                // Plugin-settings edit (D-014): read→edit-path→PUT→refetch off
                // the UI thread; the refreshed config returns as Event::PluginConfig.
                tokio::spawn(plugin_config_edit(harness, plugin, key, value, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchCupboard { kind, query } => {
                // Cupboard browse (D-011): GET the listings for the active
                // (kind, query) filter off the UI thread.
                tokio::spawn(fetch_cupboard(kind, query, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::CupboardAct { listing } => {
                // A confirmed per-kind Cupboard action (D-011): join / fork /
                // install. Outcomes ride Notify/Error events.
                tokio::spawn(cupboard_act(listing, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchConversations { state, kind } => {
                // Conversations browse (Brief 25): GET the list for the active
                // state/kind filter off the UI thread → Event::Conversations.
                tokio::spawn(fetch_conversations(state, kind, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::FetchConversationDetail { id } => {
                // Load the selected conversation's full thread → ConversationDetail.
                tokio::spawn(fetch_conversation_detail(id, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::PromoteConversation { id } => {
                // Promote a conversation → engineer issue (carries the thread);
                // outcome rides Notify/Error + a list/detail refetch.
                tokio::spawn(promote_conversation(id, tx.clone()));
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Voice(cmd) => {
                // Push-to-talk lifecycle (voice-mode-tui-port-2026-06-05 P2).
                // The run loop owns the mic CaptureSession; the turn pipeline
                // (transcribe → converse → speak) runs in a spawned task and
                // feeds Event::Voice / Chat* events back.
                use app::VoiceCmd;
                match cmd {
                    VoiceCmd::Start => match voice::start_capture() {
                        Ok(session) => {
                            voice_capture = Some(session);
                            let _ = tx.send(Event::Voice(event::VoiceMsg::Started(Ok(()))));
                        }
                        Err(e) => {
                            let _ =
                                tx.send(Event::Voice(event::VoiceMsg::Started(Err(e.to_string()))));
                        }
                    },
                    VoiceCmd::Cancel => {
                        if let Some(session) = voice_capture.take() {
                            tokio::task::spawn_blocking(move || session.cancel());
                        }
                        let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
                    }
                    VoiceCmd::Stop => {
                        if let Some(session) = voice_capture.take() {
                            // Reflect the transcribing phase immediately, then run
                            // the turn with a snapshot of the converse context
                            // (the pipeline appends the transcribed text itself).
                            app.voice_phase = app::VoicePhase::Transcribing;
                            tokio::spawn(voice_turn(
                                session,
                                app.conversation_id.clone(),
                                app.chat_history_for_send(),
                                workbench::workbench_owner(),
                                voice_player.clone(),
                                tx.clone(),
                            ));
                        } else {
                            let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
                        }
                    }
                }
                terminal.draw(|f| ui::draw(f, &app))?;
            }
            Action::Quit => break,
            Action::None => {}
        }
    }
    Ok(())
}

/// Fetch the selected testing domain's runnable files (D-004a) and emit
/// `Event::TestingFiles` (stale-guarded in the reducer by domain id). On error
/// an empty file list still ships so the loading state resolves; the error
/// itself lands in the status bar.
async fn fetch_testing_files(harness: String, domain_id: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing files: {e}")));
            let _ = tx.send(Event::TestingFiles {
                domain_id,
                files: Vec::new(),
            });
            return;
        }
    };
    match client.testing_domain_files(&harness, &domain_id).await {
        Ok(files) => {
            let _ = tx.send(Event::TestingFiles { domain_id, files });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing files: {e}")));
            let _ = tx.send(Event::TestingFiles {
                domain_id,
                files: Vec::new(),
            });
        }
    }
}

/// Fire a pui docs action (regenerate|verify) for the selected doc
/// (harness-docs-integration P-009). Success is silent — the periodic refetch loop
/// refreshes the source/freshness badges within a tick; failures surface as a
/// status-bar toast so the keypress never silently no-ops.
async fn apply_docs_action(
    harness: String,
    action: String,
    doc_id: String,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("docs {action}: {e}")));
            return;
        }
    };
    if let Err(e) = client.docs_action(&harness, &action, &doc_id).await {
        let _ = tx.send(Event::Error(format!("docs {action}: {e}")));
    }
}

/// Semantic memory search (D-006 Step 2): call `memory:search` and emit
/// `Event::MemoryHits` for the query (the reducer drops hits for a query that
/// is no longer active). Errors resolve to an empty hit list + a status-bar
/// error so the search never hangs.
async fn search_memory(query: String, harness: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("memory search: {e}")));
            let _ = tx.send(Event::MemoryHits {
                query,
                results: Vec::new(),
            });
            return;
        }
    };
    match client.memory_search(&query, Some(&harness), 20).await {
        Ok(payload) => {
            let _ = tx.send(Event::MemoryHits {
                query,
                results: payload.results,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("memory search: {e}")));
            let _ = tx.send(Event::MemoryHits {
                query,
                results: Vec::new(),
            });
        }
    }
}

/// Overview top-bar cap edit (Brief 23 P-005): PUT the new
/// `maxSimultaneousAgents`, then refetch the fleet-rate read-model so the
/// reducer's optimistic value reconciles with what the backend persisted. A
/// failed PUT surfaces in the status bar; the refetch (or the next poll)
/// restores truth either way.
async fn set_max_agents(n: u32, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("max agents: {e}")));
            return;
        }
    };
    if let Err(e) = client.set_max_agents(n).await {
        let _ = tx.send(Event::Error(format!("max agents: {e}")));
    }
    if let Ok(s) = client.fleet_rate_status().await {
        let _ = tx.send(Event::FleetRate(s));
    }
}

// (mark_session_launched moved inline into the LaunchPanes arm — EI-358
// claim-then-open: the claim verdict now GATES the pane open, so it can no
// longer be a fire-and-forget task.)

/// Bring the selected agent's terminal window to the front via
/// `/api/adv/sessions/focus` (wmctrl). Best-effort — a resolved window toasts
/// success; an unresolvable one (no wmctrl/DISPLAY/window, or a remote host)
/// toasts a friendly "couldn't bring … to front" rather than failing silently.
async fn focus_session_window(
    adv_session_id: Option<i64>,
    pid: Option<i64>,
    window_id: Option<String>,
    label: String,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("focus window: {e}")));
            return;
        }
    };
    match client.focus_session(adv_session_id, pid, window_id).await {
        Ok(true) => {
            let _ = tx.send(Event::Notify(models::Notif {
                level: "info".to_string(),
                message: format!("focused {label}"),
                harness: None,
                ts: None,
            }));
        }
        Ok(false) => {
            let _ = tx.send(Event::Error(format!(
                "couldn't bring {label} to front (no window — try resume/launch)"
            )));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("focus window: {e}")));
        }
    }
}

// ─── P2P voice channels (holepunch-voice-channels P-008) ───
// HTTP-side helpers: the channel REGISTRY + voice-prefs ride agent-tools (not
// realtime); join/leave/mute + audio ride the voice socket in the run loop.

async fn voice_channels_fetch(tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice channels: {e}"))));
            return;
        }
    };
    match client.voice_channels_list().await {
        Ok(list) => {
            let _ = tx.send(Event::VoiceUi(VE::Channels(list)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice channels: {e}"))));
        }
    }
}

async fn voice_channel_create(name: String, tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("create channel: {e}"))));
            return;
        }
    };
    match client.voice_channel_create(&name).await {
        Ok(list) => {
            let _ = tx.send(Event::VoiceUi(VE::Channels(list)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("create channel: {e}"))));
        }
    }
}

async fn voice_prefs_get(tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
            return;
        }
    };
    match client.voice_prefs_get().await {
        Ok(p) => {
            let _ = tx.send(Event::VoiceUi(VE::Prefs(p)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
        }
    }
}

async fn voice_prefs_set(key: String, value: serde_json::Value, tx: UnboundedSender<Event>) {
    use crate::voice_ui::VoiceUiEvent as VE;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
            return;
        }
    };
    match client.voice_prefs_set(&key, value).await {
        Ok(p) => {
            let _ = tx.send(Event::VoiceUi(VE::Prefs(p)));
        }
        Err(e) => {
            let _ = tx.send(Event::VoiceUi(VE::Error(format!("voice prefs: {e}"))));
        }
    }
}

/// Apply one `:set`/`:unset` Config-tab edit (D-013): fetch the current file
/// body, edit the dotted path (`value: Some` sets, `None` removes), PUT the
/// result back, then refetch the effective view so the tab re-renders from
/// what the backend actually persisted. Every failure lands in the status bar
/// and the view is refetched anyway (so the tab never shows a phantom edit).
async fn config_edit(
    harness: String,
    key: String,
    value: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config edit: {e}")));
            return;
        }
    };
    let apply = async {
        let current = client.claude_settings_effective(&harness).await?;
        let mut root: serde_json::Value = if current.content.trim().is_empty() {
            serde_json::json!({})
        } else {
            // An invalid file is never silently clobbered — surface the parse
            // error and make the user fix or `:set` after clearing manually.
            serde_json::from_str(&current.content).map_err(|e| {
                anyhow::anyhow!("settings file is invalid JSON ({e}) — fix it before :set")
            })?
        };
        app::edit_json_path(
            &mut root,
            &key,
            value.as_deref().map(app::parse_config_value),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        // An object emptied by :unset deletes the file (backend delete path).
        let body = if root.as_object().map(|o| o.is_empty()).unwrap_or(false) {
            String::new()
        } else {
            serde_json::to_string_pretty(&root)?
        };
        client.put_claude_settings(&harness, &body).await?;
        anyhow::Ok(())
    };
    if let Err(e) = apply.await {
        let _ = tx.send(Event::Error(format!("config edit: {e}")));
    }
    // Always refetch — success re-renders the new truth; failure restores it.
    match client.claude_settings_effective(&harness).await {
        Ok(v) => {
            let _ = tx.send(Event::Config(v));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config refetch: {e}")));
        }
    }
}

/// Load one plugin's saved per-harness config (D-014) → `Event::PluginConfig`.
async fn load_plugin_config(harness: String, plugin: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin config: {e}")));
            return;
        }
    };
    match client.plugin_config(&harness, &plugin).await {
        Ok(config) => {
            let _ = tx.send(Event::PluginConfig { plugin, config });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin config: {e}")));
        }
    }
}

/// Apply one `:pset`/`:punset` plugin-settings edit (D-014): fetch the current
/// config, edit the dotted path, PUT it back, then refetch so the settings view
/// re-renders from what the backend persisted (it validates against the
/// manifest's configSchema + prunes defaults, so the round-trip is the truth).
async fn plugin_config_edit(
    harness: String,
    plugin: String,
    key: String,
    value: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin edit: {e}")));
            return;
        }
    };
    let apply = async {
        let mut root = client.plugin_config(&harness, &plugin).await?;
        if !root.is_object() {
            root = serde_json::json!({});
        }
        app::edit_json_path(
            &mut root,
            &key,
            value.as_deref().map(app::parse_config_value),
        )
        .map_err(|e| anyhow::anyhow!(e))?;
        client.put_plugin_config(&harness, &plugin, &root).await?;
        anyhow::Ok(())
    };
    if let Err(e) = apply.await {
        let _ = tx.send(Event::Error(format!("plugin edit: {e}")));
    }
    match client.plugin_config(&harness, &plugin).await {
        Ok(config) => {
            let _ = tx.send(Event::PluginConfig { plugin, config });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugin refetch: {e}")));
        }
    }
}

/// Run one test file (D-004a) and emit `Event::TestRunDone`. A transport error
/// becomes a `status:"error"` result so the run pane always resolves.
async fn run_test_file(harness: String, file: String, tx: UnboundedSender<Event>) {
    let fail = |msg: String| models::TestRunResult {
        status: "error".to_string(),
        output: msg,
        ..Default::default()
    };
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::TestRunDone {
                file,
                result: fail(format!("{e}")),
            });
            return;
        }
    };
    match client.testing_run(&harness, &file).await {
        Ok(result) => {
            let _ = tx.send(Event::TestRunDone { file, result });
        }
        Err(e) => {
            let _ = tx.send(Event::TestRunDone {
                file,
                result: fail(format!("{e}")),
            });
        }
    }
}

/// Execute a command-palette workbench command (P12b / D-002): list/save/restore
/// layouts + crews via the backend. Results surface as toast notifications. The
/// SAVE-LAYOUT capture + RESTORE spawn are LIVE (zellij/psu) — real code that only
/// fires inside a running pui (never exercised by the offline test suite).
async fn execute_workbench_command(
    cmd: app::PaletteCommand,
    members: Vec<models::CrewMember>,
    tx: UnboundedSender<Event>,
) {
    use app::PaletteCommand as P;
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("workbench: {e}")));
            return;
        }
    };
    let owner = workbench::workbench_owner();
    let toast = |msg: String| {
        Event::Notify(models::Notif {
            level: "info".to_string(),
            message: msg,
            harness: None,
            ts: None,
        })
    };
    match cmd {
        P::ListLayouts => match client.list_layouts(&owner).await {
            Ok(ls) => {
                let names = if ls.is_empty() {
                    "(none saved)".to_string()
                } else {
                    ls.iter()
                        .map(|l| l.name.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let _ = tx.send(toast(format!("layouts: {names}")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("layouts: {e}")));
            }
        },
        P::ListCrews => match client.list_crews(&owner).await {
            Ok(cs) => {
                let names = if cs.is_empty() {
                    "(none saved)".to_string()
                } else {
                    cs.iter()
                        .map(|c| format!("{} ({})", c.name, c.member_count))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let _ = tx.send(toast(format!("crews: {names}")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("crews: {e}")));
            }
        },
        P::SaveCrew(name) => match client.save_crew(&owner, &name, &members, None, None).await {
            Ok(()) => {
                let _ = tx.send(toast(format!(
                    "saved crew '{name}' ({} agents)",
                    members.len()
                )));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("save-crew: {e}")));
            }
        },
        P::SaveLayout(name) => match workbench::capture_zellij_layout() {
            Some(kdl) => match client.save_layout(&owner, &name, &kdl, None).await {
                Ok(()) => {
                    let _ = tx.send(toast(format!("saved layout '{name}'")));
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("save-layout: {e}")));
                }
            },
            None => {
                let _ = tx.send(Event::Error(
                    "save-layout: not inside a zellij session".to_string(),
                ));
            }
        },
        P::RestoreLayout(name) => match client.get_layout(&owner, &name).await {
            Ok(Some(row)) => {
                // Write the KDL to a temp file + start a session from it (LIVE).
                let path = std::env::temp_dir().join(format!("pui-layout-{name}.kdl"));
                match std::fs::write(&path, &row.kdl) {
                    Ok(()) => {
                        let argv = workbench::restore_layout_argv(&path.to_string_lossy());
                        if let Some((prog, rest)) = argv.split_first() {
                            let _ = std::process::Command::new(prog).args(rest).spawn();
                        }
                        let _ = tx.send(toast(format!("restoring layout '{name}'")));
                    }
                    Err(e) => {
                        let _ = tx.send(Event::Error(format!("restore-layout: {e}")));
                    }
                }
            }
            Ok(None) => {
                let _ = tx.send(Event::Error(format!("restore-layout: '{name}' not found")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("restore-layout: {e}")));
            }
        },
        P::RestoreCrew(name) => match client.get_crew(&owner, &name).await {
            Ok(Some(crew)) => {
                let specs = workbench::crew_pane_specs(&crew);
                let n = specs.len();
                // Fire-and-forget each pane (LIVE — the companion isn't reachable
                // from this task; the run loop's fallback path is mirrored).
                for spec in &specs {
                    let _ = Zellij.open_pane(spec);
                }
                let _ = tx.send(toast(format!("restoring crew '{name}' ({n} agents)")));
            }
            Ok(None) => {
                let _ = tx.send(Event::Error(format!("restore-crew: '{name}' not found")));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("restore-crew: {e}")));
            }
        },
        // `:pickup [<plan>] <item>` — convert-at-pickup (D-015): the plan item
        // becomes a claimed work_item (lease + mint/resume + back-link) via
        // POST /api/tui/plan-item-convert; the server-side emits broadcast the
        // claim + flip the item todo→wip. Refetch the item states right after
        // so the pane reflects the new holder without waiting for the poller.
        P::PickupPlanItem {
            harness,
            plan,
            item,
        } => {
            let harness = harness.unwrap_or_else(|| "all".to_string());
            let Some(plan) = plan else {
                let _ = tx.send(Event::Error("pickup: no plan selected".to_string()));
                return;
            };
            match client
                .plan_item_convert(&owner, &harness, &plan, &item)
                .await
            {
                Ok(v) => {
                    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                    if ok {
                        let status = v
                            .get("status")
                            .and_then(|s| s.as_str())
                            .unwrap_or("converted");
                        let wi = v
                            .pointer("/workItem/id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("?");
                        let _ = tx.send(toast(format!("pickup {item}: {status} → {wi} (claimed)")));
                    } else {
                        let why = v
                            .get("reason")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                v.pointer("/conflict/ownerLabel")
                                    .or_else(|| v.pointer("/conflict/owner"))
                                    .and_then(|s| s.as_str())
                                    .map(|holder| format!("held by {holder}"))
                            })
                            .or_else(|| {
                                v.get("error")
                                    .and_then(|s| s.as_str())
                                    .map(|s| s.to_string())
                            })
                            .unwrap_or_else(|| "refused".to_string());
                        let _ = tx.send(Event::Error(format!("pickup {item}: {why}")));
                    }
                    if let Ok(s) = client.plan_item_states(&harness, &plan).await {
                        let _ = tx.send(Event::PlanItemStates(s));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("pickup: {e}")));
                }
            }
        }
        // `:release [<plan>] <item>` — the `:pickup` inverse (P-005b release
        // half): POST /api/tui/plan-item-release releases the converted
        // work_item (server-side reflect rules flip the item back to todo +
        // drop the lease) or just the bare lease when nothing live exists.
        // Refetch the item states right after, same as pickup.
        P::ReleasePlanItem {
            harness,
            plan,
            item,
        } => {
            let harness = harness.unwrap_or_else(|| "all".to_string());
            let Some(plan) = plan else {
                let _ = tx.send(Event::Error("release: no plan selected".to_string()));
                return;
            };
            match client
                .plan_item_release(&owner, &harness, &plan, &item)
                .await
            {
                Ok(v) => {
                    let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                    if ok {
                        let msg = match v.pointer("/workItem/id").and_then(|s| s.as_str()) {
                            // Released the live execution record — the reflect
                            // rules put the plan item back in the pool.
                            Some(wi) => format!("release {item}: {wi} released (back to pool)"),
                            // Bare-lease path (`released` rides plan_items:release).
                            None => {
                                if v.get("released").and_then(|b| b.as_bool()).unwrap_or(true) {
                                    format!("release {item}: lease released")
                                } else {
                                    format!("release {item}: no claim held")
                                }
                            }
                        };
                        let _ = tx.send(toast(msg));
                    } else {
                        let why = v
                            .get("note")
                            .or_else(|| v.get("error"))
                            .and_then(|s| s.as_str())
                            .unwrap_or("refused");
                        let _ = tx.send(Event::Error(format!("release {item}: {why}")));
                    }
                    if let Ok(s) = client.plan_item_states(&harness, &plan).await {
                        let _ = tx.send(Event::PlanItemStates(s));
                    }
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("release: {e}")));
                }
            }
        }
        // Config-tab (D-013) + plugin-settings (D-014) commands, and the
        // dockview dock-verbs (Brief 50 / D-008), are routed to their own
        // Actions in the reducer and never reach the workbench executor —
        // defensive no-op.
        P::ConfigSet { .. }
        | P::ConfigUnset { .. }
        | P::PluginSet { .. }
        | P::PluginUnset { .. }
        | P::Stack
        | P::Float { .. }
        | P::Dock { .. }
        | P::Layout { .. }
        | P::Theme { name: None }
        | P::Themes => {}
        // `:theme <name>` (workbench-theme-system P2 / D-003): the reducer
        // already flipped the pui palette + persisted the selection; this arm
        // syncs the zellij CHROME — regenerate + install the theme KDL files
        // (additive, marker-guarded) and point the single managed `theme` line
        // in config.kdl at the selection, so zellij's config watcher re-themes
        // the same instant pui re-rendered. Off the UI thread; small files.
        P::Theme { name: Some(name) } => match zellij_theme::sync(&name) {
            Ok(out) => {
                let mut msg = format!("theme: zellij chrome → {name}");
                if let zellij_theme::ConfigOutcome::RespectedUser(user) = &out.config {
                    msg = format!(
                        "theme: {name} set in pui only — config.kdl has your own `theme \"{user}\"` line (left untouched; remove it to let pui manage the chrome)"
                    );
                }
                if !out.skipped.is_empty() {
                    msg.push_str(&format!(
                        " · kept your own theme file(s): {}",
                        out.skipped.join(", ")
                    ));
                }
                let _ = tx.send(toast(msg));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("theme: zellij sync: {e}")));
            }
        },
        // `:create <slug> <path-or-github-url>` (D-010) — register a new pot,
        // then refresh the pot list so it appears in the selector immediately.
        P::CreatePot { slug, source } => match client.create_harness(&slug, &source).await {
            Ok(resp) => {
                if let Some(err) = resp.error {
                    let _ = tx.send(Event::Error(format!("create '{slug}': {err}")));
                } else {
                    let path = resp
                        .project
                        .as_ref()
                        .and_then(|p| p.path.clone())
                        .unwrap_or_default();
                    let _ = tx.send(toast(format!("created pot '{slug}' at {path}")));
                    if let Ok(hs) = client.harnesses().await {
                        let _ = tx.send(Event::Harnesses(hs));
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("create '{slug}': {e}")));
            }
        },
        // `:share <slug> [remote] [public]` (D-010) — the full share sequence.
        P::SharePot {
            slug,
            remote,
            public,
        } => {
            share_pot(&client, &slug, remote, public, &tx).await;
        }
        // `:message <text>` (inbox-tiering D-004) — "Message owner": open a
        // work-item-scoped conversation with the selected inbox item's owning
        // agent. The thread is browsable + repliable in the Conversations tab.
        P::MessageOwner {
            to,
            harness,
            plan_slug,
            item_ref,
            title,
            body,
        } => {
            match client
                .message_agent(
                    to.as_deref(),
                    harness.as_deref(),
                    plan_slug.as_deref(),
                    item_ref.as_deref(),
                    &title,
                    &body,
                )
                .await
            {
                Ok(conv_id) => {
                    let who = to.as_deref().unwrap_or("the owning agent");
                    let _ = tx.send(toast(format!(
                        "messaged {who} — thread {conv_id} (open the Conversations tab to continue)"
                    )));
                }
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("message owner: {e}")));
                }
            }
        }
    }
}

/// The `:share <slug>` sequence (D-010), mirroring the desktop ShareWizard's
/// calls: resolve the GitHub remote (explicit arg, else the pot repo's
/// `origin`), resolve the canonical repo binding, generate a fresh 32-byte
/// topic, POST share/finalize (writes shared.json + boots the swarm + publishes
/// the binding), and — for `public` — publish the harness listing to the
/// Cupboard. Failures surface in the status bar; progress lands as toasts.
async fn share_pot(
    client: &OperatorClient,
    slug: &str,
    remote: Option<String>,
    public: bool,
    tx: &UnboundedSender<Event>,
) {
    let toast = |msg: String| {
        Event::Notify(models::Notif {
            level: "info".to_string(),
            message: msg,
            harness: Some(slug.to_string()),
            ts: None,
        })
    };
    // 1. The GitHub remote: explicit arg wins, else read the repo's `origin`.
    let remote = match remote {
        Some(r) => r,
        None => {
            let path = match client.harnesses().await {
                Ok(hs) => hs.into_iter().find(|h| h.slug == slug).and_then(|h| h.path),
                Err(e) => {
                    let _ = tx.send(Event::Error(format!("share: list pots: {e}")));
                    return;
                }
            };
            let Some(path) = path else {
                let _ = tx.send(Event::Error(format!(
                    "share: pot '{slug}' not found (or has no local path)"
                )));
                return;
            };
            match tokio::process::Command::new("git")
                .args(["-C", &path, "remote", "get-url", "origin"])
                .output()
                .await
            {
                Ok(o) if o.status.success() => {
                    String::from_utf8_lossy(&o.stdout).trim().to_string()
                }
                _ => {
                    let _ = tx.send(Event::Error(format!(
                        "share: no `origin` remote in {path} — pass one: :share {slug} <github-url>"
                    )));
                    return;
                }
            }
        }
    };
    // 2. Resolve the binding (canonical repo id/owner/name + visibility).
    let binding = match client.resolve_binding(&remote).await {
        Ok(b) => b,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("share: resolve binding: {e}")));
            return;
        }
    };
    if let Some(e) = binding.error {
        let _ = tx.send(Event::Error(format!("share: resolve binding: {e}")));
        return;
    }
    if public && binding.private {
        let _ = tx.send(Event::Error(
            "share: repo is private — the Cupboard refuses private repos (drop `public`)".into(),
        ));
        return;
    }
    // 3. A fresh 32-byte topic (the shared.json human-link topic; the swarm
    //    topic is derived server-side from the repo id).
    let topic = match random_topic_hex() {
        Ok(t) => t,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("share: topic gen: {e}")));
            return;
        }
    };
    // 4. Finalize — writes shared.json, boots the swarm, publishes the binding.
    let privacy = if public {
        "shared-public"
    } else {
        "shared-private"
    };
    let state = serde_json::json!({
        "topic": topic,
        "github_remote": remote,
        "github_repository_id": binding.github_repository_id,
        "privacy": privacy,
    });
    match client.share_finalize(slug, state).await {
        Ok(v) => {
            if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                let _ = tx.send(Event::Error(format!("share finalize: {e}")));
                return;
            }
            let _ = tx.send(toast(format!("shared '{slug}' ({privacy})")));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("share finalize: {e}")));
            return;
        }
    }
    // 5. Cupboard publish (public shares only).
    if public {
        let body = serde_json::json!({
            "listing_kind": "harness",
            "github_repository_id": binding.github_repository_id,
            "github_owner": binding.github_owner,
            "github_name": binding.github_repo,
            "github_url": format!(
                "https://github.com/{}/{}",
                binding.github_owner, binding.github_repo
            ),
            "topic_hex": topic,
        });
        match client.cupboard_publish_harness(body).await {
            Ok(v) => {
                if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                    let _ = tx.send(Event::Error(format!("cupboard publish: {e}")));
                } else {
                    let _ = tx.send(toast(format!("published '{slug}' to the Cupboard")));
                }
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("cupboard publish: {e}")));
            }
        }
    }
}

/// 32 random bytes as lowercase hex — the shared.json topic. Reads
/// `/dev/urandom` directly (this TUI is Unix-targeted; zero new deps).
fn random_topic_hex() -> Result<String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Fetch Cupboard listings for the active (kind, query) filter (D-011) and emit
/// `Event::CupboardListings` (stale-guarded in the reducer by kind+query). On
/// error an empty page still ships so the loading state resolves; the error
/// itself lands in the status bar.
async fn fetch_cupboard(kind: String, query: String, tx: UnboundedSender<Event>) {
    let empty = |kind: String, query: String| Event::CupboardListings {
        kind,
        query,
        listings: Vec::new(),
    };
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard: {e}")));
            let _ = tx.send(empty(kind, query));
            return;
        }
    };
    match client
        .cupboard_listings(Some(kind.as_str()), Some(query.as_str()), 100)
        .await
    {
        Ok(listings) => {
            let _ = tx.send(Event::CupboardListings {
                kind,
                query,
                listings,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard: {e}")));
            let _ = tx.send(empty(kind, query));
        }
    }
}

/// Execute a confirmed per-kind Cupboard action (D-011): harness→join,
/// blueprint→fork (install), snapshot→fork, plugin→install. Success/failure
/// ride Notify/Error; harness-affecting outcomes also refresh the pot list.
/// Conversations browse (Brief 25): fetch the list under the active state/kind
/// filter ("all" → no filter). Mirrors `fetch_cupboard` — emits an empty list on
/// error so the tab degrades to its empty state instead of hanging on "loading".
async fn fetch_conversations(state: String, kind: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversations: {e}")));
            let _ = tx.send(Event::Conversations(Vec::new()));
            return;
        }
    };
    let st = if state == "all" {
        None
    } else {
        Some(state.as_str())
    };
    let kd = if kind == "all" {
        None
    } else {
        Some(kind.as_str())
    };
    match client.conversations_list(st, kd, None).await {
        Ok(list) => {
            let _ = tx.send(Event::Conversations(list));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversations: {e}")));
            let _ = tx.send(Event::Conversations(Vec::new()));
        }
    }
}

/// Load one conversation's full thread (seed + topics + posts + accepted answer +
/// linked work-item). Stale-guarded by id in the reducer.
async fn fetch_conversation_detail(id: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversation: {e}")));
            return;
        }
    };
    match client.conversation_get(&id).await {
        Ok(detail) => {
            let _ = tx.send(Event::ConversationDetail { id, detail });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("conversation: {e}")));
        }
    }
}

/// Promote a conversation → engineer issue (carries the thread), then refresh the
/// detail so the linked work-item + closed state show. The list refreshes on the
/// next `r`/filter change.
async fn promote_conversation(id: String, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("promote: {e}")));
            return;
        }
    };
    match client.conversation_promote(&id).await {
        Ok(issue) => {
            let message = if issue.is_empty() {
                "conversation promoted to an issue".to_string()
            } else {
                format!("promoted → {issue}")
            };
            let _ = tx.send(Event::Notify(models::Notif {
                level: "info".to_string(),
                message,
                harness: None,
                ts: None,
            }));
            if let Ok(detail) = client.conversation_get(&id).await {
                let _ = tx.send(Event::ConversationDetail { id, detail });
            }
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("promote: {e}")));
        }
    }
}

async fn cupboard_act(listing: models::CupboardListing, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("cupboard action: {e}")));
            return;
        }
    };
    let name = listing.display_name().to_string();
    let toast = |msg: String| {
        Event::Notify(models::Notif {
            level: "info".to_string(),
            message: msg,
            harness: None,
            ts: None,
        })
    };
    // The (outcome, success message, whether the pot list changed).
    let (result, ok_msg, pots_changed) = match listing.listing_kind.as_str() {
        "plugin" => (
            client.cupboard_install_plugin(&listing.id).await,
            format!("installed plugin '{name}'"),
            false,
        ),
        "blueprint" => (
            client.cupboard_install_blueprint(&listing.id).await,
            format!("installed blueprint '{name}' — start a pot from it with :create"),
            false,
        ),
        "snapshot" => (
            client.snapshot_fork_from_cupboard(&listing.id).await,
            format!("forked snapshot '{name}' into a new pot"),
            true,
        ),
        "harness" => {
            let Some(link) = listing.join_link() else {
                let _ = tx.send(Event::Error(format!(
                    "join '{name}': listing has no topic/github join link"
                )));
                return;
            };
            // Local slug defaults to the listing's name fields.
            let slug = listing
                .listing_ref
                .clone()
                .or_else(|| listing.github_name.clone())
                .unwrap_or_else(|| name.clone());
            (
                client.harness_join_link(&slug, &link).await,
                format!("joined '{name}' as pot '{slug}'"),
                true,
            )
        }
        other => {
            let _ = tx.send(Event::Error(format!(
                "cupboard: no action for listing kind '{other}'"
            )));
            return;
        }
    };
    match result {
        Ok(v) => {
            if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
                let _ = tx.send(Event::Error(format!(
                    "cupboard {}: {e}",
                    listing.listing_kind
                )));
                return;
            }
            // Surface the blueprint dep-checker's missing-deps note when present.
            let dep_note = v
                .get("depCheck")
                .and_then(|d| d.get("ok"))
                .and_then(|b| b.as_bool())
                .map(|ok| {
                    if ok {
                        String::new()
                    } else {
                        " (missing deps — see desktop)".into()
                    }
                })
                .unwrap_or_default();
            let _ = tx.send(toast(format!("{ok_msg}{dep_note}")));
            if pots_changed {
                if let Ok(hs) = client.harnesses().await {
                    let _ = tx.send(Event::Harnesses(hs));
                }
            }
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!(
                "cupboard {}: {e}",
                listing.listing_kind
            )));
        }
    }
}

/// Load the operator conversation on open (tui-operator-surface P0/P1) and seed
/// the chat transcript. Workspace-scoped — the same thread the desktop surface
/// shares. A missing backend ends the task quietly (the pane shows its empty
/// state). Best-effort: a fetch error surfaces in the status bar.
async fn chat_load_history(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    match client.load_conversation(200).await {
        Ok(load) => {
            // Cursor = the lowest seq returned (turns are oldest-first), even if a
            // turn is filtered from display — so load-earlier never re-fetches it.
            let oldest_seq = load.turns.iter().map(|t| t.seq).min();
            let has_more_earlier = load.has_more_earlier;
            let conversation_id = load.conversation.id;
            let messages: Vec<models::ChatMessage> =
                load.turns.into_iter().filter_map(turn_to_message).collect();
            let _ = tx.send(Event::ChatHistory {
                conversation_id,
                messages,
                has_more_earlier,
                oldest_seq,
            });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("operator chat: {e}")));
        }
    }
}

/// Fetch the active Hive lexicon pack ONCE at startup (pui-hive-lexicon-2026-06-06)
/// and emit `Event::LexiconPack`. Fail-soft: an unreachable operator / parse
/// error leaves the classic fallback in place (no rebrand), silently — branding
/// must never block the UI.
async fn lexicon_fetch(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    if let Ok(pack) = client.lexicon_active_pack().await {
        let _ = tx.send(Event::LexiconPack(pack));
    }
}

/// P-008: set an agent's wake mode via `coord:wake-mode` (the run_tool bridge).
/// Best-effort — an error surfaces in the status bar; the next roster poll
/// refreshes the ⏸MANUAL badge (no dedicated re-fetch event needed).
async fn set_wake_mode(agent: String, mode: String, tx: UnboundedSender<Event>) {
    let res = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .run_tool(
                "coord:wake-mode",
                serde_json::json!({ "agent": agent, "mode": mode }),
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = res {
        let _ = tx.send(Event::Error(format!("wake-mode: {e}")));
    }
}

/// P-009: list an agent's staged wakes (`coord:wake-queue {action:'list'}`) for
/// the review overlay → `Event::WakeQueue`.
async fn fetch_wake_queue(agent: String, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => client
            .run_tool(
                "coord:wake-queue",
                serde_json::json!({ "agent": agent, "action": "list" }),
            )
            .await
            .map_err(|e| e.to_string())
            .and_then(|v| crate::client::parse_wake_queue_list(&v).map_err(|e| e.to_string())),
        Err(e) => Err(e.to_string()),
    };
    let _ = tx.send(Event::WakeQueue { agent, result });
}

/// P-009: release (as-is or with edited content) / skip ONE staged wake, then
/// re-list the queue so the overlay refreshes. An act error rides the same
/// `Event::WakeQueue` rail (Err → shown inline in the overlay).
async fn wake_queue_act(
    agent: String,
    release: bool,
    id: i64,
    edited: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let action = if release { "release" } else { "skip" };
    let res = match OperatorClient::from_discovery().await {
        Ok(client) => {
            let mut args = serde_json::json!({ "agent": agent, "action": action, "id": id });
            if let Some(e) = edited {
                args["edited"] = serde_json::Value::String(e);
            }
            client
                .run_tool("coord:wake-queue", args)
                .await
                .map_err(|e| e.to_string())
                .and_then(|v| {
                    // Surface a tool-level { ok:false, reason } as an error.
                    let inner =
                        crate::client::run_tool_inner_json(&v).map_err(|e| e.to_string())?;
                    if inner.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                        Ok(())
                    } else {
                        Err(inner
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("wake-queue act failed")
                            .to_string())
                    }
                })
        }
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(()) => fetch_wake_queue(agent, tx).await,
        Err(e) => {
            let _ = tx.send(Event::WakeQueue {
                agent,
                result: Err(e),
            });
        }
    }
}

/// EI-312: snapshot the staged-wake board — an agent-LESS `coord:wake-queue`
/// list (every owner's queue, including stale owners the roster no longer
/// carries) joined with the roster for labels/kinds, scoped by this pane's
/// [`app::WakeFilter`] (fleet-wide, the live queen, or one owner), plus the
/// GLOBAL default wake-mode (a fleet-wide pause reads differently from one
/// paused agent) → `Event::WakeBoard`. The `Hive` scope (P-014 item 3) swaps
/// the source to the server-filtered `network.hive.wakes` query instead —
/// same rows, pre-scoped to the hive's attributed owners.
async fn fetch_wake_board(filter: app::WakeFilter, tx: UnboundedSender<Event>) {
    let result = match OperatorClient::from_discovery().await {
        Ok(client) => {
            let pending = match &filter {
                app::WakeFilter::Hive(hive) => {
                    client.hive_wakes(hive).await.map_err(|e| e.to_string())
                }
                // EI-597 Step B: the non-Hive scopes (fleet/queen/owner) now read
                // the `network.fleet.wakes` SSE-rail query instead of polling
                // coord:wake-queue{action:list}. Same full-queue payload; the
                // filter_wake_groups call below still narrows it to the scope.
                _ => client.fleet_wakes().await.map_err(|e| e.to_string()),
            };
            match pending {
                Ok(pending) => {
                    // Roster join is best-effort: a fetch error degrades to raw
                    // owner-id labels, never an empty board.
                    let roster = client
                        .roster_typed()
                        .await
                        .map(|(active, _)| active)
                        .unwrap_or_default();
                    // The global default mode: coord:wake-mode with no agent.
                    let global_mode = client
                        .run_tool("coord:wake-mode", serde_json::json!({}))
                        .await
                        .ok()
                        .and_then(|v| crate::client::run_tool_inner_json(&v).ok())
                        .and_then(|inner| {
                            inner
                                .get("mode")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                        });
                    let groups = crate::app::filter_wake_groups(
                        crate::client::assemble_wake_board(pending, &roster),
                        &filter,
                        &roster,
                    );
                    Ok((groups, global_mode))
                }
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e.to_string()),
    };
    let _ = tx.send(Event::WakeBoard { result });
}

/// EI-312: act on the wake board — verb is the coord:wake-queue action
/// (release / skip take an id; release_all / skip_all drain the whole agent
/// queue), then re-snapshot. An act error rides Event::WakeBoard (Err →
/// shown inline in the pane).
async fn wake_board_act(
    agent: String,
    verb: &'static str,
    id: Option<i64>,
    edited: Option<String>,
    filter: app::WakeFilter,
    tx: UnboundedSender<Event>,
) {
    let res = match OperatorClient::from_discovery().await {
        Ok(client) => {
            let mut args = serde_json::json!({ "agent": agent, "action": verb });
            if let Some(id) = id {
                args["id"] = serde_json::Value::from(id);
            }
            if let Some(e) = edited {
                args["edited"] = serde_json::Value::String(e);
            }
            client
                .run_tool("coord:wake-queue", args)
                .await
                .map_err(|e| e.to_string())
                .and_then(|v| {
                    let inner =
                        crate::client::run_tool_inner_json(&v).map_err(|e| e.to_string())?;
                    if inner.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                        Ok(())
                    } else {
                        Err(inner
                            .get("reason")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("wake-board act failed")
                            .to_string())
                    }
                })
        }
        Err(e) => Err(e.to_string()),
    };
    match res {
        Ok(()) => fetch_wake_board(filter, tx).await,
        Err(e) => {
            let _ = tx.send(Event::WakeBoard { result: Err(e) });
        }
    }
}

/// EI-312: the wake-pane's refresh loop — re-snapshot the board every ~10s.
/// Safety-net fallback (NOT a freshness poll): the pending-wakes push rail
/// EXISTS — pushWakeBoard() (pending-wakes.ts) fires notifySyncInvalidate(
/// 'network.hive.wakes') on every stage/clear, and the HIVE scope already
/// consumes it over SSE (fetch_wake_board → WakeFilter::Hive → client.hive_wakes,
/// no poll). The non-Hive scopes (fleet/queen/owner) are not yet on that SSE
/// query, so this loop still refreshes them — but DEMOTED 10s→60s (EI-597 Step A,
/// su-dfe5e + su-cf7b0): it is now a slow safety fallback, no longer the fleet's
/// #1/#2 tool-call driver. The board is a human review surface for paused
/// (manual-mode) agents, so 60s freshness is ample; user actions already refetch
/// immediately (the keymap's `fetch_wake_board` on r/e/s/R/S).
///
/// EI-597 Step B (full fix, in review): generalize the `network.hive.wakes` SSE
/// query to the non-Hive scopes + route fetch_wake_board's non-Hive branches to
/// it (mirroring the proven Hive branch), after which this fallback can drop.
async fn wake_board_loop(filter: app::WakeFilter, tx: UnboundedSender<Event>) {
    // 10s→60s safety-only fallback (EI-597 Step A): the Hive scope is SSE-driven;
    // this backstops the non-Hive scopes until Step B puts them on the rail too.
    let mut ticker = tokio::time::interval(Duration::from_millis(60_000));
    loop {
        ticker.tick().await;
        if tx.is_closed() {
            return;
        }
        fetch_wake_board(filter.clone(), tx.clone()).await;
    }
}

/// Dock 4-pane split (owner ask 2026-06-11): the agent-context pane's refresh
/// loop — re-snapshot every ~5s (mail/work mutate from many writers; the brief
/// is static but the AGENT can appear/exit). Justified poll: same rationale as
/// the wake board, one consumer per pane, no push rail for these reads.
async fn agent_ctx_loop(
    mode: app::AgentCtxMode,
    scope: app::WakeFilter,
    tx: UnboundedSender<Event>,
) {
    let mut ticker = tokio::time::interval(Duration::from_millis(5000));
    loop {
        ticker.tick().await;
        if tx.is_closed() {
            return;
        }
        fetch_agent_ctx(mode, scope.clone(), tx.clone()).await;
    }
}

/// One agent-context snapshot: resolve the scope to an owner id off the live
/// roster (Queen = the roster's queen-kind entry, same rule the wake board
/// uses), then fetch ONLY the pinned mode's data — brief via `fleet:tree`
/// (the nursery row of the owner's own spawn id), mail via `fleet:bee_mail`,
/// work via `fleet:assignments`.
async fn fetch_agent_ctx(
    mode: app::AgentCtxMode,
    scope: app::WakeFilter,
    tx: UnboundedSender<Event>,
) {
    let result: Result<models::AgentCtxData, String> = async {
        let client = OperatorClient::from_discovery()
            .await
            .map_err(|e| e.to_string())?;
        let roster = client
            .roster_typed()
            .await
            .map(|(active, _)| active)
            .unwrap_or_default();
        let entry = match &scope {
            app::WakeFilter::Owner(id) => roster.iter().find(|r| &r.owner_id == id),
            // Queen (and the never-used All fallback): the roster's queen-kind row.
            _ => roster
                .iter()
                .find(|r| r.agent_pane_kind.as_deref() == Some("queen")),
        };
        let owner = match (&scope, entry) {
            (app::WakeFilter::Owner(id), None) => Some(id.clone()), // gone but addressable
            (_, Some(r)) => Some(r.owner_id.clone()),
            (_, None) => None,
        };
        let mut data = models::AgentCtxData {
            owner: owner.clone(),
            label: entry.map(|r| r.label.clone()),
            ..Default::default()
        };
        let Some(owner) = owner else { return Ok(data) };
        match mode {
            app::AgentCtxMode::Prompt => {
                // The prompt the agent runs on (GET /api/fleet/agent-prompt):
                // an s-… owner gets its RECORDED run prompt (brief led
                // separately); a non-spawn owner under Queen scope gets a live
                // render of the queen role persona. The role hint follows the
                // roster entry's kind when known.
                let role_hint = if owner.starts_with("s-") {
                    None
                } else {
                    entry.and_then(|r| r.agent_pane_kind.clone()).or_else(|| {
                        matches!(scope, app::WakeFilter::Queen).then(|| "queen".to_string())
                    })
                };
                let v = client
                    .agent_prompt(Some(&owner), role_hint.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
                let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
                data.prompt = s("prompt");
                data.source = s("source");
                data.brief = s("brief");
                data.model = s("model");
                data.tier = s("tier");
            }
            app::AgentCtxMode::Mail => {
                data.mail = Some(
                    client
                        .bee_mail(&owner, 30)
                        .await
                        .map_err(|e| e.to_string())?,
                );
            }
            app::AgentCtxMode::Work => {
                data.assignment = client
                    .bee_assignment(&owner)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(data)
    }
    .await;
    let _ = tx.send(Event::AgentCtx { result });
}

/// Fetch the federated p2p roster (`coord:presence`, federated rows only) and
/// emit `Event::Hives` — the Hives tab's per-device swarm roster
/// (pui-hives-tab-2026-06-07). Best-effort: transport loss keeps the previous
/// list; the next Hives entry retries.
async fn fetch_hives(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.federated_hives().await {
        Ok(rows) => {
            let _ = tx.send(Event::Hives(rows));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("hives: {e}")));
        }
    }
}

/// Write a per-hive drill-in tab's KDL (`layout::hive_tab_kdl`, B-10) to
/// `~/.papercusp/pui-hive-tab-<key>.kdl` and return the path. The zellij CLI's
/// `new-tab --layout` takes a layout FILE; the companion (which takes raw KDL
/// text) is never spawned in pinned panes, so the network-pane's drill-in
/// rides the file + CLI. One file per hive key — re-opening overwrites it.
fn materialize_hive_tab(spec: &layout::HiveTabSpec) -> std::io::Result<std::path::PathBuf> {
    let base = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?
        .join(".papercusp");
    std::fs::create_dir_all(&base)?;
    // The key can be a pubkey-b64 (`/`, `+`, `=`) — slug it for the filename.
    let slug: String = spec
        .key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let path = base.join(format!("pui-hive-tab-{slug}.kdl"));
    std::fs::write(&path, layout::hive_tab_kdl(spec))?;
    Ok(path)
}

/// Fetch the cross-Hive network board (hive-network-surface B-09) off the UI
/// thread and emit `Event::NetworkBoard` — the network-pane's manual `g`
/// refresh. Errors surface in the status bar (the user asked, so a failure is
/// an answer); the refetch loop's passes stay quietly optional instead.
async fn fetch_network_board(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.network_board().await {
        Ok(rows) => {
            let _ = tx.send(Event::NetworkBoard(rows));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("network board: {e}")));
        }
    }
}

/// Fetch the plans status board's two inputs — the plans list + the live roster
/// (pui-plans-status-board-2026-06-14) — off the UI thread and emit
/// `Event::Plans` + `Event::Roster`, the same events the standard refetch loop
/// feeds. The plans-pane's manual `g` refresh: errors surface in the status bar
/// (the user asked, so a failure is an answer).
async fn fetch_plans_board(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.plans_typed().await {
        Ok(p) => {
            let _ = tx.send(Event::Plans(p));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plans: {e}")));
        }
    }
    match client.roster_typed().await {
        Ok((active, pending)) => {
            let _ = tx.send(Event::Roster { active, pending });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("roster: {e}")));
        }
    }
}

/// Fetch one plan's per-item assignment/claim/liveness (pui-plans-status-board
/// P-008) → `Event::PlanItemStates`, for the plans board's right-side work-items
/// detail. The reducer guards the render on `plan == selected`, so a stale fetch
/// from a prior selection never paints the wrong plan. Errors are swallowed (the
/// detail just keeps its last state / shows its loading hint).
async fn fetch_plan_item_states(harness: String, plan: String, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    if let Ok(s) = client.plan_item_states(&harness, &plan).await {
        let _ = tx.send(Event::PlanItemStates(s));
    }
}

/// Fetch the per-hive drill-in dossier data (hive-network-surface P-014
/// item 2 / D-007 GAP 2) for the pinned `pui hive-pane <key>` instance: the
/// captured beacon HISTORY + the full C-1 ask log, via the `network.hive.*`
/// sync queries. Quietly best-effort BOTH ways: a tier-2/3 slug key simply
/// matches no beacon/peer rows (→ empty lists, sections hidden), and a host
/// predating the queries renders the C-3 detail alone — never a toast per pass.
async fn hive_dossier_fetch(key: String, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    let beacons = client.hive_beacons(&key).await.unwrap_or_default();
    let asks = client.hive_asks(&key).await.unwrap_or_default();
    let _ = tx.send(Event::HiveDossier { beacons, asks });
}

/// Fetch the P2P hive directory (`GET /api/discovery/hives`) and emit
/// `Event::HiveDirectory` — the Hives tab's browseable directory list
/// (p2p-hive-directory P-006). Best-effort: a fetch failure keeps the prior list.
async fn fetch_hive_directory(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.discovered_hives().await {
        Ok(rows) => {
            let _ = tx.send(Event::HiveDirectory(rows));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("hive-directory: {e}")));
        }
    }
}

/// Join every member harness of a discovered hive (p2p-hive-directory P-006):
/// POST each link to `/api/harness/join-link`. Emits one `Notify` summarising
/// how many succeeded (best-effort per link).
async fn join_hive(slug: String, links: Vec<String>, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        let _ = tx.send(Event::Error("join: operator unreachable".to_string()));
        return;
    };
    let mut ok = 0usize;
    for (i, link) in links.iter().enumerate() {
        let member_slug = format!("{slug}-{i}");
        match client.join_hive_link(&member_slug, link).await {
            Ok(_) => ok += 1,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("join {member_slug}: {e}")));
            }
        }
    }
    let _ = tx.send(Event::Notify(models::Notif {
        level: "info".to_string(),
        message: format!(
            "hive {slug}: joined {ok}/{} member harness(es)",
            links.len()
        ),
        harness: None,
        ts: None,
    }));
}

/// Fetch the whole-fleet assignments (`fleet:assignments`, no agent filter) and
/// emit `Event::FleetAssignments` — the default Swarm dossier's task list
/// (pui-dock-consolidation-2026-06-07 #2). Best-effort: a transport loss keeps
/// the "(loading fleet task list…)" placeholder; the next Fleet entry retries.
async fn fetch_fleet_assignments(tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    match client.fleet_assignments_all().await {
        Ok(agents) => {
            let _ = tx.send(Event::FleetAssignments(agents));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("fleet assignments: {e}")));
        }
    }
}

/// Fetch one bee's dossier — its ranked work-list (`fleet:assignments { agent }`)
/// + coord inbox/outbox (`fleet:bee_mail`) — and emit `Event::BeeDossier`. Each
/// half is best-effort: a failure of one still ships the other (the reducer
/// stale-guards on `owner_id`). On a total transport failure nothing is sent (the
/// pane keeps its "loading…" state; the next selection re-triggers).
async fn bee_dossier_fetch(owner_id: String, tx: UnboundedSender<Event>) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    let assignment = client.bee_assignment(&owner_id).await.ok().flatten();
    let mail = client.bee_mail(&owner_id, 50).await.ok();
    let _ = tx.send(Event::BeeDossier {
        owner_id,
        assignment,
        mail,
    });
}

/// Publish the swarm pane's bee selection to the ephemeral relay
/// (pui-bee-dossier-pane-2026-06-06): POST `fleet:selected_bee { select }`.
/// Best-effort — a failed publish just means the bee pane keeps its last
/// selection until the next cursor move; a transient error toasts so the
/// keypress never silently no-ops on a persistent failure.
async fn publish_bee_selection(
    owner_id: Option<String>,
    name: Option<String>,
    tx: UnboundedSender<Event>,
) {
    let Ok(client) = OperatorClient::from_discovery().await else {
        return;
    };
    if let Err(e) = client
        .selected_bee_set(owner_id.as_deref(), name.as_deref())
        .await
    {
        let _ = tx.send(Event::Error(format!("select bee: {e}")));
    }
}

/// Fetch the next older page of operator turns (load-earlier / scroll-back) and
/// emit `Event::ChatEarlier` to prepend them. Best-effort — a fetch error just
/// clears the in-flight flag (via an empty ChatEarlier) so the user can retry.
async fn load_earlier_chat(conversation_id: String, before_seq: i64, tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => {
            let _ = tx.send(Event::ChatEarlier {
                messages: Vec::new(),
                has_more_earlier: true,
                oldest_seq: None,
            });
            return;
        }
    };
    match client
        .load_earlier_turns(&conversation_id, before_seq, 200)
        .await
    {
        Ok(page) => {
            let oldest_seq = page.turns.iter().map(|t| t.seq).min();
            let messages: Vec<models::ChatMessage> =
                page.turns.into_iter().filter_map(turn_to_message).collect();
            let _ = tx.send(Event::ChatEarlier {
                messages,
                has_more_earlier: page.has_more_earlier,
                oldest_seq,
            });
        }
        Err(e) => {
            // Keep has_more_earlier=true so the user can retry; clear the flag.
            let _ = tx.send(Event::ChatEarlier {
                messages: Vec::new(),
                has_more_earlier: true,
                oldest_seq: None,
            });
            let _ = tx.send(Event::Error(format!("operator chat (earlier): {e}")));
        }
    }
}

/// Map a persisted turn to a rendered chat message. Only user/assistant turns
/// surface (system turns are internal); the persisted assistant text is already
/// the finalized `<say>` body, so it renders directly.
fn turn_to_message(t: models::TurnDto) -> Option<models::ChatMessage> {
    if t.role != "user" && t.role != "assistant" {
        return None;
    }
    let tools = t
        .tools
        .unwrap_or_default()
        .into_iter()
        .map(|x| models::ChatToolCall { name: x.name })
        .collect();
    Some(models::ChatMessage {
        role: t.role,
        content: t.text,
        tools,
        streaming: false,
    })
}

/// Run one operator chat turn (tui-operator-surface P1). Persists the user turn,
/// opens the converse SSE stream over the active transport, relays
/// `delta`/`tool_call`/`done`/`error` as chat events, then persists the
/// finalized assistant turn — exactly the path the desktop operator uses, over
/// the shared `operator` role. `history` is the transcript to send (already
/// includes the just-sent user message).
///
/// When `speak` is `Some(player)` (a voice PTT turn — voice-mode-tui-port P2),
/// the finalized reply is also synthesized via the operator TTS proxy and played
/// through `player`, and the turn's voice phase transitions (Speaking → Finished)
/// ride `Event::Voice`.
async fn converse_send(
    text: String,
    mut conversation_id: Option<String>,
    history: Vec<(String, String)>,
    owner: String,
    speak: Option<voice::Player>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::ChatError(format!("{e}")));
            return;
        }
    };

    // Ensure a conversation id so turns persist (the startup load usually set it;
    // this covers a send that races ahead of the load).
    if conversation_id.is_none() {
        if let Ok(load) = client.load_conversation(1).await {
            conversation_id = Some(load.conversation.id);
        }
    }

    // Persist the user turn (best-effort — the converse stream is transient).
    if let Some(id) = &conversation_id {
        let _ = client.append_turn(id, "user", &text, &[], None).await;
    }

    // Build the converse payload: full transcript + the TUI surface marker so the
    // operator injects the pui affordances (D-003) and skips card tools.
    let messages: Vec<serde_json::Value> = history
        .iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    let mut body = serde_json::json!({
        "messages": messages,
        "trigger": "user_message",
        "modality": "text",
        "mayAskActive": false,
        "surface": "tui",
        "uiClientId": owner,
    });
    if let Some(id) = &conversation_id {
        body["conversationId"] = serde_json::Value::String(id.clone());
    }

    let mut sub = match client.subscribe_converse(body).await {
        Ok(rx) => rx,
        Err(e) => {
            let _ = tx.send(Event::ChatError(format!("{e}")));
            return;
        }
    };

    let mut raw = String::new();
    let mut tools: Vec<serde_json::Value> = Vec::new();
    while let Some(fr) = sub.recv().await {
        match fr.event.as_str() {
            "delta" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                    if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
                        raw.push_str(t);
                        let _ = tx.send(Event::ChatDelta(t.to_string()));
                    }
                }
            }
            "tool_call" => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                    if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
                        tools.push(serde_json::json!({
                            "name": name,
                            "input": v.get("input").cloned().unwrap_or(serde_json::Value::Null),
                        }));
                        let _ = tx.send(Event::ChatToolCall(models::ChatToolCall {
                            name: name.to_string(),
                        }));
                    }
                }
            }
            "error" => {
                let msg = serde_json::from_str::<serde_json::Value>(&fr.data)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                    .unwrap_or_else(|| "operator error".to_string());
                let _ = tx.send(Event::ChatError(msg));
                return;
            }
            "done" => break,
            _ => {} // heartbeat etc.
        }
    }

    // Finalize: resolve the buffered tag-document to the user-visible say text,
    // tell the pane the turn is done, and persist the assistant turn. The
    // `<report>` payload (if any) is parsed from the raw turn + persisted
    // alongside (the pane sets it on the in-flight bubble via finish_chat_turn).
    let final_text = chat_tags::finalize(&raw);
    let report_val = chat_tags::extract_report(&raw).and_then(|r| serde_json::to_value(r).ok());
    let _ = tx.send(Event::ChatDone);
    if let Some(id) = &conversation_id {
        if !final_text.trim().is_empty() || !tools.is_empty() || report_val.is_some() {
            let _ = client
                .append_turn(id, "assistant", &final_text, &tools, report_val.as_ref())
                .await;
        }
    }

    // Voice PTT turn (P2): speak the finalized reply. Synthesis goes through the
    // operator TTS proxy (engine/voice from voice-prefs server-side) and plays
    // through the run loop's long-lived player. An empty reply just ends the turn.
    if let Some(player) = speak {
        if final_text.trim().is_empty() {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
        } else {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Speaking));
            match client.tts_speak(&final_text).await {
                Ok(audio) => player.play(audio),
                Err(e) => {
                    let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!("tts: {e}"))));
                    return;
                }
            }
            // Playback is fire-and-forget on the player thread; the turn is
            // logically done (the meter/phase return to idle now).
            let _ = tx.send(Event::Voice(event::VoiceMsg::Finished));
        }
    }
}

/// One voice PTT turn (voice-mode-tui-port-2026-06-05 P2): finish the mic
/// capture, transcribe it via the operator STT proxy, inject the recognized text
/// as the user's turn, then run the operator converse turn + speak the reply
/// (reusing `converse_send`). Each step's failure surfaces as `Event::Voice(Error)`
/// (which the reducer resets the phase on); a too-short / empty capture ends
/// quietly. The mic `CaptureSession` arrives from the run loop, which owns it.
async fn voice_turn(
    session: voice::CaptureSession,
    conversation_id: Option<String>,
    mut history: Vec<(String, String)>,
    owner: String,
    player: voice::Player,
    tx: UnboundedSender<Event>,
) {
    // 1. Stop recording + encode (blocking DSP + device close) off the runtime.
    let cap = match tokio::task::spawn_blocking(move || session.finish()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!(
                "capture: {e}"
            ))));
            return;
        }
        Err(e) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!(
                "capture join: {e}"
            ))));
            return;
        }
    };
    if cap.seconds < 0.3 {
        let _ = tx.send(Event::Voice(event::VoiceMsg::Error(
            "recording too short".into(),
        )));
        return;
    }

    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!("{e}"))));
            return;
        }
    };

    // 2. Transcribe.
    let text = match client.stt_transcribe(&cap.wav).await {
        Ok(t) => t,
        Err(e) => {
            let _ = tx.send(Event::Voice(event::VoiceMsg::Error(format!("stt: {e}"))));
            return;
        }
    };
    if text.trim().is_empty() {
        let _ = tx.send(Event::Voice(event::VoiceMsg::Error(
            "didn't catch that".into(),
        )));
        return;
    }

    // 3. Inject the recognized utterance as the user's turn (the reducer runs
    //    begin_user_send + flips the phase to Thinking) — and append it to the
    //    converse history so the model sees it (mirrors the typed-send path).
    let _ = tx.send(Event::Voice(event::VoiceMsg::Transcribed(text.clone())));
    history.push(("user".to_string(), text.clone()));

    // 4. Run the operator turn over the shared converse path + speak the reply.
    converse_send(text, conversation_id, history, owner, Some(player), tx).await;
}

/// Subscribe to this pui's agent-intent SSE stream (P12b / D-002 A6 —
/// tui:dispatch) and forward each intent as `Event::TuiIntent` (applied in the
/// reducer). Long-lived; resubscribes if the stream drops. A missing backend
/// ends the task quietly.
async fn tui_intent_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    let owner = workbench::workbench_owner();
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_intents(&owner).await {
            Ok(rx) => rx,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        while let Some(fr) = sub.recv().await {
            if fr.event != "message" {
                continue; // heartbeat etc.
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                let id = v.get("id").and_then(|x| x.as_i64());
                let intent = v.get("intent").and_then(|x| x.as_str()).map(String::from);
                if let (Some(id), Some(intent)) = (id, intent) {
                    let args = v.get("args").cloned().unwrap_or(serde_json::Value::Null);
                    if tx.send(Event::TuiIntent { id, intent, args }).is_err() {
                        return;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// POST applied agent-intent results back to the operator (P12b / tui:dispatch).
async fn intent_result_poster(mut rx: UnboundedReceiver<(i64, String, Option<String>)>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    while let Some((id, result_json, error)) = rx.recv().await {
        let _ = client
            .post_intent_result(id, &result_json, error.as_deref())
            .await;
    }
}

/// Wire up the push-driven data layer (D-003, no polling). `refetch_loop` fetches
/// everything once on startup, then again whenever the invalidation loop signals
/// (debounced) or the slow safety timer fires. `invalidation_loop` subscribes to
/// `/api/zero-harness/sse` over IPC and pings the refetch loop on each
/// `invalidate`/`update`. They run as two tasks over two IPC connections; the
/// refetch loop is the only thing that touches `active_harness`/`active_doc`.
fn spawn_sync(
    tx: UnboundedSender<Event>,
    active_harness: Arc<Mutex<String>>,
    active_doc: Arc<Mutex<Option<String>>>,
    active_plan: Arc<Mutex<Option<(String, String)>>>,
    network_focus: Option<String>,
) {
    // Internal signal channel: invalidation_loop → refetch_loop ("something changed").
    let (sig_tx, sig_rx) = mpsc::unbounded_channel::<()>();
    tokio::spawn(refetch_loop(
        tx.clone(),
        active_harness,
        active_doc,
        active_plan,
        network_focus,
        sig_rx,
    ));
    // Coord-inbox push (P-002 / D-003b): a 3rd task on its own SSE stream.
    tokio::spawn(coord_inbox_loop(tx.clone()));
    // Live worker-activity overlay (pui-fleet-status-view-2026-06-04, P1): a 4th
    // task on the /api/activity/stream SSE → Event::ActivityLive.
    tokio::spawn(activity_loop(tx.clone()));
    tokio::spawn(invalidation_loop(tx, sig_tx));
}

/// Subscribe to `/api/activity/stream` (the worker-integration bridge) and
/// forward each `activity` frame as `Event::ActivityLive` (prepended to the Fleet
/// activity feed, P1). The stream pushes only rows that arrive AFTER connect —
/// history is seeded by the `activity:recent` backfill in `refetch_all`. Long-
/// lived; resubscribes if the stream drops. A missing backend ends it quietly.
async fn activity_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_activity().await {
            Ok(rx) => rx,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        while let Some(fr) = sub.recv().await {
            if fr.event != "activity" {
                continue; // heartbeat etc.
            }
            if let Ok(row) = serde_json::from_str::<models::ActivityRow>(&fr.data) {
                if tx.send(Event::ActivityLive(row)).is_err() {
                    return;
                }
            }
        }
        // Stream ended (upstream closed / dropped) → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Subscribe to `/api/operator/state-snapshot` (the state-channel SSE) and
/// forward each `snapshot` frame as `Event::CardSnapshot` — the open
/// `chat:ask_choice` cards the operator brain raises mid-turn (sentinel-tui-
/// shared-backend-and-cards-2026-06-22 Phase 2a). Resolves the active workspace
/// once up front (the `/card-response` defense-in-depth gate). Long-lived;
/// resubscribes if the stream drops. A missing backend ends it quietly.
async fn card_snapshot_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    // Resolve the active workspace once so card answers can carry the gate.
    // Best-effort: `None` (dev / unscoped) just omits `expectedWorkspaceId`.
    let ws = client.current_workspace().await.ok().flatten();
    if tx.send(Event::CardWorkspace(ws)).is_err() {
        return;
    }
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_state_snapshot().await {
            Ok(rx) => rx,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        while let Some(fr) = sub.recv().await {
            if fr.event != "snapshot" {
                continue; // heartbeat etc.
            }
            if let Some(env) = card_view::SnapshotEnvelope::from_json(&fr.data) {
                if tx.send(Event::CardSnapshot(env)).is_err() {
                    return;
                }
            }
        }
        // Stream ended → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// POST a card answer to `/card-response` (sentinel-tui-shared-backend-and-cards
/// Phase 2a). The server resolves the brain's blocked tool call with the pick;
/// a fresh state-snapshot then drops the card from `openCards`. Best-effort — a
/// transport failure surfaces as `Event::ChatError` (the card was already
/// optimistically dismissed; the next snapshot reconciles if the POST didn't
/// land). `conversation_id` only feeds the route's audit segment.
async fn card_respond_send(
    conversation_id: Option<String>,
    correlation_id: String,
    workspace_id: Option<String>,
    action: String,
    payload: Option<serde_json::Value>,
    tx: UnboundedSender<Event>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::ChatError(format!("card-response: {e}")));
            return;
        }
    };
    // The route needs SOME :id segment; the correlator looks up by correlationId.
    let conv = conversation_id.unwrap_or_default();
    // The route's `expectedWorkspaceId` gate is required server-side (the body
    // validator rejects an empty workspaceId). Fall back to the unscoped '*'
    // marker when we couldn't resolve one — the correlator's workspace check
    // skips when the gate matches the card's own workspace; an unresolved
    // workspace means a dev/unscoped session where the card registered under
    // the same activeWorkspaceId() this client reads.
    let ws = workspace_id.unwrap_or_else(|| "*".to_string());
    if let Err(e) = client
        .card_respond(&conv, &correlation_id, &ws, &action, payload, None)
        .await
    {
        let _ = tx.send(Event::ChatError(format!("card-response: {e}")));
    }
}

/// Debounced view-state persistence (P12 / D-002). Receives a `ViewState`
/// snapshot per nav change, coalesces a burst within an 800ms window, and PUTs
/// the latest via its own backend client. Best-effort — a failed save is dropped
/// (the next nav change retries); a missing backend ends the task quietly.
async fn view_state_saver(mut rx: UnboundedReceiver<models::ViewState>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(_) => return,
    };
    let owner = workbench::workbench_owner();
    while let Some(mut latest) = rx.recv().await {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(800)) => break,
                next = rx.recv() => match next {
                    Some(v) => latest = v,
                    None => break,
                },
            }
        }
        let _ = client.put_view_state(&owner, &latest).await;
    }
}

/// Owns an `OperatorClient`; fetches the full view set on startup, then on each
/// debounced signal from the invalidation loop and on a slow safety interval.
async fn refetch_loop(
    tx: UnboundedSender<Event>,
    active_harness: Arc<Mutex<String>>,
    active_doc: Arc<Mutex<Option<String>>>,
    active_plan: Arc<Mutex<Option<(String, String)>>>,
    network_focus: Option<String>,
    mut sig_rx: UnboundedReceiver<()>,
) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("client init: {e}")));
            return;
        }
    };

    // Initial load.
    refetch_all(&client, &tx, &active_harness, &active_doc, &active_plan).await;
    if let Some(key) = &network_focus {
        // hive-pane: re-pull the drill-in dossier (beacon history + ask
        // log, P-014 item 2) on the same push-driven cadence — the
        // network.hive.* writers fire SSE invalidates on this stream.
        tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
    }
    // Seed notification history once from the toast-log (P8); live
    // `attention.notify` events prepend to it as they arrive.
    match client.recent_toasts(50).await {
        Ok(h) => {
            let _ = tx.send(Event::ToastHistory(h));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("toast-log: {e}")));
        }
    }

    // Restore the persisted workbench view-state once, after the initial data
    // load so selections land against populated lists (P12 / D-002).
    match client.get_view_state(&workbench::workbench_owner()).await {
        Ok(vs) => {
            let _ = tx.send(Event::ViewStateLoaded(vs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("view-state: {e}")));
        }
    }

    // Safety net only — a slow fallback in case we ever miss an SSE invalidate.
    // This is NOT a poll: it fires once a minute, not on a tight loop.
    let mut safety = tokio::time::interval(Duration::from_secs(60));
    safety.tick().await; // consume the immediate first tick.

    loop {
        tokio::select! {
            sig = sig_rx.recv() => {
                if sig.is_none() {
                    break; // invalidation loop gone → nothing left to drive us.
                }
                // Debounce a burst of invalidations into one refetch.
                tokio::time::sleep(Duration::from_millis(250)).await;
                while sig_rx.try_recv().is_ok() {}
                refetch_all(&client, &tx, &active_harness, &active_doc, &active_plan).await;
        if let Some(key) = &network_focus {
            // hive-pane: drill-in dossier rides the same cadence (P-014 item 2).
            tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
        }
            }
            _ = safety.tick() => {
                refetch_all(&client, &tx, &active_harness, &active_doc, &active_plan).await;
        if let Some(key) = &network_focus {
            // hive-pane: drill-in dossier rides the same cadence (P-014 item 2).
            tokio::spawn(hive_dossier_fetch(key.clone(), tx.clone()));
        }
            }
        }
        if tx.is_closed() {
            break;
        }
    }
}

/// Subscribe to `/api/zero-harness/sse` via the active transport (IPC or HTTP —
/// `client.subscribe_sse` yields a uniform `SseFrame` stream either way). On each
/// `invalidate`/`update` frame, ping `sig_tx` so the refetch loop reloads; an
/// `attention.notify` payload also becomes an `Event::Notify` (P8). The stream is
/// long-lived; if it ends we resubscribe.
async fn invalidation_loop(tx: UnboundedSender<Event>, sig_tx: UnboundedSender<()>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("sync client init: {e}")));
            return;
        }
    };

    loop {
        if sig_tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_sse("/api/zero-harness/sse").await {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("sse subscribe: {e}")));
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };

        while let Some(fr) = sub.recv().await {
            if fr.event != "invalidate" && fr.event != "update" {
                continue; // heartbeat etc.
            }
            // Payload is {name, args?, data?}. The `attention.notify` event (P8)
            // carries a ping-the-human payload in `data`.
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&fr.data) {
                if payload.get("name").and_then(|v| v.as_str()) == Some("attention.notify") {
                    if let Some(n) = parse_attention_notify(payload.get("data")) {
                        if tx.send(Event::Notify(n)).is_err() {
                            return;
                        }
                    }
                }
            }
            if sig_tx.send(()).is_err() {
                return; // refetch loop gone.
            }
        }

        // Stream ended (upstream closed / dropped) → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Subscribe to `/api/coord/inbox/sse` (P-002 / D-003b): on each wake, refetch
/// the human-facing coord inbox and emit `Event::Notify` for entries not seen
/// before. The first fetch only seeds the seen-set (no startup storm). No polling
/// — the wake is the `coord_inbox` NOTIFY, surfaced as an SSE invalidate.
async fn coord_inbox_loop(tx: UnboundedSender<Event>) {
    let client = match OperatorClient::from_discovery().await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Event::Error(format!("coord-inbox client init: {e}")));
            return;
        }
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seeded = false;
    loop {
        if tx.is_closed() {
            return;
        }
        let mut sub = match client.subscribe_sse("/api/coord/inbox/sse").await {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx.send(Event::Error(format!("coord-inbox sse: {e}")));
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        // Fetch once on (re)connect; the first fetch only seeds (no notify).
        coord_inbox_fetch(&client, &tx, &mut seen, &mut seeded).await;
        while let Some(fr) = sub.recv().await {
            if fr.event != "invalidate" && fr.event != "update" {
                continue; // heartbeat
            }
            coord_inbox_fetch(&client, &tx, &mut seen, &mut seeded).await;
        }
        // Stream ended → resubscribe shortly.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Refetch the human-facing coord inbox; emit `Event::Notify` for newly-seen
/// entries (only after the seed load). Mutates `seen`/`seeded`.
async fn coord_inbox_fetch(
    client: &OperatorClient,
    tx: &UnboundedSender<Event>,
    seen: &mut std::collections::HashSet<String>,
    seeded: &mut bool,
) {
    match client.coord_inbox().await {
        Ok(items) => {
            for m in &items {
                if m.msg_id.is_empty() {
                    continue;
                }
                if seen.insert(m.msg_id.clone()) && *seeded {
                    let _ = tx.send(Event::Notify(coord_msg_to_notif(m)));
                }
            }
            *seeded = true;
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("coord-inbox: {e}")));
        }
    }
}

/// Map a human-facing coord inbox entry to a notification (P-002).
fn coord_msg_to_notif(m: &models::CoordMsg) -> models::Notif {
    let who = m.from.clone().unwrap_or_else(|| "coord".to_string());
    let body = m
        .summary
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| m.kind.clone());
    models::Notif {
        level: if m.kind.is_empty() {
            "coord".to_string()
        } else {
            m.kind.clone()
        },
        message: format!("{who}: {body}"),
        harness: m.harness_slug.clone(),
        ts: if m.ts.is_empty() {
            None
        } else {
            Some(m.ts.clone())
        },
    }
}

/// Map an `attention.notify` payload (`{kind,title,body,harnessSlug,importance,…}`)
/// into a `Notif`. Returns None if the payload is absent/unusable.
fn parse_attention_notify(data: Option<&serde_json::Value>) -> Option<models::Notif> {
    let d = data?;
    let title = d
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("(attention)");
    let body = d.get("body").and_then(|v| v.as_str()).unwrap_or("");
    let level = d
        .get("importance")
        .and_then(|v| v.as_str())
        .or_else(|| d.get("kind").and_then(|v| v.as_str()))
        .unwrap_or("attention")
        .to_string();
    let harness = d
        .get("harnessSlug")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let message = if body.is_empty() {
        title.to_string()
    } else {
        format!("{title} — {body}")
    };
    Some(models::Notif {
        level,
        message,
        harness,
        ts: None,
    })
}

/// Fetch every panel's data and forward as `Event`s. Errors per-query become
/// `Event::Error` so one failing endpoint doesn't sink the rest.
async fn refetch_all(
    client: &OperatorClient,
    tx: &UnboundedSender<Event>,
    active_harness: &Arc<Mutex<String>>,
    active_doc: &Arc<Mutex<Option<String>>>,
    active_plan: &Arc<Mutex<Option<(String, String)>>>,
) {
    match client.plans_typed().await {
        Ok(p) => {
            let _ = tx.send(Event::Plans(p));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plans: {e}")));
        }
    }
    match client.roster_typed().await {
        Ok((active, pending)) => {
            let _ = tx.send(Event::Roster { active, pending });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("roster: {e}")));
        }
    }
    // Fleet rate/usage read-model (Overview top-bar, Brief 23 P-005). Quietly
    // optional: a host predating rate-limit-layer-v2 has no route — the
    // top-bar renders dashes rather than the status bar toasting every poll.
    if let Ok(s) = client.fleet_rate_status().await {
        let _ = tx.send(Event::FleetRate(s));
    }
    // Deployed cloud frames (per-frame dock tabs, hive-agent-tabs P-013).
    // Quietly optional: nothing deployed / an older host → no tabs, no toasts.
    if let Ok(fr) = client.deploy_frames().await {
        let _ = tx.send(Event::Frames(fr));
    }
    // The cross-Hive network board (hive-network-surface B-09): pinned-C-3
    // rows from B-08's data endpoint, riding this loop's standard cadence
    // (SSE invalidate + 60s safety net). Quietly optional: a host without the
    // endpoint renders the pane's empty state, no status-bar toast per pass.
    if let Ok(rows) = client.network_board().await {
        let _ = tx.send(Event::NetworkBoard(rows));
    }
    match client.attention_typed().await {
        Ok(i) => {
            let _ = tx.send(Event::Inbox(i));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("inbox: {e}")));
        }
    }
    // Harness list (for the selector).
    match client.harnesses().await {
        Ok(hs) => {
            let _ = tx.send(Event::Harnesses(hs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("harnesses: {e}")));
        }
    }
    // Features + issues for whichever harness is active (shared cell, updated by
    // the reducer when the user cycles with [ / ]).
    let slug = active_harness
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "papercup".to_string());
    match client.features_for(&slug).await {
        Ok(fs) => {
            let _ = tx.send(Event::Features(fs));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("features: {e}")));
        }
    }
    match client.issues_for(&slug).await {
        Ok(is) => {
            let _ = tx.send(Event::Issues(is));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("issues: {e}")));
        }
    }
    // Docs for the active harness + selected doc (None → server default).
    let doc = active_doc.lock().ok().and_then(|g| g.clone());
    match client.docs_for(&slug, doc.as_deref()).await {
        Ok(d) => {
            let _ = tx.send(Event::Docs(d));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("docs: {e}")));
        }
    }
    match client.testing_domains(&slug).await {
        Ok(t) => {
            let _ = tx.send(Event::Testing(t));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing: {e}")));
        }
    }
    match client.claude_settings_effective(&slug).await {
        Ok(c) => {
            let _ = tx.send(Event::Config(c));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("config: {e}")));
        }
    }
    // Plugin-contributed TUI panes for the active harness (D-002).
    match client.tui_panes_for(&slug).await {
        Ok(p) => {
            let _ = tx.send(Event::TuiPanes(p));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("tui_panes: {e}")));
        }
    }
    // Installed plugin manifests for the Plugins tab (D-007/D-014). Global, not
    // per-harness, but refetched with the rest on each invalidate.
    match client.plugins_global().await {
        Ok(p) => {
            let _ = tx.send(Event::Plugins(p));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("plugins: {e}")));
        }
    }
    // Operator feature flags for the read-only Settings tab (P10). Global — not
    // per-harness — but refetched with the rest on each invalidate.
    match client.flags().await {
        Ok(f) => {
            let _ = tx.send(Event::Flags(f));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("flags: {e}")));
        }
    }
    // Read-only operator-config overview for the Settings tab (P10b): AI backend +
    // per-role models + connected speech providers. Global; refetched with the rest.
    match client.operator_config().await {
        Ok(c) => {
            let _ = tx.send(Event::OperatorConfig(c));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("operator-config: {e}")));
        }
    }
    // Plan-item assignment/claim/liveness for the SELECTED plan (P-005a). A per-plan
    // endpoint, so only the plan the user has focused (published by the reducer while
    // the Plans tab is active) is fetched; None off-tab → skip the request entirely.
    let sel_plan = active_plan.lock().ok().and_then(|g| g.clone());
    if let Some((h, p)) = sel_plan {
        match client.plan_item_states(&h, &p).await {
            Ok(s) => {
                let _ = tx.send(Event::PlanItemStates(s));
            }
            Err(e) => {
                let _ = tx.send(Event::Error(format!("plan-item-states: {e}")));
            }
        }
    }
    // Fleet status view (pui-fleet-status-view-2026-06-04): fleet-wide work items
    // (P0) + a recent-activity backfill seeding the overlay (P1; the live feed
    // rides the activity SSE) + a kind=todos backfill for worker-todo mirroring
    // (P2). Global — not per-harness — reconciled with the rest on each refetch.
    match client.work_items_list().await {
        Ok(w) => {
            let _ = tx.send(Event::WorkItems(w));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("work_items: {e}")));
        }
    }
    match client.activity_recent(None, 200).await {
        Ok(a) => {
            let _ = tx.send(Event::ActivitySeed(a));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("activity: {e}")));
        }
    }
    match client.activity_recent(Some("todos"), 50).await {
        Ok(a) => {
            let _ = tx.send(Event::ActivityTodos(a));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("activity-todos: {e}")));
        }
    }
    // The Memory tab's list (D-006 Step 2). `ok:false` (backend unavailable —
    // mem0 unconfigured, auth missing) is an EXPECTED state the tab renders as
    // its empty state, so errors are quiet here too.
    match client.memory_list(Some(&slug)).await {
        Ok(p) => {
            let _ = tx.send(Event::Memories {
                available: p.ok,
                results: p.results,
            });
        }
        Err(_) => {
            let _ = tx.send(Event::Memories {
                available: false,
                results: Vec::new(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coord_msg(
        kind: &str,
        from: Option<&str>,
        summary: Option<&str>,
        harness: Option<&str>,
    ) -> models::CoordMsg {
        models::CoordMsg {
            ts: "2026-06-04T16:00:00Z".into(),
            msg_id: "m-1".into(),
            kind: kind.into(),
            from: from.map(|s| s.into()),
            summary: summary.map(|s| s.into()),
            harness_slug: harness.map(|s| s.into()),
        }
    }

    #[test]
    fn coord_msg_maps_to_notif() {
        let n = coord_msg_to_notif(&coord_msg(
            "message",
            Some("su-30a41"),
            Some("review the carve"),
            Some("papercup"),
        ));
        assert_eq!(n.level, "message");
        assert_eq!(n.message, "su-30a41: review the carve");
        assert_eq!(n.harness.as_deref(), Some("papercup"));
        assert_eq!(n.ts.as_deref(), Some("2026-06-04T16:00:00Z"));
    }

    #[test]
    fn coord_msg_falls_back_to_kind_and_coord() {
        // no `from`, empty summary → "coord: <kind>"
        let n = coord_msg_to_notif(&coord_msg("coord-escalation", None, Some(""), None));
        assert_eq!(n.message, "coord: coord-escalation");
        assert_eq!(n.level, "coord-escalation");
        assert_eq!(n.harness, None);
    }
}
