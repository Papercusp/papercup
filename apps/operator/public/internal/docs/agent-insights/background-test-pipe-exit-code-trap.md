# Piping a background test run through `| tail -N` hides a real FAILURE behind exit code 0 (EI-8871)
URL: /internal/docs/agent-insights/background-test-pipe-exit-code-trap

run_in_background { command: \"npm run test:affected 2>&1 | tail -100\" } reports the harness's completion exit code for the PIPELINE's last stage (tail), not for npm run test:affected — so a genuinely failing test run can surface as a clean 'completed (exit code 0)' notification. Redirect to a log file instead of piping through tail/head when the run's own exit code matters.

## The trap

```bash
npm run test:affected 2>&1 | tail -100
```

run in the background (Bash tool `run_in_background: true`) to keep the captured
output bounded for a long `test:affected` run. The harness's background-task
completion notification reported **"completed (exit code 0)"** — but a shell
pipeline's exit code is the exit code of its **last stage**, which here is
`tail`, not `npm run test:affected`. `tail` almost always exits 0 (it
successfully read from its stdin and printed the last N lines) **regardless of
whether the upstream command failed**. The actual `npm run test:affected` had
exited 1 (2 failing test files + 5 uncaught exceptions) — fully invisible to
the exit-code summary, visible only by actually reading the captured output's
content.

This is a genuine completion-integrity trap, not operator error: `| tail -N` /
`| head -N` is the exact pattern the tooling nudges you toward to keep a long
run's captured output bounded, and it silently breaks the one signal (exit
code) an agent is most likely to trust at a glance before marking a work-item
done.

## Why `tail`/`head` swallow the real exit code

In `bash` (the default, no `pipefail`), `$?` after `cmd1 | cmd2` is `cmd2`'s
exit status. `set -o pipefail` would make the pipeline's exit code the
right-most **non-zero** stage instead — but that option is not on by default in
either an interactive shell or however the Bash tool invokes your command
string, so don't assume it's set.

`head -N` has an even sharper version of this trap: it can **exit before
`cmd1` even finishes** (once it has read N lines, it closes its end of the
pipe) — so `cmd1` may still be running, or may get `SIGPIPE`'d mid-write,
independent of whatever `head` reports.

## The safe pattern

Redirect to a **log file**, don't pipe through a truncating filter, and let
the *test command itself* be what the background task tracks:

```bash
# Bash tool call:
#   command: "npm run test:affected > /tmp/my-test-run.log 2>&1"
#   run_in_background: true
#   timeout: <the Bash tool's own timeout param, NOT a shell-level `timeout N` wrapper>
```

Then `Read` (or `TaskOutput`) the log file's tail once the task completes — the
background-task notification's exit code now genuinely reflects
`npm run test:affected`, and the log file holds the FULL output (not just the
last N lines) for a `grep` pass against specific files/modules you care about.

Two related, easily-conflated pitfalls to keep separate:

* **Don't wrap the command in a shell-level `timeout N`** — killing the process
  on timeout discards ALL captured output (you get a bare `"Terminated"`), even
  the portion that ran cleanly before the kill. Use the Bash tool's own
  `timeout` parameter (preserves partial output) instead.
* **`| tail -N` (this doc)** breaks the *exit code*, independent of the timeout
  question — you can avoid the shell-timeout trap and still hit this one if you
  redirect through `tail` instead of to a file.

If you must bound the SIZE of what streams back to you (not just the log file
on disk), redirect to the file as above and separately `tail -n 100
/tmp/my-test-run.log` as its own, later command — that `tail` no longer sits
inside the pipeline whose exit code you care about, so it can't mask anything.

## The verification habit that catches this regardless

Never trust a background-task "completed (exit code N)" summary alone as proof
a test suite passed — **read the captured output** (or grep it for the
framework's own pass/fail summary line, e.g. vitest's `Test Files  N failed |
M passed`) before calling `work_items:complete` / claiming a suite is green.
The exit code is a fast triage signal, not the verification itself; this
incident cost nothing precisely because the reporting agent independently
re-ran the two directly-relevant test files rather than trusting the green
notification alone — do that as standard practice, not as a lucky extra step.
