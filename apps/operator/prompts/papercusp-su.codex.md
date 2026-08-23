**You are running under Codex CLI.** Use Codex's own native tools for
planning, task tracking, and session recovery — here they are the
stable, correct choice.

> The OMP-native tool list (`todo_write`, `omp:sessions`, `goal`, `job`,
> `checkpoint`/`rewind`, `search_tool_bm25`, `recipe`, `eval`, `irc`)
> and the Claude task-panel tools (`TaskCreate`, `TaskList`, …) do not
> exist in Codex — don't reach for them.

- **Task tracking / planning** — use Codex's native plan tool
  (`update_plan`, shown as the **Updated plan** panel) to maintain a
  visible step list for any task with 3+ steps; keep it current as you
  complete steps.
- **Edits & shell** — use Codex's built-in `apply_patch` and shell tools
  rather than inventing scratch files.
- **Session recovery** — resume prior context with `codex resume`
  (`--last` for the most recent); sessions live under
  `$CODEX_HOME/sessions`. There is no `omp:sessions` equivalent to call.

Papercusp coordination is the same on every client: use `coord:*` and
`locks:*` (not a client-local tool) as the durable cross-session
authority for presence, handoffs, escalations, and file claims. For
compaction-sensitive work, write a successor brief naming the relevant
plan/session state before context is summarized.

**Finding a capability:** the superuser MCP catalog is large (~550 tools).
The visible MCP tools are only an initial seed. To locate the right tool
for an intent when you don't already know its name, call
`tools:find("<what you need>")` — a hybrid semantic+lexical search over
the full catalog — then call the returned tool directly.

**Codex MCP-deferral fallback:** never infer that a Papercusp capability
is unavailable merely because its MCP schema is absent from the current
model-facing tool list. If the whole `papercusp-su` namespace is missing,
including `tools:find`, use the installed CLI over the same MCP transport:

```bash
ptool_scope=(--workspace="${PAPERCUSP_WORKSPACE}")
if [[ -n "${PAPERCUSP_HARNESS_SLUG:-}" ]]; then
  ptool_scope+=(--harness="${PAPERCUSP_HARNESS_SLUG}")
fi
ptool tools:find --json - "${ptool_scope[@]}" <<'JSON'
{"query":"<what you need>"}
JSON
```

Then call the returned name with quoting-safe stdin JSON:

```bash
ptool <group:verb> --json - <<'JSON'
{...}
JSON
```

Use `--json-file` when a payload is easier to prepare as a file. Do not put
arbitrary JSON in shell single quotes: an apostrophe in completion evidence or
another string breaks the shell before `ptool` runs. (You can also route the
call through `ptool tools:invoke`.) `ptool` preserves this psu session's
`PAPERCUSP_SID`, so coordination, claims, and audit attribution remain
attached to you. This is the sanctioned escape hatch for a Codex release that
lists MCP tools internally but defers all of them; it is not evidence that the
server or capability is missing.

## An empty `exec_command` result means YIELDED, not failed — pass `yield_time_ms: 30000`

`exec_command` **yields at 10 seconds by default** (`yield_time_ms`, range 250–30000 ms).
On yield it returns *whatever has been emitted so far* — for a `ptool` call, which buffers its
JSON and writes it in one shot at the end, that is **zero bytes** — and hands back a
`session_id` while your command **keeps running**. Nothing is killed and nothing is lost.

**Pick by how long the call might take — the two remedies have different ceilings:**

- **Under ~30s (the common case): pass `yield_time_ms: 30000`.** One call, no extra steps.
  Covers `coord:orient`, `plans:get`, `work_items:list`, `release:trace`, `tools:invoke` and
  every `ptool` invocation above. This is a fix, not a workaround.
- **Unknown duration, or possibly over 30s: use two-call file capture** (below). `yield_time_ms`
  is capped at **30000 ms — a hard maximum, not headroom** — so it raises the yield boundary
  rather than removing it. File capture has **no ceiling**: measured intact at 16.8s / 5,722 bytes,
  and it does not care how long the command runs.

Either way, if you do get a yield, **poll the `session_id`** — the output is there.

**Read the envelope, never an exit code — a yielded call has NO `exit_code` field:**

| envelope | meaning | what to do |
|---|---|---|
| `session_id` present, **`exit_code` absent**, `output: ""` | **YIELDED** — still running | poll the `session_id` (`write_stdin`) for the full output |
| `exit_code` present | genuinely **COMPLETED** | this is a real result |

⛔ **An empty `output` with a `session_id` is not a failure, not an empty dataset, and NOT a
papercusp tool bug.** Do not retry it, do not conclude the tool returned nothing, and do not
file it — roughly 20 agents each independently misread this as a defect in whichever tool they
happened to be calling, producing ~35 duplicate bug reports against `coord:orient` / `ptool` /
`tools:invoke`. It is tracked and settled as **WI-40869**.

### Two-call file capture — the shape with no ceiling

```bash
# call 1 — redirect; this call's own output does not matter, and may well yield
ptool <verb> --json - … >/tmp/o.json 2>/tmp/o.err
# call 2 — read it back; fast, finishes far under any yield
cat /tmp/o.json
```

⚠ **It must be TWO calls.** A redirect and its `cat` in one command still exceeds the yield, so the
`cat`'s output is yielded away too and you see empty *again* — and would wrongly conclude the
workaround failed. The file itself is never at risk: the command runs to completion regardless, so
the bytes are on disk waiting for call 2.

<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-START -->
Codex file-lock policy is resolved from runtime evidence, never from a static
assumption. The generated **Codex Lock Enforcement Status** section at the end
of this prompt carries exactly one effective `lockMode` plus hook health.
`coord:orient.codexLocks` is the live authority after launch and supersedes the
launch snapshot when its generation changes. Follow that one instruction; do
not combine the automatic and manual paths.
<!-- PAPERCUSP-CODEX:LOCK-GUIDANCE-END -->
