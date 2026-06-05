//! Voice tab — P2P voice channels UI (holepunch-voice-channels-2026-06-05
//! P-008/P-009/P-017).
//!
//! Self-contained on purpose: ALL voice-tab state/keys/rendering live here so
//! the contended `app.rs`/`ui.rs`/`event.rs` only carry one-line hooks
//! (division with voice-realtime-tui agreed via coord 2026-06-05 — they own
//! the operator Conv-AI MODE on the dock; this tab owns user↔user channels).
//!
//! Data flows over the operator voice socket via `voice_stream.rs`:
//!   keys → `VoiceCmd` (executed by the run loop, which owns the socket)
//!   socket events → `VoiceUiEvent` (applied by the reducer here).

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    text::{Line, Span},
    widgets::{Clear, List, ListItem, ListState, Paragraph},
    Frame,
};

use crate::theme::Theme;
use crate::voice_stream::{VoiceEvent, VoiceStatus};

// ---------------------------------------------------------------- state

/// A registry channel row (mirror of the operator's `{ev:'channels'}` payload).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct VoiceChannelRow {
    pub id: String,
    pub name: String,
}

/// The editable P-016 settings subset (P-017 view). Mirrors voice-prefs fields.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, Default)]
pub struct VoicePrefsView {
    #[serde(default, rename = "voiceInputMode")]
    pub input_mode: String,
    #[serde(default, rename = "voicePttKey")]
    pub ptt_key: String,
    #[serde(default, rename = "voiceAec")]
    pub aec: bool,
    #[serde(default, rename = "voiceNoiseSuppression")]
    pub noise_suppression: bool,
    #[serde(default = "one", rename = "voiceInputGain")]
    pub input_gain: f64,
    #[serde(default = "one", rename = "voiceOutputVolume")]
    pub output_volume: f64,
}
fn one() -> f64 {
    1.0
}

/// Settings rows the overlay can edit (j/k + Enter / +/-).
pub const SETTINGS_ROWS: [&str; 6] = [
    "input mode",
    "PTT key",
    "echo cancel (AEC)",
    "noise suppression",
    "input gain",
    "output volume",
];

#[derive(Debug, Default)]
pub struct VoiceUiState {
    pub connected: bool,
    pub channels: Vec<VoiceChannelRow>,
    pub sel: usize,
    pub status: Option<VoiceStatus>,
    pub error: Option<String>,
    pub mic_on: bool,
    pub mic_level: f32,
    /// Create-channel composer ('n').
    pub composing: bool,
    pub compose_input: String,
    /// P-017 settings overlay ('s').
    pub settings_open: bool,
    pub settings_sel: usize,
    pub prefs: Option<VoicePrefsView>,
}

