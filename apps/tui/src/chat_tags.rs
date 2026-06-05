//! Operator-turn control-tag parsing for the chat pane (tui-operator-surface).
//!
//! The operator brain wraps its user-visible utterance in `<say>…</say>` and
//! emits other control tags (`<set_mode>`, `<sleep …>`, `<continue/>`,
//! `<spawn …>`) in the SAME streamed turn. Desktop renders only the `<say>`
//! body; the TUI pane mirrors that. This is a focused Rust port of the
//! extraction half of `packages/operator-core/lib/operator-converse-tags.ts`
//! (`parseOperatorTurn`) — the parts the chat pane needs:
//!
//!   - [`finalize`]    — the user-visible text of a COMPLETED turn (say-or-fallback).
//!   - [`live_preview`] — best-effort text of an IN-PROGRESS (still streaming) turn.
//!   - [`extract_say`]  — the inner of a complete `<say>…</say>`, if present.
//!
//! Pure string work, no regex dependency: tag names are ASCII, so we scan
//! case-insensitively over bytes and slice the original `&str` at the (always
//! char-boundary) ASCII offsets.

/// The inner body of the first complete `<say>…</say>`, trimmed. `None` when
/// there's no complete say tag or the body is empty.
pub fn extract_say(raw: &str) -> Option<String> {
    let open = find_tag(raw, "<say>", 0)?;
    let after = open + "<say>".len();
    let close = find_tag(raw, "</say>", after)?;
    let inner = raw[after..close].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// The user-visible text of a COMPLETED operator turn. Mirrors
/// `parseOperatorTurn`'s say-resolution: prefer `<say>`; if the turn is a
/// going-silent `<sleep>` with no say, render nothing; else fall back to the
/// raw prose with all control tags stripped.
pub fn finalize(raw: &str) -> String {
    if let Some(say) = extract_say(raw) {
        return say;
    }
    // A <sleep> with no <say> is the "going silent" contract — no text.
    if find_tag(raw, "<sleep", 0).is_some() {
        return String::new();
    }
    strip_control_tags(raw).trim().to_string()
}

/// Best-effort text for an IN-PROGRESS turn (called on each delta while
/// streaming). Shows a complete say if one has arrived; otherwise the
/// in-flight content after an open `<say>` (minus any partial trailing tag);
/// otherwise the tag-stripped prose so far.
pub fn live_preview(raw: &str) -> String {
    if let Some(say) = extract_say(raw) {
        return say;
    }
    if let Some(open) = find_tag(raw, "<say>", 0) {
        let inner = &raw[open + "<say>".len()..];
        // Drop a partial trailing tag (e.g. a half-streamed `</sa`).
        let inner = inner.split('<').next().unwrap_or(inner);
        return inner.trim().to_string();
    }
    if find_tag(raw, "<sleep", 0).is_some() {
        return String::new();
    }
    strip_control_tags(raw).trim().to_string()
}

// (live_preview's no-tag fallback shares strip_control_tags via the body above.)

/// Case-insensitive (ASCII) search for `tag` in `hay` starting at byte `from`.
/// Returns the byte offset of the match. Tags are ASCII, so the returned
/// offset is always a `&str` char boundary.
fn find_tag(hay: &str, tag: &str, from: usize) -> Option<usize> {
    let hb = hay.as_bytes();
    let tb = tag.as_bytes();
    if tb.is_empty() || from >= hb.len() || tb.len() > hb.len() {
        return None;
    }
    let mut i = from;
    while i + tb.len() <= hb.len() {
        if hb[i..i + tb.len()].eq_ignore_ascii_case(tb) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Strip operator control tags from prose (the fallback when there's no `<say>`).
/// First removes paired `<set_mode>…</set_mode>` blocks INCLUDING their content
/// (matching `parseOperatorTurn`'s fallback), then drops all remaining standalone
/// tag markup (`<continue/>`, `<spawn …/>`, `<sleep …/>`, a partial trailing
/// `<…`). The user-visible prose is what's left.
fn strip_control_tags(s: &str) -> String {
    let mut work = s.to_string();
    // Remove paired <set_mode>…</set_mode> spans (content included).
    while let Some(open) = find_tag(&work, "<set_mode>", 0) {
        match find_tag(&work, "</set_mode>", open) {
            Some(close) => {
                let end = close + "</set_mode>".len();
                work.replace_range(open..end, "");
            }
            None => break, // unclosed — leave it for the markup strip below
        }
    }
    strip_markup(&work)
}

/// Drop everything inside `<…>` (markup only), leaving prose. A trailing unclosed
/// `<` (a partial tag mid-stream) and its remainder are dropped.
fn strip_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_say_basic() {
        assert_eq!(extract_say("<say>hello there</say>").as_deref(), Some("hello there"));
        // Surrounding tags + whitespace.
        assert_eq!(
            extract_say("<set_mode>active</set_mode>\n<say>  hi  </say>\n").as_deref(),
            Some("hi"),
        );
        // Case-insensitive tag match.
        assert_eq!(extract_say("<SAY>Yo</SAY>").as_deref(), Some("Yo"));
        // No say / empty say → None.
        assert_eq!(extract_say("just prose"), None);
        assert_eq!(extract_say("<say>   </say>"), None);
        assert_eq!(extract_say("<say>unclosed"), None);
    }

    #[test]
    fn finalize_prefers_say_and_drops_other_tags() {
        assert_eq!(
            finalize("<say>The carve is done.</say><set_mode>passive</set_mode>"),
            "The carve is done.",
        );
    }

    #[test]
    fn finalize_sleep_without_say_is_silent() {
        assert_eq!(finalize("<sleep duration_minutes=\"5\" reason=\"busy\"/>"), "");
        // sleep + prose noise around it → still silent (no say).
        assert_eq!(finalize("ok <sleep duration_minutes=\"2\"/> bye"), "");
    }

    #[test]
    fn finalize_falls_back_to_bare_prose() {
        // Model emitted prose without a <say> wrapper → show it.
        assert_eq!(finalize("Here is the answer."), "Here is the answer.");
        // set_mode-only around bare prose → strip the tag, keep prose.
        assert_eq!(
            finalize("<set_mode>passive</set_mode>I'll wait."),
            "I'll wait.",
        );
        // A <spawn> tag with no say is stripped from the fallback.
        assert_eq!(
            finalize("Spawning a worker. <spawn role=\"worker\" feature=\"F-1\"/>"),
            "Spawning a worker.",
        );
    }

    #[test]
    fn live_preview_shows_in_progress_say() {
        // Complete say wins.
        assert_eq!(live_preview("<say>done</say>"), "done");
        // Open say, still streaming — show the partial body.
        assert_eq!(live_preview("<say>typing in prog"), "typing in prog");
        // Partial trailing close tag is trimmed off.
        assert_eq!(live_preview("<say>almost</sa"), "almost");
        // Before any say tag arrives → empty (we haven't started the utterance).
        assert_eq!(live_preview("<set_mode>active</set_mode>"), "");
        // Bare prose (no tags yet) shows as-is.
        assert_eq!(live_preview("partial prose"), "partial prose");
    }
}
