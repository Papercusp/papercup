**You are running under OMP (Oh My Pi).** Use OMP's native state and
workflow tools — they are invisible to Papercusp unless you reach for
them deliberately.

Do not use Claude task-panel tools (`TaskCreate`, `TaskUpdate`,
`TaskGet`, `TaskList`, or the generic `task` subagent launcher) in OMP
sessions — they are not stable here and may fail, flap between turns, or
burn extra budget. Track work with `todo_write` instead.

- `todo_write` — create a phased todo list for any task with 3+ steps,
  update it after each completed step, and leave it accurate for a
  successor. Put actual work items in the list, not implementation
  mechanics.
- `goal` — use for autonomous / overnight loops when the user has given
  a broad objective. Keep the goal concrete and pair it with a visible
  `todo_write` list.
- `job` — use for long-running local commands that do not need your
  attention while they run. Poll or inspect the job before claiming the
  work is done.
- `checkpoint` / `rewind` — use before broad exploratory branches (large
  searches, speculative debugging, multi-path investigation). Rewind
  with a concise report so exploration does not pollute the working
  context.
- `tools:find` → `tools:invoke` — before saying a tool does not exist,
  call `tools:find("<what you need>")` for the exact name, then
  `tools:invoke {name, args}` to run it (server-side; no load step, works
  even for a tool hidden behind discovery). Do not reach for a native
  keyword tool-search — `tools:find`/`tools:invoke` are the path.
- `lsp` — use for symbol-aware definitions, references, diagnostics,
  code actions, and renames when a language server is available.
- `recipe` — use to discover project task-runner commands instead of
  guessing package scripts.
- `debug` — prefer over ad-hoc prints when you need breakpoints, stack
  frames, thread state, or to interrupt a hung process.
- `eval` — use for small, stateful experiments and data shaping; do not
  use it to bypass project tests.
- `ask` — use only when the user must choose between materially
  different tradeoffs. Otherwise use repo conventions and proceed.
- `irc` — use only for live coordination with OMP subagents in this
  process. Papercusp coordination (`coord:*`, `locks:*`, handoffs,
  escalations) remains the durable cross-session authority.
- `omp:sessions` — use to list/search/read local OMP session history,
  especially when a handoff or successor brief references an origin
  session id.

File-lock enforcement is **automatic here**: the coordination extension
(`papercusp-coord.ts`, loaded by `omp-su` via `-e`) claims a lock on each
file edit through its `tool_call` hook and **blocks the edit (with the
holder's intent) when another agent holds the file**. When blocked,
pivot/retry/yield — don't route around it. Hand-call `locks:acquire`
only for a multi-file change held across the commit (see the base
playbook's "File locking is ENFORCED" section).

For compaction-sensitive work, write successor briefs that name the
origin OMP session id and the relevant plan/session state. The next
agent should start by calling `omp:sessions op='state'` and targeted
`omp:sessions op='search'` before relying on a compressed summary alone.

**Verification & diagnosis tasks — enumerate, don't invent.** When a task
asks you to *verify / check / audit / reconcile* one thing (a doc, a list,
a config) **against** an authoritative source (a registry, the code, a
schema) and fix what is wrong, do NOT skim for something that merely
*looks* wrong and fix that — inventing a plausible-sounding defect instead
of finding the real one is the single most common way these tasks fail.
Follow these steps exactly and in order:

1. **List the authoritative source's entries.** Open the source of truth
   the task names (the resolver / registry / schema / code to check
   against) and write out the concrete set of valid names or values it
   defines. This is your allow-list.
2. **List what the target references.** Open the thing under review and
   write out each concrete name or value it references or claims.
3. **The defect is the set difference — nothing else.** A "dead", "stale",
   "drifted", or "broken" reference is *exactly* a target entry (step 2)
   that is ABSENT from the authoritative list (step 1). Fix only those. Do
   NOT treat counts, prose wording, formatting, or anything you merely
   *suspect* as the defect unless the task explicitly named it.
4. **If step 3 yields nothing, there is no defect.** Report "verified, no
   discrepancies found" and stop — a no-op backed by the two lists above is
   a correct, complete result. Never manufacture a change just to have done
   something.
5. **Only now edit** — remove or fix exactly the mismatched entries from
   step 3 and nothing adjacent to them.

If which file or registry is authoritative is unclear, `ask` before
editing — never guess the source of truth and never substitute your own
idea of what "should" be wrong.
