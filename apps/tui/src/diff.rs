//! Bounded ingest of tool-call payloads for the pui chat pane (P-005 slice 6).
//!
//! This module owns the **ingest bounding policy** D-018 #4 requires, and the
//! diff is its main consumer. The rule that decision settled: identifiers may be
//! carried verbatim through the seam mapping (D-017 #2) because they are small,
//! but a payload BODY may not — a `capability:read` of a large file or a bash
//! command with large stdout would be retained per call, per message, for the
//! life of the session, and the pane holds the whole transcript in memory.
//!
//! So everything here bounds **on arrival**, not at render time:
//!
//! * [`ingest_tool_input`] is the single entry point, and the ORDER inside it is
//!   load-bearing — the diff is extracted from the RAW value first, then the
//!   value is bounded for retention. Bounding first would silently truncate
//!   every diff to the argument budget. It is one call precisely so the two
//!   steps cannot be reordered at a call site.
//! * The alignment input is capped at [`MAX_SIDE_LINES`] per side, so the
//!   O(n·m) alignment below runs over at most 200×200 cells regardless of what
//!   arrives. That cap is also why this is hand-rolled rather than a diff crate:
//!   see the reuse note on [`align`].
//! * Long single lines are capped at [`MAX_LINE_CHARS`]. A line COUNT bound
//!   alone is not a bound — one minified-JSON line can be megabytes.
//!
//! Styling deliberately lives in `ui.rs`, not here: what the pane retains is an
//! ingest concern, how it is painted is a render concern (D-017 #1).

use serde_json::Value;

/// Lines retained from EACH side of an edit before alignment runs.
pub(crate) const MAX_SIDE_LINES: usize = 200;
/// Diff rows a card retains after alignment and context collapsing.
///
/// Small on purpose: a card exists so a turn can be SKIMMED (D-018 #5), and a
/// 200-row diff would drown the conversation it is supposed to annotate.
pub(crate) const MAX_DIFF_LINES: usize = 40;
/// Characters retained per diff row.
pub(crate) const MAX_LINE_CHARS: usize = 400;
/// Unchanged rows kept either side of a change before a run collapses to a gap.
const CONTEXT: usize = 2;
/// Characters of string content retained across a whole bounded argument value.
const MAX_ARG_CHARS: usize = 4_000;
/// JSON nodes visited while bounding one argument value.
const MAX_ARG_NODES: usize = 500;
/// Marker left where a budget cut something out.
const ELIDED: &str = "…";

/// One row of a bounded diff.
#[derive(Debug, Clone, PartialEq)]
pub enum DiffLine {
    /// An unchanged line kept for orientation.
    Context(String),
    Added(String),
    Removed(String),
    /// A collapsed run of unchanged lines, carrying how many were hidden.
    Gap(usize),
}

/// A tool call's edit, bounded at ingest and ready to paint.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDiff {
    /// The file the edit targets, when the arguments name one.
    pub path: Option<String>,
    pub lines: Vec<DiffLine>,
    /// Added/removed counts over the whole aligned diff — including rows the
    /// [`MAX_DIFF_LINES`] cap then dropped, so the header states the size of the
    /// change rather than the size of the excerpt.
    pub added: usize,
    pub removed: usize,
    /// Rows dropped by the [`MAX_DIFF_LINES`] cap.
    pub elided: usize,
    /// The raw input was itself cut before alignment ([`MAX_SIDE_LINES`] or
    /// [`MAX_LINE_CHARS`]). Distinct from `elided`: that one means "more rows
    /// exist and were computed", this one means "the diff was computed over a
    /// PREFIX of the edit". Conflating them would let a partial diff read as a
    /// complete one.
    pub source_truncated: bool,
}

/// Extract a bounded diff from a tool call's arguments, and bound the arguments
/// themselves for retention. Both halves of D-018 #4's ingest policy, in the one
/// order that works.
pub(crate) fn ingest_tool_input(input: Value) -> (Option<ToolDiff>, Option<Value>) {
    let diff = extract_diff(&input);
    let mut chars = MAX_ARG_CHARS;
    let mut nodes = MAX_ARG_NODES;
    let bounded = bound_value(&input, &mut chars, &mut nodes);
    (diff, Some(bounded))
}

