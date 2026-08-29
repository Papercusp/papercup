//! P-007 recurrence guard — the Network destination must actually fetch every
//! read model it absorbed.
//!
//! Network absorbed the retired Hives shell in the 21→14 consolidation (audit
//! plan `pui-tui-tab-audit-2026-08-27` D-005; execution plan D-003), so it owns
//! three read models: the network board, the federated roster (`Event::Hives` →
//! `app.hives`, which `network.rs` renders through `present_in_hive`), and the
//! browseable discovery directory (`Event::HiveDirectory`).
//!
//! The regression this pins was real and silent. The consolidation left
//! `Action::FetchHives` — the ONLY caller of `fetch_hives` and
//! `fetch_hive_directory` — with no emitter anywhere in the reducer, so both
//! streams were never fetched. `app.hives` stayed empty for the life of the
//! process while `network.rs` kept rendering from it, so every hive showed no
//! members and the directory was always blank. Nothing failed; the capability
//! simply rendered as an empty state, which is exactly the failure mode D-005
//! calls out ("error states rendered as empty states") and exactly the
//! capability loss D-003/D-005 forbid.
//!
//! This is a SOURCE guard (the `install_contract.rs` convention in this crate)
//! rather than a reducer unit test, because the wiring under test lives in
//! `main.rs`'s action dispatcher: `App::update` only returns the `Action`, and
//! main.rs alone decides what that action spawns. No pure `App` test can
//! observe it, which is precisely why the gap survived a green suite.

use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("apps/tui lives below repo root")
        .to_path_buf()
}

/// Return the `{ .. }` block that follows `marker`, brace-balanced.
fn block_after<'a>(src: &'a str, marker: &str) -> &'a str {
    let start = src
        .find(marker)
        .unwrap_or_else(|| panic!("marker {marker:?} not found — the dispatcher was renamed?"));
    let open = start + marker.len() - 1;
    assert_eq!(
        src.as_bytes()[open],
        b'{',
        "marker {marker:?} must end at its opening brace"
    );
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    for i in open..bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open..=i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces after {marker:?}");
}

#[test]
fn network_entry_action_fetches_every_read_model_it_absorbed() {
    let root = repo_root();
    let main_rs = std::fs::read_to_string(root.join("apps/tui/src/main.rs")).unwrap();
    let app_rs = std::fs::read_to_string(root.join("apps/tui/src/app.rs")).unwrap();

    // Entering Network is what triggers the fetch, and the reducer's entry
    // action for the tab is `FetchNetworkBoard`.
    assert!(
        app_rs.contains("if tab == Tab::Network {\n            return Action::FetchNetworkBoard;"),
        "Tab::Network's entry action is no longer Action::FetchNetworkBoard — \
         re-point this guard at whatever replaced it"
    );

    // ...and that one handler must service ALL THREE Network read models.
    let handler = block_after(&main_rs, "Action::FetchNetworkBoard => {");
    for (call, what) in [
        ("fetch_network_board(", "the network board"),
        (
            "fetch_hives(",
            "the federated roster absorbed from Hives (app.hives)",
        ),
        (
            "fetch_hive_directory(",
            "the discovery directory absorbed from Hives",
        ),
    ] {
        assert!(
            handler.contains(call),
            "Network's entry handler no longer fetches {what} (`{call}`). \
             network.rs still renders that data, so dropping the fetch does not \
             fail — it renders a permanently empty subview, which is the \
             capability loss D-003/D-005 forbid."
        );
    }
}

/// Strip whole-line `//` comments so a guard cannot match the prose that
/// explains it. (Both this file and the sources it reads necessarily *name*
/// `Action::FetchHives` while describing why it was removed; matching raw text
/// would make the guard fail on its own documentation — the same self-match
/// trap as `pgrep -f` matching its own argv.)
fn code_only(src: &str) -> String {
    src.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn no_action_variant_is_left_without_an_emitter() {
    let root = repo_root();
    let main_rs = code_only(&std::fs::read_to_string(root.join("apps/tui/src/main.rs")).unwrap());
    let app_rs = code_only(&std::fs::read_to_string(root.join("apps/tui/src/app.rs")).unwrap());

    // `Action::FetchHives` was the emitter-less variant that hid the bug above:
    // main.rs handled it, so the code looked wired, but no reducer path ever
    // produced it. Reintroducing that shape re-arms the same silent trap.
    assert!(
        !main_rs.contains("Action::FetchHives"),
        "Action::FetchHives is back in the dispatcher. It was removed because \
         nothing emitted it — its fetches now hang off FetchNetworkBoard. If a \
         separate Hives fetch is genuinely wanted again, give it an emitter in \
         app.rs and update this guard."
    );
    assert!(
        !app_rs.contains("FetchHives"),
        "Action::FetchHives is back in the Action enum — see above"
    );

    // The guard above is worth nothing if `code_only` silently stops stripping,
    // so calibrate it: this very line's comment names the symbol, and must not
    // be what the assertions matched.
    // Action::FetchHives  <- decoy, inside a comment, must be stripped
    assert!(
        !code_only("// Action::FetchHives").contains("FetchHives"),
        "code_only stopped stripping comments — the assertions above are inert"
    );
}
