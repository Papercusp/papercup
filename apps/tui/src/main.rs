//! `pui` — Papercusp terminal workbench (SP-TUI, tui-workbench-ratatui-2026-06-04).
//!
//! Architecture: `App` holds state, `event` normalises inputs onto one mpsc
//! channel, `App::update` is the single reducer, `ui::draw` is a pure renderer.
//! Data is **push-driven (D-003, no polling)**: we fetch once on startup, then
//! subscribe to the operator's `/api/zero-harness/sse` invalidation stream OVER
//! IPC and refetch the affected views when an `invalidate`/`update` arrives. A
//! slow (60s) safety-net refetch is the only timer, and it is a fallback — not a
//! poll. P1 = the Create tab (Plans / Inbox / Sessions).

mod app;
mod chat_tags;
mod client;
mod companion;
mod event;
mod fleet;
mod framing;
mod http;
mod ipc;
mod layout;
mod models;
mod mux;
mod notify;
mod sse;
mod theme;
mod tutorial;
mod ui;
mod workbench;

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

use app::{Action, App};
use client::OperatorClient;
use companion::Companion;
use event::{spawn_input_listener, Event};
use mux::{Multiplexer, Zellij};

#[tokio::main]
async fn main() -> Result<()> {
    // Subcommand dispatch — bare `pui` opens the full workbench (the UX a human
    // wants from typing `pui`):
    //   pui workbench → force the zellij workbench (D-001)
    //   pui hud       → force just the HUD (what the workbench's own HUD pane runs)
    //   pui           → the workbench from a plain terminal, but just the HUD when
    //                   already inside zellij (so the HUD pane can't recursively
    //                   nest another workbench — `$ZELLIJ` is set by zellij).
    match std::env::args().nth(1).as_deref() {
        Some("workbench") => return run_workbench(),
        Some("hud") => {}
        None if std::env::var_os("ZELLIJ").is_none() => return run_workbench(),
        _ => {}
    }

    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(out))?;

    let result = run(&mut terminal).await;

    // Always restore the terminal, even on error.
    disable_raw_mode().ok();
    execute!(terminal.backend_mut(), LeaveAlternateScreen).ok();
    terminal.show_cursor().ok();
    result
}

/// Materialise the workbench layout and hand off to zellij. Replaces this
/// process's foreground with the zellij session; on exit we mirror its code.
fn run_workbench() -> Result<()> {
    let path = layout::materialize()?;
    let argv = layout::launch_argv(&path.to_string_lossy());
    let (prog, rest) = argv.split_first().expect("launch argv is never empty");
    let status = std::process::Command::new(prog).args(rest).status()?;
    std::process::exit(status.code().unwrap_or(0));
}

async fn run<B: Backend>(terminal: &mut Terminal<B>) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let mut app = App::new();
    // Show the first-run tutorial until this device has dismissed it once (P9).
    app.show_tutorial = !tutorial::seen();
    spawn_input_listener(tx.clone());
    spawn_sync(
        tx.clone(),
        app.active_harness.clone(),
        app.active_doc.clone(),
        app.active_plan.clone(),
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
    // Companion zellij plugin (P-004 / D-008): `pui`'s eyes + hands inside
    // zellij over a long-lived `zellij pipe` child. `None` when not running
    // inside zellij / without the plugin — orchestration then falls back to
    // fire-and-forget `zellij action` (below). Its events (topology, pane-exit)
    // arrive on `tx` like any other.
    let companion = Companion::spawn(tx.clone());

    terminal.draw(|f| ui::draw(f, &app))?;

    // Tracks the last notification we surfaced to the OS so we fire exactly one
    // system notification per new event (the reducer bumps notif_seq).
    let mut last_notif_seq = app.notif_seq;
    // Persist the tutorial dismissal exactly once, the first time it closes.
    let mut tutorial_persisted = !app.show_tutorial;

    while let Some(ev) = rx.recv().await {
        let is_key = matches!(ev, Event::Key(_));
        let action = app.update(ev);

        // Persist the quiet view-state on each nav change (the saver debounces).
        if is_key && action == Action::Render {
            let _ = save_tx.send(app.capture_view_state());
        }

        // Best-effort OS notification on each new attention event (P8).
        if app.notif_seq != last_notif_seq {
            last_notif_seq = app.notif_seq;
            if let Some(t) = app.toast.clone() {
                notify::os_notify("Papercusp", &t.message);
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
            Action::IntentResult { id, result_json, error } => {
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
            Action::SendChat(text) => {
                // Operator chat turn (tui-operator-surface P1). The reducer already
                // appended the user message + a streaming bubble; spawn the converse
                // task with a snapshot of the transcript + conversation id.
                tokio::spawn(converse_send(
                    text,
                    app.conversation_id.clone(),
                    app.chat_history_for_send(),
                    workbench::workbench_owner(),
                    tx.clone(),
                ));
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
            let _ = tx.send(Event::TestingFiles { domain_id, files: Vec::new() });
            return;
        }
    };
    match client.testing_domain_files(&harness, &domain_id).await {
        Ok(files) => {
            let _ = tx.send(Event::TestingFiles { domain_id, files });
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("testing files: {e}")));
            let _ = tx.send(Event::TestingFiles { domain_id, files: Vec::new() });
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
            let _ = tx.send(Event::TestRunDone { file, result: fail(format!("{e}")) });
            return;
        }
    };
    match client.testing_run(&harness, &file).await {
        Ok(result) => {
            let _ = tx.send(Event::TestRunDone { file, result });
        }
        Err(e) => {
            let _ = tx.send(Event::TestRunDone { file, result: fail(format!("{e}")) });
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
                    ls.iter().map(|l| l.name.clone()).collect::<Vec<_>>().join(", ")
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
    match client.load_earlier_turns(&conversation_id, before_seq, 200).await {
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
async fn converse_send(
    text: String,
    mut conversation_id: Option<String>,
    history: Vec<(String, String)>,
    owner: String,
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
        let _ = client.append_turn(id, "user", &text, &[]).await;
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
    // tell the pane the turn is done, and persist the assistant turn.
    let final_text = chat_tags::finalize(&raw);
    let _ = tx.send(Event::ChatDone);
    if let Some(id) = &conversation_id {
        if !final_text.trim().is_empty() || !tools.is_empty() {
            let _ = client.append_turn(id, "assistant", &final_text, &tools).await;
        }
    }
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
) {
    // Internal signal channel: invalidation_loop → refetch_loop ("something changed").
    let (sig_tx, sig_rx) = mpsc::unbounded_channel::<()>();
    tokio::spawn(refetch_loop(tx.clone(), active_harness, active_doc, active_plan, sig_rx));
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
            }
            _ = safety.tick() => {
                refetch_all(&client, &tx, &active_harness, &active_doc, &active_plan).await;
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
    let title = d.get("title").and_then(|v| v.as_str()).unwrap_or("(attention)");
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
        Ok(r) => {
            let _ = tx.send(Event::Roster(r));
        }
        Err(e) => {
            let _ = tx.send(Event::Error(format!("roster: {e}")));
        }
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
    match client.claude_settings(&slug).await {
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
    // The curator's salience feed for the Fleet curated mode (P3). A 404/absent
    // route (pre-restart, or the curator not built) is EXPECTED — the curated
    // view falls back to its local heuristic — so an error is swallowed quietly
    // here rather than surfaced as a status-bar error.
    if let Ok(s) = client.curation_feed().await {
        let _ = tx.send(Event::CuratedSignals(s));
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