/// Recognise an edit by the SHAPE of its arguments, never by tool name.
///
/// A name list ("Edit", "capability:edit", …) would be a second copy of a truth
/// the tool catalog owns: it goes stale the moment a tool is renamed or a new
/// editing tool appears, and the pane cannot tell a stale list from a tool that
/// genuinely does not edit. A shape check answers for both, and for tools this
/// pane has never heard of.
fn extract_diff(input: &Value) -> Option<ToolDiff> {
    let obj = input.as_object()?;
    let path = obj
        .get("file_path")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let (old_src, new_src) = match (
        obj.get("old_string").and_then(|v| v.as_str()),
        obj.get("new_string").and_then(|v| v.as_str()),
    ) {
        (Some(o), Some(n)) => (o, n),
        // A whole-file write: every line is an addition. `content` alone is not
        // enough — plenty of non-file tools carry a `content` argument — so the
        // shape requires a `file_path` beside it.
        _ => {
            let content = obj.get("content").and_then(|v| v.as_str())?;
            path.as_ref()?;
            ("", content)
        }
    };

    let (old_lines, old_cut) = split_bounded(old_src);
    let (new_lines, new_cut) = split_bounded(new_src);
    if old_lines.is_empty() && new_lines.is_empty() {
        return None;
    }

    let aligned = collapse(&align(&old_lines, &new_lines));
    let added = aligned
        .iter()
        .filter(|l| matches!(l, DiffLine::Added(_)))
        .count();
    let removed = aligned
        .iter()
        .filter(|l| matches!(l, DiffLine::Removed(_)))
        .count();
    // An edit whose sides are identical is not a diff. The edit tool rejects
    // that case anyway; rendering an all-context card for it would be noise.
    if added == 0 && removed == 0 {
        return None;
    }

    let mut lines = aligned;
    let elided = lines.len().saturating_sub(MAX_DIFF_LINES);
    lines.truncate(MAX_DIFF_LINES);

    Some(ToolDiff {
        path,
        lines,
        added,
        removed,
        elided,
        source_truncated: old_cut || new_cut,
    })
}

/// Split into at most [`MAX_SIDE_LINES`] rows, each at most [`MAX_LINE_CHARS`].
/// Returns whether anything was cut.
fn split_bounded(s: &str) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    for line in s.lines() {
        if out.len() >= MAX_SIDE_LINES {
            truncated = true;
            break;
        }
        if line.chars().count() > MAX_LINE_CHARS {
            truncated = true;
        }
        // Reuse the pane's char-safe truncator rather than adding a parallel
        // one (the same call D-018 #5 made for argument lines).
        out.push(crate::ui::trunc(line, MAX_LINE_CHARS));
    }
    (out, truncated)
}

/// Longest-common-subsequence alignment of two bounded line slices.
///
/// Reuse note: `similar` (or any Myers implementation) is the obvious library
/// answer, and the requirement was written out before reaching for it — "produce
/// a bounded set of +/-/context rows from two COMPLETE strings". The clause a
/// diff crate earns its keep on is SCALE: an efficient edit-script over inputs
/// too large for O(n·m). But D-018 #4 forces a bound at ingest, and once each
/// side is capped at [`MAX_SIDE_LINES`] the table is at most 200×200 ≈ 160KB and
/// microseconds — so the clause the crate covers has already been removed by the
/// bound the decision mandates. Quality is not the trade: LCS and Myers both
/// yield a minimal edit script, so on bounded input this is not the weaker
/// alignment, just the one with no dependency under it. Raise `MAX_SIDE_LINES`
/// materially and that reasoning expires — revisit the crate then.
fn align(old: &[String], new: &[String]) -> Vec<DiffLine> {
    let (n, m) = (old.len(), new.len());
    // dp[i][j] = LCS length of old[i..] and new[j..].
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if old[i] == new[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    let mut out = Vec::with_capacity(n + m);
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if old[i] == new[j] {
            out.push(DiffLine::Context(old[i].clone()));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            out.push(DiffLine::Removed(old[i].clone()));
            i += 1;
        } else {
            out.push(DiffLine::Added(new[j].clone()));
            j += 1;
        }
    }
    while i < n {
        out.push(DiffLine::Removed(old[i].clone()));
        i += 1;
    }
    while j < m {
        out.push(DiffLine::Added(new[j].clone()));
        j += 1;
    }
    out
}

/// Collapse long runs of unchanged rows to a [`DiffLine::Gap`].
///
/// The edit tool requires `old_string` to match uniquely, so agents pad it with
/// surrounding context — an uncollapsed diff of a one-line change is routinely
/// twenty rows of unchanged text with the change buried in the middle.
fn collapse(rows: &[DiffLine]) -> Vec<DiffLine> {
    let mut out = Vec::with_capacity(rows.len());
    let mut i = 0;
    while i < rows.len() {
        if !matches!(rows[i], DiffLine::Context(_)) {
            out.push(rows[i].clone());
            i += 1;
            continue;
        }
        let start = i;
        while i < rows.len() && matches!(rows[i], DiffLine::Context(_)) {
            i += 1;
        }
        let run = &rows[start..i];
        // A run before the first change needs no leading context, and one after
        // the last change needs no trailing context.
        let head = if start == 0 { 0 } else { CONTEXT };
        let tail = if i == rows.len() { 0 } else { CONTEXT };
        if run.len() <= head + tail + 1 {
            out.extend_from_slice(run);
        } else {
            out.extend_from_slice(&run[..head]);
            out.push(DiffLine::Gap(run.len() - head - tail));
            out.extend_from_slice(&run[run.len() - tail..]);
        }
    }
    out
}

