# A loop/carry process respawn kills native Bash run_in_background tasks — TaskOutput \"No task found\" (EI-16611)
URL: /internal/docs/agent-insights/cold-loop-wake-kills-native-background-bash-tasks

>

## The report (EI-16611)

Driving a fix in a **cold-carry** AUTO loop, one wake launched a long-running
integration test via the native Bash tool's `run_in_background: true` (task id
e.g. `bfdsrowp3`) and checkpointed `"await background task result"` as the
`next` action in its `loop:checkpoint` carry-note. The loop's next fire was a
**cold** reset (fresh context/process, carry-note-only continuity — by design,
see [engine-managed-loops](/internal/docs/agent-insights/engine-managed-loops)).
The successor called `TaskOutput('bfdsrowp3')` and got `"No task found with ID:
bfdsrowp3"` — the task, its output, and any partial progress were gone.

## Root cause: the registry is in-process memory, not a papercusp store

Unlike `work_items:checkpoint` / `loop:checkpoint` (rows in Postgres,
re-injected on the next read by design) or even `capability:bash`'s job
registry (`bash-jobs.ts`, living in the single long-lived **operator** process —
see
[capability:bash background jobs across calls](/internal/docs/agent-insights/capability-bash-background-jobs-across-calls)),
the native Claude Code Bash tool's `run_in_background`/`TaskOutput` bookkeeping
lives **inside the CLI child process's own memory**. That process is Anthropic's
own binary, not papercusp code — there is nothing in this repo to persist it
with. It survives for exactly as long as that one OS process keeps running and
keeps taking turns itself; the moment that process is replaced by a different
one, the registry is gone, even when the *logical* session/transcript
continues.

**Every one of these replaces the process**, so all of them lose native
background tasks, not just the "cold" case the report named:

| Trigger                                                                                                                                                                                                              | What happens to the OS process                                                       | Background task survives?                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Wake lands on the "alive + injectable pty" rung (`fireLoopWake`'s liveness ladder, [engine-managed-loops](/internal/docs/agent-insights/engine-managed-loops)) — the common warm case                                | Same process, just injected a turn ("press enter")                                   | **Yes**                                                                   |
| Wake lands on the "process exited → `claude --resume <sid>`" rung — still a **warm** loop                                                                                                                            | Old process is dead; `--resume` boots a **new** process reading the saved transcript | **No** — new process, empty registry, even though it's "the same session" |
| **Cold**-carry loop fire (`loop:arm { carry:'cold' }`)                                                                                                                                                               | Deliberate fresh context/process every fire, carry-note-only continuity              | **No**, by design                                                         |
| Compaction carry-respawn / cold-loop RECYCLE (`psu-pty-host.mjs`'s `recycleChild`, see [carry-respawn must reanchor native session id](/internal/docs/agent-insights/carry-respawn-must-reanchor-native-session-id)) | Old child killed, fresh `--session-id` minted for the successor                      | **No**                                                                    |
| `session:request-compaction` (the deliberate P-022 carry-respawn cut)                                                                                                                                                | Same shape as above                                                                  | **No**                                                                    |

So "same session" in the
[mid-turn-delivery backgrounding matrix](/internal/docs/agent-insights/coord-mid-turn-delivery)
(`"the harness re-invokes the SAME session when it exits"`) is true for the
*ordinary* continuous-turn case that table is about — it does **not** mean
"survives a loop/carry process boundary." Read literally out of context it's
easy to over-generalize into exactly this bug.

## The fix: never checkpoint a native task id across a process-respawn boundary

1. **Don't write `"await background task <id>"` (or any native `TaskOutput` id)
   as a loop's `next` action, ever** — cold loops always cross the boundary;
   warm loops cross it whenever the ladder lands on `--resume` (you cannot
   control or reliably predict which rung a given wake will hit), and a
   self-triggered `session:request-compaction` crosses it deliberately. Treat
   every loop/carry wake boundary as certain death for a native background
   task id.
2. **If the work fits in one wake, run it in the foreground instead.** A
   blocking `Bash` call before you checkpoint/end the turn is simpler and
   strictly safer than backgrounding-then-hoping the same process resumes.
3. **If the work genuinely must outlive a wake boundary, don't use native
   `run_in_background` for it — use `capability:bash { run_in_background:
   true }`.** That job lives in the **operator's** long-lived process, entirely
   independent of your CLI session's process lifecycle, so it survives your
   own loop/carry respawns (though not an *operator* restart —
   `capability:bash_output`'s `stranded_by_operator_restart` reason already
   distinguishes that, and see
   [capability:bash background jobs across calls](/internal/docs/agent-insights/capability-bash-background-jobs-across-calls)
   and
   [native Bash task killed under host overload](/internal/docs/agent-insights/native-bash-background-task-killed-under-host-overload)
   for its own caveats). Checkpoint the `bash_id` (not a native task id) as the
   next action — it's a stable, poll-from-anywhere reference.
4. **Polling within the same turn** (no wake boundary crossed) is unaffected —
   native `run_in_background` + `TaskOutput` remains the right, lightweight
   choice there.

No code change is proposed for the native Bash tool itself: it is Anthropic's
own CLI internals, outside this repo, and "make it durable across an arbitrary
process replacement" is not something papercusp can implement from here. The
durable fix available to us is this documented pattern, plus the
`capability:bash` escape hatch for the genuinely-must-survive case.

## Compounding trap: a "wrapper shell" completion notification can precede the real work finishing

A distinct but related gotcha (WI-5766/WI-5775, 2026-07-25), independent of any
respawn: the `cmd & echo launched pid $!` backgrounding idiom run via native
`Bash { run_in_background: true }` backgrounds the *inner* `cmd`, but the tool's
own tracked process is the *outer wrapper shell* — which exits (and fires a
"task completed" notification) the instant it has echoed the launched pid,
**not** when `cmd` itself finishes. A "task X: COMPLETED exit code 0"
notification is therefore *not* proof the real work is done; it only proves
the wrapper returned. Combined with the process-respawn loss above, this
produced a stale carried checkpoint claiming a job had completed when the real
child (verified via `ps`/`kill -0` on its actual pid) was still running minutes
later.

**Never background a command by wrapping it in your own `&`** — pass the
command directly with `run_in_background: true` and let the tool track the
real process; if you must wrap, treat "task completed" as proof only that the
wrapper exited and independently confirm the real work via its own pid/log/exit
marker before trusting or checkpointing a "completed" claim.