/// What the run loop must execute (it owns the VoiceStream socket + client).
#[derive(Debug, Clone, PartialEq)]
pub enum VoiceCmd {
    /// Ensure the socket is connected + refresh the channel list.
    Connect,
    Join(String),
    Leave,
    SetMuted(bool),
    MicOn,
    MicOff,
    Create(String),
    /// Fetch prefs for the settings overlay (operator:voice_prefs get).
    PrefsGet,
    /// Patch one pref field (operator:voice_prefs set).
    PrefsSet(&'static str, serde_json::Value),
}

/// Socket/run-loop happenings folded into the reducer.
#[derive(Debug, Clone, PartialEq)]
pub enum VoiceUiEvent {
    Connected(bool),
    Stream(VoiceEvent),
    Channels(Vec<VoiceChannelRow>),
    MicLevel(f32),
    MicState(bool),
    Prefs(VoicePrefsView),
    Error(String),
}

// ---------------------------------------------------------------- reducer

pub fn apply_event(s: &mut VoiceUiState, ev: VoiceUiEvent) {
    match ev {
        VoiceUiEvent::Connected(ok) => {
            s.connected = ok;
            if !ok {
                s.mic_on = false;
            }
        }
        VoiceUiEvent::Stream(VoiceEvent::Status(st)) => {
            s.error = None;
            s.status = Some(st);
        }
        VoiceUiEvent::Stream(VoiceEvent::Error(e)) => s.error = Some(e),
        VoiceUiEvent::Stream(VoiceEvent::Disconnected) => {
            s.connected = false;
            s.mic_on = false;
            s.error = Some("voice socket disconnected".into());
        }
        VoiceUiEvent::Channels(list) => {
            s.channels = list;
            if s.sel >= s.channels.len() {
                s.sel = s.channels.len().saturating_sub(1);
            }
        }
        VoiceUiEvent::MicLevel(l) => s.mic_level = l,
        VoiceUiEvent::MicState(on) => s.mic_on = on,
        VoiceUiEvent::Prefs(p) => s.prefs = Some(p),
        VoiceUiEvent::Error(e) => s.error = Some(e),
    }
}

// ---------------------------------------------------------------- keys

/// Handle a key on the Voice tab. `Some(cmd)` → run loop executes; `None` →
/// local state changed (or no-op); caller re-renders either way.
pub fn handle_key(s: &mut VoiceUiState, code: KeyCode, _mods: KeyModifiers) -> Option<VoiceCmd> {
    // Create-channel composer captures input first.
    if s.composing {
        match code {
            KeyCode::Esc => {
                s.composing = false;
                s.compose_input.clear();
            }
            KeyCode::Enter => {
                let name = s.compose_input.trim().to_string();
                s.composing = false;
                s.compose_input.clear();
                if !name.is_empty() {
                    return Some(VoiceCmd::Create(name));
                }
            }
            KeyCode::Backspace => {
                s.compose_input.pop();
            }
            KeyCode::Char(c) => s.compose_input.push(c),
            _ => {}
        }
        return None;
    }
    // Settings overlay (P-017).
    if s.settings_open {
        let Some(p) = s.prefs.clone() else {
            if code == KeyCode::Esc {
                s.settings_open = false;
            }
            return None;
        };
        match code {
            KeyCode::Esc | KeyCode::Char('s') => s.settings_open = false,
            KeyCode::Char('j') | KeyCode::Down => {
                s.settings_sel = (s.settings_sel + 1) % SETTINGS_ROWS.len();
            }
            KeyCode::Char('k') | KeyCode::Up => {
                s.settings_sel = (s.settings_sel + SETTINGS_ROWS.len() - 1) % SETTINGS_ROWS.len();
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                return match s.settings_sel {
                    0 => {
                        let next = if p.input_mode == "ptt" {
                            "open-mic"
                        } else {
                            "ptt"
                        };
                        Some(VoiceCmd::PrefsSet(
                            "voiceInputMode",
                            serde_json::json!(next),
                        ))
                    }
                    2 => Some(VoiceCmd::PrefsSet("voiceAec", serde_json::json!(!p.aec))),
                    3 => Some(VoiceCmd::PrefsSet(
                        "voiceNoiseSuppression",
                        serde_json::json!(!p.noise_suppression),
                    )),
                    _ => None, // PTT key + gains edit via +/- below
                };
            }
            KeyCode::Char('+') | KeyCode::Char('=') => {
                return match s.settings_sel {
                    4 => Some(VoiceCmd::PrefsSet(
                        "voiceInputGain",
                        serde_json::json!(((p.input_gain + 0.1) * 10.0).round() / 10.0),
                    )),
                    5 => Some(VoiceCmd::PrefsSet(
                        "voiceOutputVolume",
                        serde_json::json!(((p.output_volume + 0.1) * 10.0).round() / 10.0),
                    )),
                    _ => None,
                };
            }
            KeyCode::Char('-') => {
                return match s.settings_sel {
                    4 => Some(VoiceCmd::PrefsSet(
                        "voiceInputGain",
                        serde_json::json!((((p.input_gain - 0.1).max(0.0)) * 10.0).round() / 10.0),
                    )),
                    5 => Some(VoiceCmd::PrefsSet(
                        "voiceOutputVolume",
                        serde_json::json!(
                            (((p.output_volume - 0.1).max(0.0)) * 10.0).round() / 10.0
                        ),
                    )),
                    _ => None,
                };
            }
            _ => {}
        }
        return None;
    }
    // Main tab keys.
    match code {
        KeyCode::Char('j') | KeyCode::Down => {
            if !s.channels.is_empty() {
                s.sel = (s.sel + 1) % s.channels.len();
            }
            None
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if !s.channels.is_empty() {
                s.sel = (s.sel + s.channels.len() - 1) % s.channels.len();
            }
            None
        }
        KeyCode::Enter => {
            if !s.connected {
                return Some(VoiceCmd::Connect);
            }
            s.channels.get(s.sel).map(|c| VoiceCmd::Join(c.id.clone()))
        }
        KeyCode::Char('l') => in_channel(s).then_some(VoiceCmd::Leave),
        KeyCode::Char('m') => {
            let muted = s.status.as_ref().map(|st| st.muted).unwrap_or(false);
            in_channel(s).then_some(VoiceCmd::SetMuted(!muted))
        }
        // PTT / transmit toggle (P-009; key matches the voiceInputMode=ptt default).
        KeyCode::Char('v') => {
            if !in_channel(s) {
                return None;
            }
            Some(if s.mic_on {
                VoiceCmd::MicOff
            } else {
                VoiceCmd::MicOn
            })
        }
        KeyCode::Char('r') => Some(VoiceCmd::Connect), // (re)connect + refresh
        KeyCode::Char('n') => {
            s.composing = true;
            None
        }
        KeyCode::Char('s') => {
            s.settings_open = true;
            s.settings_sel = 0;
            Some(VoiceCmd::PrefsGet)
        }
        _ => None,
    }
}

fn in_channel(s: &VoiceUiState) -> bool {
    s.status
        .as_ref()
        .map(|st| st.channel.is_some())
        .unwrap_or(false)
}

/// Will the Voice tab consume this key? When an overlay is open it captures
/// everything; otherwise only the keys it acts on. Keys it doesn't own (digits,
/// tab-switch letters, `?`/`:`/`<`/`>`…) return false so `on_key` falls through
/// to the global dispatch — that's how tab-switching still works from this tab.
pub fn owns_key(s: &VoiceUiState, code: KeyCode) -> bool {
    if s.composing || s.settings_open {
        return true;
    }
    matches!(
        code,
        KeyCode::Up
            | KeyCode::Down
            | KeyCode::Enter
            | KeyCode::Char('j')
            | KeyCode::Char('k')
            | KeyCode::Char('l')
            | KeyCode::Char('m')
            | KeyCode::Char('n')
            | KeyCode::Char('r')
            | KeyCode::Char('s')
            | KeyCode::Char('v')
    )
}

// ---------------------------------------------------------------- render

pub fn draw_voice(f: &mut Frame, s: &VoiceUiState, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
        .split(area);

    // Channels list (left).
    let items: Vec<ListItem> = if s.channels.is_empty() {
        vec![ListItem::new(if s.connected {
            "(no channels — press n to create)"
        } else {
            "(press Enter or r to connect)"
        })]
    } else {
        s.channels
            .iter()
            .map(|c| {
                let active = s
                    .status
                    .as_ref()
                    .and_then(|st| st.channel.as_ref())
                    .map(|ch| ch.id == c.id)
                    .unwrap_or(false);
                let marker = if active {
                    format!("{} ", crate::glyph::toggle::ON)
                } else {
                    "  ".to_string()
                };
                ListItem::new(format!("{marker}{}", c.name))
            })
            .collect()
    };
    let mut ls = ListState::default();
    if !s.channels.is_empty() {
        ls.select(Some(s.sel));
    }
    let ltitle = format!(
        " Voice channels {} ",
        if s.connected { "" } else { "(disconnected)" }
    );
    f.render_stateful_widget(
        List::new(items)
            .style(Theme::panel())
            .block(Theme::block(Line::from(ltitle), s.connected))
            .highlight_style(Theme::selected()),
        cols[0],
        &mut ls,
    );

    // In-channel panel (right): peers + transmit state + hints.
    let mut lines: Vec<Line> = Vec::new();
    match s.status.as_ref().and_then(|st| st.channel.as_ref()) {
        Some(ch) => {
            let muted = s.status.as_ref().map(|st| st.muted).unwrap_or(false);
            lines.push(Line::from(vec![
                Span::styled(format!("# {}", ch.name), Theme::title()),
                if muted {
                    Span::styled("   [muted]", Theme::warn())
                } else {
                    Span::raw("")
                },
            ]));
            let level = (s.mic_level * 30.0).round() as usize;
            let meter: String = "█".repeat(level.min(30));
            lines.push(Line::from(vec![
                Span::raw("mic "),
                Span::styled(
                    if s.mic_on { "ON " } else { "off" },
                    if s.mic_on {
                        Theme::success()
                    } else {
                        Theme::dim()
                    },
                ),
                Span::raw("  "),
                Span::styled(format!("{meter:<30}"), Theme::success()),
            ]));
            lines.push(Line::from(""));
            let peers = s
                .status
                .as_ref()
                .map(|st| st.peers.clone())
                .unwrap_or_default();
            if peers.is_empty() {
                lines.push(Line::from(Span::styled(
                    "(no peers yet — they join via this channel on their box)",
                    Theme::dim(),
                )));
            } else {
                for p in &peers {
                    let glyph = if p.speaking {
                        "🗣"
                    } else if p.muted {
                        "🔇"
                    } else {
                        "•"
                    };
                    lines.push(Line::from(vec![
                        Span::styled(
                            glyph,
                            if p.speaking {
                                Theme::info()
                            } else {
                                Theme::dim()
                            },
                        ),
                        Span::raw(format!(" {}", p.label)),
                    ]));
                }
            }
        }
        None => {
            lines.push(Line::from(Span::styled("Not in a channel.", Theme::dim())));
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "Enter join · n new · r refresh · s settings",
                Theme::info(),
            )));
        }
    }
    if let Some(e) = &s.error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("{} {e}", crate::glyph::severity::WARN),
            Theme::danger(),
        )));
    }
    let rtitle = " Channel  (v talk · m mute · l leave · s settings) ";
    f.render_widget(
        Paragraph::new(lines)
            .style(Theme::panel())
            .block(Theme::block(Line::from(rtitle), in_channel(s))),
        cols[1],
    );

    // Create-channel composer overlay.
    if s.composing {
        let r = centered(area, 50, 3);
        f.render_widget(Clear, r);
        f.render_widget(
            Paragraph::new(format!("> {}", s.compose_input))
                .style(Theme::input())
                .block(Theme::popup_block(Line::from(
                    " New channel name (Enter/Esc) ",
                ))),
            r,
        );
    }

    // Settings overlay (P-017).
    if s.settings_open {
        let r = centered(area, 56, (SETTINGS_ROWS.len() + 2) as u16);
        f.render_widget(Clear, r);
        let p = s.prefs.clone().unwrap_or_default();
        let vals = [
            p.input_mode.clone(),
            p.ptt_key.clone(),
            if p.aec { "on".into() } else { "off".into() },
            if p.noise_suppression {
                "on".into()
            } else {
                "off".into()
            },
            format!("{:.1}", p.input_gain),
            format!("{:.1}", p.output_volume),
        ];
        let items: Vec<ListItem> = SETTINGS_ROWS
            .iter()
            .zip(vals.iter())
            .map(|(k, v)| ListItem::new(format!("{k:<22}{v}")))
            .collect();
        let mut ls = ListState::default();
        ls.select(Some(s.settings_sel));
        f.render_stateful_widget(
            List::new(items)
                .style(Theme::popup())
                .block(Theme::popup_block(Line::from(
                    " Voice settings (Enter toggle · +/- gain · Esc) ",
                )))
                .highlight_style(Theme::selected()),
            r,
            &mut ls,
        );
    }
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_stream::{VoiceChannelInfo, VoicePeer};
    use ratatui::{backend::TestBackend, Terminal};

    fn chan(id: &str, name: &str) -> VoiceChannelRow {
        VoiceChannelRow {
            id: id.into(),
            name: name.into(),
        }
    }

    fn status_in(name: &str, peers: Vec<VoicePeer>) -> VoiceStatus {
        VoiceStatus {
            channel: Some(VoiceChannelInfo {
                id: "vc-1".into(),
                name: name.into(),
            }),
            muted: false,
            peers,
        }
    }

    #[test]
    fn nav_and_join_emit_cmds() {
        let mut s = VoiceUiState {
            connected: true,
            ..Default::default()
        };
        apply_event(
            &mut s,
            VoiceUiEvent::Channels(vec![chan("vc-1", "standup"), chan("vc-2", "pairing")]),
        );
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('j'), KeyModifiers::NONE),
            None
        );
        assert_eq!(s.sel, 1);
        assert_eq!(
            handle_key(&mut s, KeyCode::Enter, KeyModifiers::NONE),
            Some(VoiceCmd::Join("vc-2".into()))
        );
        // not connected → Enter connects instead of joining
        let mut s2 = VoiceUiState::default();
        assert_eq!(
            handle_key(&mut s2, KeyCode::Enter, KeyModifiers::NONE),
            Some(VoiceCmd::Connect)
        );
    }

    #[test]
    fn talk_mute_leave_require_channel() {
        let mut s = VoiceUiState {
            connected: true,
            ..Default::default()
        };
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('v'), KeyModifiers::NONE),
            None
        );
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('m'), KeyModifiers::NONE),
            None
        );
        apply_event(
            &mut s,
            VoiceUiEvent::Stream(VoiceEvent::Status(status_in("standup", vec![]))),
        );
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('v'), KeyModifiers::NONE),
            Some(VoiceCmd::MicOn)
        );
        apply_event(&mut s, VoiceUiEvent::MicState(true));
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('v'), KeyModifiers::NONE),
            Some(VoiceCmd::MicOff)
        );
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('m'), KeyModifiers::NONE),
            Some(VoiceCmd::SetMuted(true))
        );
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('l'), KeyModifiers::NONE),
            Some(VoiceCmd::Leave)
        );
    }

    #[test]
    fn composer_collects_name() {
        let mut s = VoiceUiState {
            connected: true,
            ..Default::default()
        };
        handle_key(&mut s, KeyCode::Char('n'), KeyModifiers::NONE);
        assert!(s.composing);
        for c in "crit".chars() {
            handle_key(&mut s, KeyCode::Char(c), KeyModifiers::NONE);
        }
        assert_eq!(
            handle_key(&mut s, KeyCode::Enter, KeyModifiers::NONE),
            Some(VoiceCmd::Create("crit".into()))
        );
        assert!(!s.composing);
    }

    #[test]
    fn settings_overlay_toggles_and_patches() {
        let mut s = VoiceUiState {
            connected: true,
            ..Default::default()
        };
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('s'), KeyModifiers::NONE),
            Some(VoiceCmd::PrefsGet)
        );
        assert!(s.settings_open);
        apply_event(
            &mut s,
            VoiceUiEvent::Prefs(VoicePrefsView {
                input_mode: "ptt".into(),
                ptt_key: "v".into(),
                aec: true,
                noise_suppression: true,
                input_gain: 1.0,
                output_volume: 1.0,
            }),
        );
        // toggle input mode ptt → open-mic
        assert_eq!(
            handle_key(&mut s, KeyCode::Enter, KeyModifiers::NONE),
            Some(VoiceCmd::PrefsSet(
                "voiceInputMode",
                serde_json::json!("open-mic")
            ))
        );
        // gain bump on row 4
        for _ in 0..4 {
            handle_key(&mut s, KeyCode::Char('j'), KeyModifiers::NONE);
        }
        assert_eq!(
            handle_key(&mut s, KeyCode::Char('+'), KeyModifiers::NONE),
            Some(VoiceCmd::PrefsSet("voiceInputGain", serde_json::json!(1.1)))
        );
        handle_key(&mut s, KeyCode::Esc, KeyModifiers::NONE);
        assert!(!s.settings_open);
    }

    #[test]
    fn renders_channel_peers_and_overlays() {
        let mut s = VoiceUiState {
            connected: true,
            ..Default::default()
        };
        apply_event(
            &mut s,
            VoiceUiEvent::Channels(vec![chan("vc-1", "standup")]),
        );
        apply_event(
            &mut s,
            VoiceUiEvent::Stream(VoiceEvent::Status(status_in(
                "standup",
                vec![
                    VoicePeer {
                        id: "b".into(),
                        label: "bob@laptop".into(),
                        muted: false,
                        speaking: true,
                    },
                    VoicePeer {
                        id: "c".into(),
                        label: "carol@nyc".into(),
                        muted: true,
                        speaking: false,
                    },
                ],
            ))),
        );
        let backend = TestBackend::new(100, 24);
        let mut term = Terminal::new(backend).unwrap();
        term.draw(|f| draw_voice(f, &s, f.area())).unwrap();
        let text = format!("{:?}", term.backend().buffer());
        assert!(text.contains("standup"));
        assert!(text.contains("bob@laptop"));
        assert!(text.contains("carol@nyc"));
        // settings overlay renders rows
        s.settings_open = true;
        s.prefs = Some(VoicePrefsView::default());
        term.draw(|f| draw_voice(f, &s, f.area())).unwrap();
        let text2 = format!("{:?}", term.backend().buffer());
        assert!(text2.contains("input mode"));
    }
}