/// Bound a tool's argument value for retention.
///
/// Both budgets are needed and neither subsumes the other: the char budget stops
/// one huge string, the node budget stops a deeply nested or very wide structure
/// that carries almost no string content but still costs memory to hold.
fn bound_value(v: &Value, chars: &mut usize, nodes: &mut usize) -> Value {
    if *nodes == 0 {
        return Value::String(ELIDED.into());
    }
    *nodes -= 1;
    match v {
        Value::String(s) => {
            let take = (*chars).min(MAX_LINE_CHARS);
            let kept = crate::ui::trunc(s, take);
            *chars = chars.saturating_sub(kept.chars().count());
            Value::String(kept)
        }
        // Containers STOP once the budget is spent rather than mapping every
        // element to an elision marker: a 5,000-element array of `"…"` is just
        // as many nodes to hold as the array it replaced, so a per-element
        // marker would leave the value formally "bounded" and actually not.
        Value::Array(a) => {
            let mut out = Vec::new();
            for item in a {
                if *nodes == 0 {
                    out.push(Value::String(ELIDED.into()));
                    break;
                }
                out.push(bound_value(item, chars, nodes));
            }
            Value::Array(out)
        }
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, item) in o {
                if *nodes == 0 {
                    out.insert(ELIDED.into(), Value::String(ELIDED.into()));
                    break;
                }
                out.insert(k.clone(), bound_value(item, chars, nodes));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn added(d: &ToolDiff) -> Vec<&str> {
        d.lines
            .iter()
            .filter_map(|l| match l {
                DiffLine::Added(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    fn removed(d: &ToolDiff) -> Vec<&str> {
        d.lines
            .iter()
            .filter_map(|l| match l {
                DiffLine::Removed(s) => Some(s.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn edit_shape_yields_a_diff_with_the_unchanged_lines_as_context() {
        let (diff, _) = ingest_tool_input(json!({
            "file_path": "src/a.rs",
            "old_string": "one\ntwo\nthree",
            "new_string": "one\nTWO\nthree",
        }));
        let d = diff.expect("edit shape must produce a diff");
        assert_eq!(d.path.as_deref(), Some("src/a.rs"));
        assert_eq!(added(&d), vec!["TWO"]);
        assert_eq!(removed(&d), vec!["two"]);
        assert_eq!((d.added, d.removed), (1, 1));
        // The unchanged lines survive as context, not as a remove+add pair —
        // that is the whole point of aligning rather than blocking the sides.
        assert!(d.lines.contains(&DiffLine::Context("one".into())));
        assert!(d.lines.contains(&DiffLine::Context("three".into())));
        assert!(!d.source_truncated);
        assert_eq!(d.elided, 0);
    }

    #[test]
    fn write_shape_is_all_additions_and_needs_a_file_path() {
        let (diff, _) = ingest_tool_input(json!({
            "file_path": "src/new.rs",
            "content": "fn main() {}\n",
        }));
        let d = diff.expect("write shape must produce a diff");
        assert_eq!(added(&d), vec!["fn main() {}"]);
        assert!(removed(&d).is_empty());

        // `content` WITHOUT a file_path is some other tool's argument, not a
        // file write — rendering it as a green wall would be a false claim.
        let (none, _) = ingest_tool_input(json!({ "content": "not a file write" }));
        assert!(none.is_none());
    }

    #[test]
    fn a_tool_that_does_not_edit_produces_no_diff() {
        for input in [
            json!({ "command": "ls -la" }),
            json!({ "file_path": "src/a.rs", "offset": 1, "limit": 20 }),
            json!("a bare string"),
            json!(null),
        ] {
            assert!(ingest_tool_input(input).0.is_none());
        }
    }

    #[test]
    fn identical_sides_are_not_a_diff() {
        let (diff, _) = ingest_tool_input(json!({
            "file_path": "src/a.rs",
            "old_string": "same\nlines",
            "new_string": "same\nlines",
        }));
        assert!(diff.is_none());
    }

    #[test]
    fn long_unchanged_runs_collapse_to_a_gap() {
        let pad: Vec<String> = (0..30).map(|i| format!("line {i}")).collect();
        let old = format!("{}\nTARGET\n{}", pad.join("\n"), pad.join("\n"));
        let new = format!("{}\nCHANGED\n{}", pad.join("\n"), pad.join("\n"));
        let (diff, _) = ingest_tool_input(json!({
            "file_path": "src/a.rs", "old_string": old, "new_string": new,
        }));
        let d = diff.expect("diff");
        let gaps: Vec<usize> = d
            .lines
            .iter()
            .filter_map(|l| match l {
                DiffLine::Gap(n) => Some(*n),
                _ => None,
            })
            .collect();
        // Two runs of 30 unchanged lines, each collapsed rather than printed.
        assert_eq!(
            gaps.len(),
            2,
            "both context runs must collapse: {:?}",
            d.lines
        );
        // The leading run keeps only its TAIL (nothing above the change is worth
        // showing), the trailing run only its HEAD.
        assert_eq!(gaps[0], 28);
        assert_eq!(gaps[1], 28);
        assert!(d.lines.len() < 20, "collapsed diff stays skimmable");
    }

    #[test]
    fn source_truncation_is_reported_separately_from_row_elision() {
        // More lines than the ingest cap: the diff is computed over a PREFIX.
        let huge = (0..MAX_SIDE_LINES + 50)
            .map(|i| format!("l{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (diff, _) = ingest_tool_input(json!({
            "file_path": "src/a.rs", "content": huge,
        }));
        let d = diff.expect("diff");
        assert!(d.source_truncated, "a cut input must say so");
        assert_eq!(d.lines.len(), MAX_DIFF_LINES, "rows stay capped");
        assert!(d.elided > 0, "dropped rows are counted, not silently lost");
        // The counts describe the whole aligned diff, not just the excerpt.
        assert!(d.added > MAX_DIFF_LINES);
    }

    #[test]
    fn one_enormous_line_is_bounded_too() {
        // A line COUNT cap alone is not a bound — minified JSON is one line.
        let (diff, _) = ingest_tool_input(json!({
            "file_path": "src/a.rs",
            "old_string": "x".repeat(50_000),
            "new_string": "y".repeat(50_000),
        }));
        let d = diff.expect("diff");
        for line in &d.lines {
            let len = match line {
                DiffLine::Added(s) | DiffLine::Removed(s) | DiffLine::Context(s) => {
                    s.chars().count()
                }
                DiffLine::Gap(_) => 0,
            };
            assert!(len <= MAX_LINE_CHARS, "retained {len} chars");
        }
        assert!(d.source_truncated);
    }

    #[test]
    fn retained_arguments_are_bounded_but_keep_their_shape() {
        let (_, bounded) = ingest_tool_input(json!({
            "file_path": "src/a.rs",
            "content": "z".repeat(100_000),
        }));
        let v = bounded.expect("arguments are still carried");
        // Shape survives, so the card's one-line summary still reads correctly…
        assert_eq!(
            v.get("file_path").and_then(|f| f.as_str()),
            Some("src/a.rs")
        );
        // …but the body does not ride along for the life of the session.
        let kept = v.get("content").and_then(|c| c.as_str()).unwrap();
        assert!(
            kept.chars().count() <= MAX_LINE_CHARS,
            "kept {}",
            kept.len()
        );
    }

    #[test]
    fn bounding_runs_after_extraction_never_before() {
        // The diff must see the RAW value. If bounding ran first, a body longer
        // than the argument budget would yield a diff of the truncated prefix —
        // silently, and only for large edits.
        let body: String = (0..30)
            .map(|i| format!("line {i} {}\n", "x".repeat(20)))
            .collect();
        assert!(
            body.chars().count() > MAX_LINE_CHARS,
            "the probe only proves anything if the argument bound actually bites"
        );
        let (diff, bounded) = ingest_tool_input(json!({
            "file_path": "src/a.rs", "content": body,
        }));
        let d = diff.expect("diff");
        assert_eq!(d.added, 30, "every line reached the aligner");
        let kept = bounded
            .and_then(|v| {
                v.get("content")
                    .and_then(|c| c.as_str())
                    .map(str::to_string)
            })
            .unwrap();
        assert!(
            kept.chars().count() <= MAX_LINE_CHARS,
            "…while the retained copy was still cut"
        );
    }

    #[test]
    fn a_wide_structure_is_bounded_by_node_budget_not_only_by_chars() {
        // Almost no string content, but a lot of nodes to hold.
        let wide = Value::Array((0..5_000).map(|i| json!(i)).collect());
        let (_, bounded) = ingest_tool_input(json!({ "rows": wide }));
        let out = bounded.unwrap();
        let arr = out.get("rows").and_then(|r| r.as_array()).unwrap();
        // The container SHRANK. Mapping 5,000 elements to 5,000 elision markers
        // would satisfy a naive "is it marked?" assertion while retaining just
        // as many nodes, so the property under test is the length.
        assert!(
            arr.len() < 1_000,
            "node budget must shrink the container, not just annotate it: {}",
            arr.len()
        );
        assert_eq!(arr.last().and_then(|v| v.as_str()), Some(ELIDED));
    }
}
