# Codex exec_command: intermittent parallel-launch process-creation failures are not owned by any papercusp code
URL: /internal/docs/agent-insights/codex-exec-command-parallel-launch-race

Codex CLI's native exec_command / \"unified exec\" host-side spawner intermittently fails process creation (ENOENT / CreateProcess / CREATE_PROCESS_NO_SUCH_FILE) when several calls launch concurrently, especially right after a service restart. No papercusp repository code implements this executor; the fix is retry sequentially, not a code change here.

Codex CLI's native `exec_command` tool (the "unified exec" host-side process
spawner — see [managed command execution parity](/internal/docs/agent-insights/managed-command-execution-parity-and-break-glass))
has an **intermittent, non-deterministic process-creation failure** when
several `exec_command` calls are launched **concurrently** (a `Promise.all`
fan-out, or several parallel tool calls in one turn). The failure surfaces
under several cosmetic error-code spellings depending on Codex CLI build —
`CreateProcess`, `CreateProcess_ENOENT`, `CreateProcess ... No such file or
directory (os error 2)`, and `CREATE_PROCESS_NO_SUCH_FILE` are all the **same
underlying failure class**, not distinct bugs. The command itself is valid
(commonly a plain `/bin/bash -lc '...'`), the workdir is valid, and sibling
calls in the same batch routinely succeed — only one (or a minority) of the
concurrent launches fails.

# Root cause is outside this repository

**No papercusp repository code owns this executor.** A direct investigation
(EI-21379455011371458) searched non-generated source for the reported
unified-exec failure and found no Papercusp implementation surface, then ran
12/12 parallel `exec_command` shell probes, 8/8 parallel exact `ptool`
probes, and a 24-way stress probe at current HEAD with **zero**
process-creation ENOENT failures (one unrelated MCP request timeout).

This is a **client-side Codex CLI internal** (its own process/PTY spawning
machinery under concurrent load), not a Papercusp server-side or
`capability:*` code path — `exec_command` bypasses the Papercusp managed
command family entirely (it is Codex's *native* tool). It cannot be fixed by
editing anything in this repository.

# Post-restart correlation

At least one report (EI-22068257636480930) observed the failure specifically
as "a second post-restart parallel diagnostic failed to create /bin/bash
before execution" — i.e. the race appears more readily immediately after a
service restart, plausibly because system load / process-table churn is
elevated in that window. This is consistent with (not contradicting) the
"client-side concurrency race" root cause: a race that is latent under normal
load is more likely to trigger when the host is already busy.

# What to do when you hit this

1. **Retry the SAME call sequentially** (one `exec_command` at a time instead
   of in parallel). This has reliably resolved every reported instance —
   including the post-restart case above, where the identical command
   succeeded once retried outside the parallel batch.
2. **Do not treat it as evidence of a papercusp regression** — no code here
   implements the spawner. Searching this repository for the literal error
   string will find nothing (confirmed by grep at time of writing).
3. **Do not re-run the full non-reproduction investigation again.** It has
   already been performed and closed at least three times
   (EI-21379455011371458 done, EI-21422142281375933 dropped,
   EI-21424860056325867 dropped) plus this doc's own origin item
   (EI-22068257636480930). If you are triaging a NEW `improvements:capture
   toolFailure` report matching this signature — tool `exec_command`, an
   error code that is one of `CreateProcess`, `CreateProcess_ENOENT`, or
   `CREATE_PROCESS_NO_SUCH_FILE` (or prose containing "No such file or
   directory (os error 2)"), with a command/workdir that is otherwise VALID
   and fired concurrently with sibling calls — close it by citing this doc
   and the prior investigations rather than re-running probes from scratch.
   Distinguish this from the separate, **already-fixed**, unrelated class of
   `exec_command` failures caused by a genuinely **mistyped `workdir`** (e.g.
   EI-21159177533103669, EI-21275405769790467, EI-21596868384138643,
   EI-20197135763978086) — those are real path typos, not this race, and the
   fix there is "use the correct path", not "retry sequentially".
4. If the failure becomes reliably reproducible (not merely intermittent) or
   starts to block real work at a meaningful rate, that would be new evidence
   worth escalating upstream to the Codex CLI project — it remains outside
   this repository's fix surface either way.
