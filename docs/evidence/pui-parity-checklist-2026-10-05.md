# pui parity checklist — stock Claude Code and Codex vs pui (2026-10-05)

Plan `pui-chat-first-ux-2026-09-28`, item P-022 (WI-10005485). Bar, from [owner 2026-10-02 #1276]:
"as user friendly as the claude and codex tui, that should be the bar". This checklist is the source
for the amended acceptance rubric and for P-025..P-032.

## How it was measured

One scripted PTY battery, `--battery parity`, run against each CLI in a 120x40 headless xterm:
`npx tsx packages/operator-core/lib/pui-e2e/p005-side-by-side.mts --battery parity --cli <claude|codex|pui> --out <dir>`.
Each probe writes screen frames (`<probe>.txt`, timed `.t150/.t1000/...` frames) plus one row in `summary.json`.
Frames and summaries (157 files, 704 KB, emails/home paths/account handles redacted) are kept outside the
shipped tree at `~/.papercusp/evidence/pui-parity-2026-10-05/{claude,codex,pui}/` on the dev box, with the
`digest.mjs` / `diffdigest.mjs` readers used to compare them (`node diffdigest.mjs '<probe regex>' <lines>`
prints, per CLI, the lines a probe's key frame adds over its baseline frame).

| CLI | Version | Route | Notes |
|---|---|---|---|
| Claude Code | 2.1.289, Opus 5.5 | gateway (`--claude-auth env`, "API Usage Billing") | The first leg on the box's OAuth login hit its weekly limit on every turn and is discarded. |
| Codex | codex-cli 0.160.1, GPT-6.1-Sol | shared login | Complete. |
| pui | 0.1.0, release build 5d50af48, operator :3170 | box default account (OAuth) | The engine hit the same weekly limit, so every model-backed probe (hi, stream, tool, edit, interrupt, resume recall) answered "You've hit your weekly limit". Those pui cells are **not measured** this run. pui has no way to pick another account at launch; see gap G-14. UI-only probes are valid. |

Stock-CLI caveat: both stock CLIs ran in their auto / full-access permission modes (Claude "auto mode on",
Codex default sandbox), so neither showed an approval prompt (`approvals: 0`). The approval row below is
therefore specified from P-028's text, not measured here; P-028 and P-032 must capture it under the
default permission mode.

Harness defect found and fixed during this run: before P-022 only Codex tasks were checked for an answer;
Claude and pui tasks always logged `taskCompleted: true`. pui's resume recall "passed" while its resume
picker was still loading, because the expected words were in an earlier user prompt.
`taskAnsweredAfterPrompt` (`packages/operator-core/lib/pui-e2e/p005-codex-readiness.ts`) now matches the
expected answer only after the echoed prompt, for every CLI; guarded in `p005-codex-readiness.test.ts`.

## Checklist

"Gap" names the plan item that owns closing it. **Bold** = pui is behind both stock CLIs.

| # | Behaviour | Claude Code | Codex | pui today | Gap → item |
|---|---|---|---|---|---|
| 1 | Startup to usable prompt | 805 ms | 502 ms | **2108 ms** ("Type a message below and press Enter.") | **G-1** 2.6x slower than Claude → P-031 |
| 2 | "hi": feedback right after Enter | Echo + spinner verb "✶ Perambulating…" by 150 ms; footer "esc to interrupt" | Nothing new on screen until 5010 ms | Echo by 150 ms; by 1 s "⠙ Starting Claude… (0s · Esc to interrupt)" and "Sending — Enter queues your next message" | pui ahead of Codex, level with Claude (P-024 done) |
| 3 | Working indicator (spinner, elapsed, tokens, Esc hint) | Spinner + Esc hint at once; elapsed + token count on longer turns | "• Working (1s • esc to interrupt)": elapsed + Esc, no tokens | Spinner + elapsed + Esc hint; no token count | G-2 no token count → P-029 |
| 4 | Answer and turn footer | "● Hi! …" then "✻ Worked for 2s · done 7:36 PM" | "• Hi! …" then "Worked for 5s • 7:30 PM" | "● …" then "✻ Worked for 3s" (frame shape confirmed; content was the limit error) | none in shape |
| 5 | Streaming text (count 1..40) | Chunky: 2 distinct counts seen (3, 40) | Smooth: 10 distinct counts seen | Not measured (engine limit) | P-025 owns streaming; re-measure in P-032 |
| 6 | Tool call and result | "Read 1 file (ctrl+o to expand)", then answer; 18 s | "• Explored └ List rg --files … Read calc.js + Show details"; 19 s | Not measured (engine limit) | P-025 (compact verb(target) row + one-line result) |
| 7 | Edit with diff | "● Update(calc.js) ⎿ Added 2 lines, removed 2 lines" + numbered diff; then ran a node check | "• Edited calc.js (+2 -2)" + diff + "Show details"; then ran a check | Not measured (engine limit; file unchanged) | P-025 / P-028 |
| 8 | Approval prompt | Not captured (auto mode) | Not captured (full access) | Not captured | Spec from P-028: one prompt, numbered choices 1 Yes / 2 Yes, don't ask again / 3 No, tell it what to do; diff shown once. Capture under default mode in P-028/P-032 |
| 9 | Interrupt (Esc mid-reply) | Stops within 2 s; "⎿ Interrupted · What should Claude do instead?" | Stops within 2 s; "■ Conversation interrupted - use /feedback if something went wrong" | Not measured mid-reply (the reply had already ended) | re-measure in P-032 |
| 10 | Esc with nothing running | Stays in the box (double Esc clears input) | Stays in the box | **Leaves the box into "Composer — i type · v speak · j/k scroll" / "press i to talk · v PTT · V realtime voice"** | **G-3** Esc must not leave the box → P-027 |
| 11 | Slash menu | "/" lists ~100 commands with one-line descriptions; "/mo" filters to /model, /mobile, … | "/" lists commands with descriptions; "/mo" filters to /model | 7 commands: /help /resume /expand /details /copy /detach /exit; **"/mo" → "no command matches /mo"** | **G-4** no /model, /status, /clear, /compact, /approvals → P-027 (+P-026, P-029) |
| 12 | Model switch | /model picker: Default (Opus 5.5) ✔, Opus, Fable, Sonnet, Haiku with prices; effort ←/→; "alt+p to switch model" | "Select Model and Effort": 7 models, current marked, then effort | **No /model** ("No command /model") | **G-5** → P-026 (/model picker, footer model, `pui --model`) |
| 13 | ? shortcuts overlay | Two-column key list (! shell, / commands, @ paths, \⏎ newline, shift+tab modes, alt+p model, ctrl+g editor…) | "Keyboard shortcuts" in Compose / Session / Transcript columns | Overlay with Enter, Shift+Enter, /, @, ↑↓, PgUp/PgDn, wheel, drag-copy, Esc, Ctrl+R/O/Z/C | Mostly level. G-6 no permission-mode key (shift+tab) → P-027 |
| 14 | History (Up) | Recalls earlier messages | Recalls earlier entries (/model) | Up 1 → last message, Up 2 → the one before | none |
| 15 | Multiline input | Ctrl+J and `\`+Enter insert a newline | Ctrl+J newline; `\`+Enter submits | Ctrl+J, `\`+Enter and Shift+Enter all insert a newline | none (pui ahead) |
| 16 | Paste (40 lines, 2110 chars) | Collapses to "[Pasted text #1 +39 lines]" | Collapses to "[Pasted Content 2110 chars]" | **All 40 lines expanded into the composer, filling the screen** | **G-7** collapse large pastes to a chip → P-027 |
| 17 | @ file mention | Not captured cleanly (composer still held "/model", so "@cal" was typed after it) | No picker on screen in the frame | "Attach a file · 2 matches" popup (calc.js, calc.test.js); popup draws over the transcript | pui works. Re-capture Claude/Codex in P-032 (harness: clear the composer before probe 21) |
| 18 | /status, context and cost | /status: Settings › Status panel (version, session, cwd, …); /context: context-usage breakdown | /status: model, "Context window: 99% left (16.2K used / 475K)", weekly limit, credits | **"No command /status"**; no context or cost anywhere | **G-8** → P-029 |
| 19 | Idle footer | "⏵⏵ auto mode on (shift+tab to cycle)" + "◐ medium · /effort" | "GPT-6.1-Sol default · <cwd> · <session title>" + "? for shortcuts" | "? for shortcuts  Claude · <cwd>": no model, mode or context left | **G-9** footer shows model, permission mode, context % → P-029 / P-026 |
| 20 | Unknown command | Transcript line "● Unknown command: /notacommand" | "• Unrecognized command '/notacommand'. Type "/" for a list…" | Warning toast "No command /notacommand. Type / to see the commands, or start the message with a space…", but the toast box **draws over the input border** | G-10 toast overlap is a render bug → P-027 |
| 21 | Ctrl+C with a draft | 1st clears the draft, 2nd asks again, 3rd exits | 1st clears the draft, 2nd exits | **1st Ctrl+C exits pui and loses the draft** ("Conversation ended. Open pui and use /resume…") | **G-11** clear the draft first, confirm before quitting → P-027 |
| 22 | Resume | `--resume` ready in 1.1 s; recalled the earlier edit correctly | `resume` ready in 0.5 s; recalled correctly (44 s turn) | **Picker stuck on "Loading earlier conversations… — not settable" for 30 s**; recall never asked | **G-12** resume picker never loads → P-031 (offer resume on start) / P-027 (/resume) |
| 23 | Errors: usage limit | "⎿ You've hit your weekly limit · resets 1pm" + footer "⚠ Usage limit reached … /usage-credits to continue now" | (not hit) | **The limit text is shown as a normal reply ("● You've hit your weekly limit…", "✻ Worked for 3s")**, with no next step | **G-13** errors look like answers and say nothing about what to do → P-031 |
| 24 | Choosing the account/route | Login or env route; /status shows the account | Login; /status shows limits/credits | **No way to choose the engine account at launch**; an OAuth limit leaves pui unusable | **G-14** `pui --account <auto|default|name>` plus account in /status → P-026 / P-031 |
| 25 | Zellij panes | n/a | n/a | Bare `pui` is chat-only; the workbench panes are gone | P-030 [owner #1277] |

## Gaps by plan item

- **P-025 live streaming / tool rows**: rows 5–7 (re-measure once pui can reach a working engine).
- **P-026 model switching**: G-5, G-9 (model in footer), G-14 (`--account` beside `--model`).
- **P-027 slash menu and keys**: G-3 (Esc), G-4 (missing commands), G-6 (permission-mode key), G-7 (paste chip), G-10 (toast overlap), G-11 (Ctrl+C), G-12 (/resume).
- **P-028 approvals**: row 8, capture stock frames under the default permission mode first.
- **P-029 status and context**: G-2 (tokens), G-8 (/status, context %, cost), G-9 (footer).
- **P-030 zellij panes**: row 25.
- **P-031 startup and errors**: G-1 (startup 2.1 s vs 0.8 s), G-12 (offer resume), G-13 (plain error with a next step), G-14.
- **P-032 head-to-head**: rerun this battery on all three CLIs, with pui on a working route, after the above, and grade every row.

## P-027 resolution (2026-10-06, WI-10006273)

Each P-027 gap, with the code that closes it (apps/tui/src unless noted). Verified by `cargo test --bin pui`
(1319 passed, 0 failed) and the operator-core su-session engine and host tests. The frames themselves are
re-captured in P-032.

| Gap / key | Now | Where |
|---|---|---|
| G-3 Esc with nothing running | Stays in the box; Esc twice clears the draft ("Esc again to clear") | app.rs `chat_first_esc` |
| G-4 missing commands | `/` menu with one-line descriptions: /help /resume /clear /model /effort /status /compact /approvals /expand /details /copy /detach /exit; "/mo" filters to /model | chat_commands.rs |
| G-6 permission-mode key | `/approvals` opens a three-row picker (ask, auto-edit, read-only; current marked). Shift+Tab cycles. The pick rides on the next message (plan D-026); /status names it. Claude uses setPermissionMode, Codex uses turn/start approvalPolicy + sandboxPolicy; OMP says it is not available. No full-access mode | app.rs `open_approvals_picker` / `cycle_approvals`; packages/operator-core/lib/su-session-*-engine.ts |
| G-7 large paste | Collapses to a one-line `[pasted N lines]` chip; the full text is sent | app.rs, paste_chips.rs |
| G-10 toast over the input border | In the quiet chat a toast sits inside the message box | ui.rs |
| G-11 Ctrl+C with a draft | 1st clears the draft, 2nd within the window exits ("Press Ctrl+C again to exit") | app.rs |
| G-12 /resume stuck loading | The list re-fetches; a failed fetch says why and how to retry | app.rs |
| Alt+P (Claude) | Opens the model picker | app.rs composing arm |
| `?` overlay | Lists Shift+Tab and Alt+P with the other keys | ui.rs `CHAT_SHORTCUTS` |
| `!` shell (Claude) | Ruled out: bare `pui` opens a work shell pane beside the chat (P-030, D-024); a leading `!` is sent to the engine as text | — |
| Ctrl+G external editor (Claude) | Ruled out: Codex has no such key, and the box already edits multi-line text with undo | — |
| Context left and cost in /status | Not P-027: G-8 belongs to P-029 | — |

## P-025 resolution (2026-10-06, WI-10006349)

Rows 5–7, measured per engine with `--battery parity --probes 10,11,12,13` against the staging operator
(:3170, sha 335341d37a for Codex, d182bf3e2f for OMP and Claude) and a pui debug build from this tree. Claude ran
with `--account auto`: the box's default Claude account had hit its weekly limit. Frames: `/tmp/pui-p025-codex2`,
`/tmp/pui-p025-omp2`, `/tmp/pui-p025-claude3` (not durable; P-032 re-captures them).
Unit tests: `cargo test --bin pui` 1332 passed, 0 failed; `su-session-claude-engine.test.ts` 67 passed.

| Gap / row | Now | Where |
|---|---|---|
| 5 Streaming text (count 1..40) | Claude: 2 jumps, the same two-block pattern as stock Claude (3, 40). Codex: 5 distinct counts (9, 18, 30, 37, 40); stock Codex showed 10. OMP: 4 (12, 28, 36, 40). Each engine streams as fast as it delivers text | app.rs SU-session delta arm |
| 6 Tool call and result | One compact row when the call starts and a one-line result when it ends, on every engine: `⚙ Read(calc.js) ✓` / `⎿ Read 9 lines (Ctrl+R to expand)`; Codex shell calls read `⚙ Bash(cat calc.js) ✓` / `⎿ function add(a, b) { … +6 lines`. "Worked for" closes the turn below its rows | tool_display.rs, ui.rs `tool_detail_lines` |
| 7 Edit with diff | `⚙ Update(calc.js) ✓` / `⎿ Updated calc.js` (OMP) or `⎿ Added 2 lines, removed 2 lines` (Claude) after one approval card; the file changed. Codex: its approval cards render, but in this run Codex never reached the edit (see the host note below); its file-change row is covered by `codex_and_omp_tool_calls_get_claude_style_rows` | tool_display.rs, change_card.rs |
| Thinking / reasoning | One dim `∴` line (newest heading while streaming); Ctrl+R expands it | ui.rs `reasoning_lines`, app.rs `push_chat_reasoning` |
| Failed turn | A refused turn leaves one line under its prompt with the provider's sentence (`⎿ API Error 400: <reason>`, `⎿ You've hit your weekly limit · resets 1pm`), instead of nothing, and not three times | models.rs `turn_error_text`, `ChatMessage::push_turn_error`, ui.rs |
| Failed tool | `✗` on the row and the output on its `⎿` line; the fixed "SU-session tool failed" line under every failure is gone | app.rs, ui.rs |

Defects found while measuring, all fixed with tests:

- OMP ended the turn at every tool call: it marks a tool-calling message with stop reason `toolUse`, which the
  operator read as a turn end, so pui printed "Worked for" mid-turn and could send a queued draft into a running
  turn (packages/operator-core/lib/su-session-omp-adapter.ts, commit 335341d37).
- OMP edit rows had no file name (the file is named only inside the patch); they read `Update(calc.js)` now.
- Claude's "waiting for you" while an approval card is open ended the turn in pui; it is a pause now.
- A refused Claude turn showed three times: the SDK's synthetic assistant text, the adapter's error and the
  engine's error in its diagnostic wording. The engine is now the one reporter (`resultErrorSource:
  'transport'`), pui shows the sentence after the diagnostic prefix, and an assistant line that only repeats
  the error is replaced by it.
- The battery logged a step stuck on a setup or connection screen, or answered by an account limit, as a
  normal duration; it now aborts with `BATTERY_BLOCKED`.

Host notes (not pui defects):

- The operator service spawned Codex by bare name and its PATH found a stale `~/.local/bin/codex` (0.157.1),
  which the server refuses the default model for: every Codex turn failed with a 400 that pui showed as nothing.
  Mitigated on this host; the durable fix is WI-10006412.
- `~/.codex/AGENTS.md` on this host carries the papercusp-su playbook, so Codex in the scratch project tried to
  take a file lock over the network before editing and the sandbox kept asking to escalate (13-edit timed out).
- Found on the full Codex leg, outside P-025: a relaunched `pui --solo` exited after "Starting PUI…", and the
  picked backend is not carried into the next launch (WI-10006423, blocks P-032).

## Where pui is already level or ahead

Instant echo and working line after Enter (P-024), history recall, multiline input (three ways), the @ file
picker, a shortcuts overlay, and mouse drag-copy.
