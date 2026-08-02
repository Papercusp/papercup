# What opencode and OMP actually do for token reduction — cited to file:line
URL: /internal/docs/agent-insights/opencode-and-omp-token-reduction-mechanisms

A read of two other agent codebases installed on this box, opencode 1.4.0 and OMP (@oh-my-pi/pi-coding-agent) 17.0.7, enumerating every token-reduction and context-management mechanism with a file:line citation for each. Commissioned to replace a recalled, uncited comparison table. Four of that table's cells are struck: opencode's output cap is 2000 lines / 50 KB, not 1 MB; opencode DOES spill full output to disk and reference it by id; opencode's `code-mode.ts` does not exist at v1.4.0; and opencode's CRITICAL Task mandate is Anthropic-prompt-only, not universal. Adds four mechanisms the table missed entirely, including OMP's context 'shake' and its bitmap-image compaction. Contains no papercusp measurements and no adoption recommendation — deliberately.

## What this is, and what it deliberately is not

This is a **research read of two other codebases**, produced for the
`opencode-omp-token-reduction-research-2026-08-02` plan. It exists because a comparison
of papercusp's token-reduction mechanisms against opencode and OMP existed only as a
**recalled reading in a conversation, with no citations** — and the programme it fed had
already been burned once by optimising against an unmeasured premise.

So the standard here is: **a mechanism you cannot cite does not appear.** Striking a
recalled claim is a result. So is an explicit "could not determine". Both are worth more
than a plausible-sounding cell, because the plausible-sounding version already existed
and could not be built on.

Three things are **deliberately absent**, and their absence is not an oversight:

* **No "us" column.** No papercusp measurement appears here. The measurements belong to
  the leader who holds the corpus and the telemetry; a second uncoordinated measurement
  would be worse than none.
* **No recommendation.** Whether any of this is worth adopting depends on numbers this
  document does not contain.
* **No papercusp source was edited** to produce it.

***

## The ground being cited (P-001)

A finding against an unnamed version cannot be re-checked when the thing upgrades, so
both reads are pinned:

### opencode

|                       |                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package               | dpkg `open-code` **1.4.0** amd64, installed 2026-04-07                                                                                                                 |
| Binaries              | `/usr/bin/opencode-cli` (167,297,307 B, Bun-compiled ELF, BuildID sha1 `7336da5387ce01a05b890cdc77fe6287dde90d9c`) · `/usr/bin/OpenCode` (34,501,672 B, desktop shell) |
| Reported version      | `opencode-cli --version` → `1.4.0`                                                                                                                                     |
| Source on disk        | **None.** The binary embeds a bundle but not its `packages/opencode/src` module paths.                                                                                 |
| Source actually read  | upstream `github.com/sst/opencode` tag **v1.4.0** = commit **`98325dcdc6a566de6b7ab42cc87af544bed3658d`**, shallow-cloned to `/tmp/oc-src`                             |
| Runtime dirs observed | `~/.local/share/opencode/tool-output/` (the spill dir — present, empty) · `~/.config/opencode/opencode.json`                                                           |

Also on the box but **not** the installed CLI: npm `opencode-ai@1.2.27` under
`~/.nvm/versions/node/v22.21.1/lib/node_modules/opencode-ai` and an `~/.npm/_npx` cache
copy. Both are launcher shims for an older version; nothing below is cited against them.

All opencode citations below are relative to **`packages/opencode/src/`**.

### OMP

|                |                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Package        | `@oh-my-pi/pi-coding-agent` **17.0.7**                                                                                   |
| Install        | `~/node_modules/@oh-my-pi/pi-coding-agent`, bin `~/.bun/bin/omp` → `dist/cli.js` (12,788,331 B, minified)                |
| Source on disk | **Yes — the package ships its full TypeScript `src/`.** Citations are against the installed files directly, not a clone. |
| Upstream       | `github.com/can1357/oh-my-pi`, directory `packages/coding-agent`                                                         |

Sibling `@oh-my-pi/*` packages that also ship source: `pi-agent-core`, `pi-ai`,
`pi-utils`, `pi-wire`, `snapcompact`, `hashline`, `pi-catalog`, `pi-mnemopi`,
`omp-stats`.

All OMP citations below are relative to
**`~/node_modules/@oh-my-pi/pi-coding-agent/src/`**.

***

## The recalled table, adjudicated

Every cell of the hypothesis table, with a verdict:

| recalled claim                                                                                                              | verdict                           | what is actually there                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencode: batch tool calls in a script — `code-mode.ts`, "confined orchestration script with access to connected MCP tools" | **STRUCK**                        | No file matching `*code-mode*` exists anywhere in the v1.4.0 tree, and the phrase "confined orchestration script" appears in no `.ts`/`.txt`/`.md` file.                                                                                                                                                                                                         |
| opencode: output caps 1 MB + explicit `truncated` / `timeout` flags                                                         | **PARTLY STRUCK**                 | The cap is **2000 lines AND 50 KB** (`tool/truncate.ts:17-18`). No 1 MB constant exists on the tool-output path. The `truncated` flag is real (`tool/tool.ts:92`). A `timeout` *flag* is not — bash emits a timeout *message* (`tool/bash.ts:410`).                                                                                                              |
| opencode: spill full output, reference by id — **"—" (absent)**                                                             | **STRUCK — the opposite is true** | opencode writes the full untruncated output to `~/.local/share/opencode/tool-output/<ToolID>` and hands the model that id-named path (`tool/truncate.ts:104-107`), with a 7-day retention sweep.                                                                                                                                                                 |
| opencode: subagent as context firewall — `Task`, mandated in the system prompt                                              | **CONFIRMED, over-stated**        | The `Task` firewall is real and precise (see M6). The *mandate* is **Anthropic-prompt-only** — see P-003 below.                                                                                                                                                                                                                                                  |
| OMP: output caps 3000 lines / 50 KB / 512 columns                                                                           | **CONFIRMED, wrong file**         | Exactly right numerically (`session/streaming-output.ts:10-12`). The table attributed them to `output-meta.ts`; they are not there.                                                                                                                                                                                                                              |
| OMP: `output-meta.ts` (\~825 lines), `formatFullOutput…`                                                                    | **CONFIRMED**                     | `tools/output-meta.ts` is **825 lines**; `formatFullOutputReference(artifactId)` is at `:391`. It is the metadata *builder*, not the cap definition.                                                                                                                                                                                                             |
| OMP: `task.ts` + `vibe-spawn`/`send`/`wait`/`kill`/`list`, async task contracts + summary prompts                           | **CONFIRMED, two corrections**    | The tool names use **underscores**: `VIBE_TOOL_NAMES = ["vibe_spawn","vibe_send","vibe_wait","vibe_kill","vibe_list"]` (`tools/vibe.ts:50`). And **vibe is not the context firewall** — it drives *external CLI worker sessions* (`tools/vibe.ts:4-5`). The firewall is the `task` subsystem (`src/task/`, 25 files). There is no single `task.ts` under `src/`. |

**Four mechanisms the table missed entirely** are documented below: opencode's
tool-result *pruning* (M5, distinct from compaction), opencode's overflow arithmetic
(M3), OMP's context **shake** (O4), and OMP's **snapcompact** bitmap-image compaction
(O5).

***

## P-003 — the two quoted prompt lines: both VERIFIED, with a scope nuance

Both quotes exist verbatim. The nuance is the part a recalled reading cannot carry.

**Quote 1 — "prefer to use the Task tool in order to reduce context usage"** — exists in
**three** prompt variants, identical text in each:

* `session/prompt/anthropic.txt:79`
* `session/prompt/trinity.txt:83`
* `session/prompt/default.txt:91`

> `- When doing file search, prefer to use the Task tool in order to reduce context usage.`

**Quote 2 — the CRITICAL mandate** — exists in **exactly one** prompt:

* `session/prompt/anthropic.txt:86`

> `- VERY IMPORTANT: When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the Task tool instead of running search commands directly.`

**The nuance:** the *soft* preference is broad; the *hard* mandate is
**Anthropic-prompt-only**. `default.txt` and `trinity.txt` carry no CRITICAL line at all.
opencode ships at least ten prompt variants (`session/system.ts:5-13` imports
ANTHROPIC / DEFAULT / BEAST / GEMINI / TRINITY; the prompt dir also holds `codex.txt`,
`copilot-gpt-5.txt`, `gpt.txt`, `kimi.txt`, `plan.txt`, `max-steps.txt`,
`build-switch.txt`, `plan-reminder-anthropic.txt`).

So "opencode mandates Task" is true for one model family and false for the rest. Anyone
reasoning about how much of opencode's context saving is *attributable to the mandate*
has to condition on which prompt is loaded.

### ⚠ The tool that mandate names is DENIED here

opencode's design routes exploration through `Task`. **On this platform
`Task`/`Agent`/`Workflow` are denied for every psu launch** by owner mandate 2026-07-02
(`NO_SUBAGENT_TOOLS_DENY`, `libs/papercusp/packages/orchestrator/src/no-subagent-deny.ts`).
Verified in the session that produced this document:
`ToolSearch { query: "select:Task,Agent" }` → no matching deferred tools found.

The mechanism is described faithfully below regardless — that is what the read was for.
But the mechanism **as opencode implements it is not available here**, and a design that
assumes it will not run. Precedent for exactly this failure: our own su prompt kept
recommending `Task` for a month after the deny landed (EI-19277117902219188).

The general form of that lesson, which binds while reading this document: **your live
toolset outranks any prompt, doc, or brief — including this one.**

***

## opencode — the mechanisms

### M1 · Universal tool-output truncation with on-disk spill

`tool/truncate.ts` is the whole thing, and it is short.

| constant    | value                  | line  |
| ----------- | ---------------------- | ----- |
| `MAX_LINES` | `2000`                 | `:17` |
| `MAX_BYTES` | `50 * 1024` (51,200 B) | `:18` |
| `RETENTION` | `Duration.days(7)`     | `:15` |

* Output passes through **unchanged only when it satisfies both caps** — `lines.length <= maxLines && totalBytes <= maxBytes` (`:70-72`). It is an AND, so a 10-line 60 KB blob truncates.
* Slicing is `head` by default, `tail` optionally (`:26-28`, `:66`, `:79-99`); the byte budget is charged per line including its newline.
* The elision notice reports **bytes** if the byte cap bound first, otherwise **lines** (`:101-102`) — the two caps are distinguishable in the output the model sees.
* **The spill:** the full untruncated text is written to `path.join(TRUNCATION_DIR, ToolID.ascending())` (`:104-107`) — a monotonic tool id, i.e. reference-by-id. `TRUNCATION_DIR` is `Global.Path.data + "/tool-output"` (`tool/truncation-dir.ts:4`), which is the `~/.local/share/opencode/tool-output/` observed on this box.
* **Expiry:** a forked loop runs `cleanup` hourly after a one-minute startup delay (`:123-131`), deleting `tool_`-prefixed entries older than the 7-day retention (`:51-61`).

**It is applied universally, not per tool.** `tool/tool.ts`'s `wrap()` runs every tool's
`execute` and then unconditionally pipes the result through `Truncate.output` (`:86`),
rewriting `output` and stamping `metadata.truncated` / `metadata.outputPath`
(`:87-95`). `define()` wraps every tool (`:101-109`).

The single opt-out is `:83-85`:

```ts
if (result.metadata.truncated !== undefined) return result
```

A tool that reports its own truncation state bypasses the universal pass. That is the
seam `grep`, `glob` and `ls` use (M2).

### M2 · Per-tool caps that pre-empt the universal one

* `tool/read.ts` — `DEFAULT_READ_LIMIT = 2000` lines (`:16`), `MAX_LINE_LENGTH = 2000` chars per line (`:17`) with a `... (line truncated to 2000 chars)` suffix (`:18`), `MAX_BYTES = 50 * 1024` (`:19`). Emits a resumable hint: `(Output capped at 50 KB. Showing lines A-B. Use offset=N to continue.)` (`:195`, `:197`).
* `tool/bash.ts` — `MAX_METADATA_LENGTH = 30_000` (`:24`, sliced at `:273-274`); `DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000` (`:25`); on expiry appends `bash tool terminated command after exceeding timeout N ms` (`:410`). Notably the bash **tool description interpolates the live limits** — `.replaceAll("${maxLines}", String(Truncate.MAX_LINES))` and the same for `MAX_BYTES` (`:469-470`) — so the model is told the caps rather than discovering them.
* `tool/grep.ts` — `truncated = matches.length > limit` (`:107-108`); header `Found N matches (showing first L)` (`:119`); per-line truncation (`:130-132`); footer `(Results truncated: showing L of N matches (H hidden). Consider using a more specific path or pattern.)` (`:135-138`); sets `metadata.truncated` (`:151`) and so opts out of M1.
* `tool/glob.ts:38-73`, `tool/ls.ts:116`, `file/ripgrep.ts:330` — same pattern, own limits, own `truncated` flag.

### M3 · Overflow detection — the auto-compaction trigger

`session/overflow.ts`, 22 lines, entire arithmetic:

```ts
const COMPACTION_BUFFER = 20_000                                        // :6
if (input.cfg.compaction?.auto === false) return false                  // :9
const count = tokens.total || tokens.input + tokens.output
            + tokens.cache.read + tokens.cache.write                    // :13-14
const reserved = cfg.compaction?.reserved
               ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(model))   // :16-17
const usable = model.limit.input
             ? model.limit.input - reserved
             : context - maxOutputTokens(model)                         // :18-20
return count >= usable                                                  // :21
```

Two properties worth naming because they differ from the common heuristic:

1. **It is absolute-token and model-limit-derived, not a percent-of-window rule.** The reserve is `min(20k, the model's own max output)`, so a small-output model reserves less.
2. **Cache-read and cache-write tokens count toward the window** (`:14`). Prompt caching (M7) reduces *cost*, not *occupancy*.

### M4 · Compaction — summarize and replace

`session/compaction.ts`:

* A **dedicated named agent** performs it — `agents.get("compaction")` (`:179`), invoked with `mode: "compaction", agent: "compaction"` (`:229-230`).
* Plugins may **inject context into or wholly replace** the compaction prompt via the `experimental.session.compacting` hook (`:183-185`); the prompt is `compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")` (`:219`).
* Failure is explicit and distinguishes two causes (`:274-278`): `"Conversation history too large to compact - exceeds model context limit"` vs `"Session too large to compact - context exceeds model limit even after stripping media"`.
* The result is a first-class message part — `type: z.literal("compaction")` (`session/message-v2.ts:208`); `session/processor.ts:26` types the loop verdict as `"compact" | "stop" | "continue"` and returns `"compact"` on `ctx.needsCompaction` (`:486`).

### M5 · Prune — evicting old tool-result bodies **without** summarizing

This is a mechanism the recalled table did not have, and it is cheaper than M4 because
it involves no model call at all.

| constant                | value       | line  |
| ----------------------- | ----------- | ----- |
| `PRUNE_MINIMUM`         | `20_000`    | `:35` |
| `PRUNE_PROTECT`         | `40_000`    | `:36` |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | `:37` |

The source comment states the intent exactly (`:91-92`): *"goes backwards through parts
until there are PRUNE\_PROTECT tokens worth of tool calls, then erases output of older
tool calls to free context space"*.

The walk (`:108-127`) has four stop conditions worth knowing:

* `if (turns < 2) continue` (`:111`) — **the two most recent user turns are never pruned**.
* `if (msg.info.summary) break loop` (`:112`) — stops at the last summary boundary.
* `if (part.state.time.compacted) break loop` (`:118`) — stops at the already-pruned region, so the walk is incremental rather than re-scanning history.
* `skill` tool results are exempt (`:117`).

Everything beyond the newest 40k tokens of tool output is queued, and the queue is only
*applied* if it totals more than 20k tokens (`:130-138`) — a hysteresis band that avoids
churning the history for small wins. Applied parts get
`part.state.time.compacted = Date.now()`.

**What the model then sees** — `session/message-v2.ts:718`:

```ts
const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
```

and `:719` drops that part's attachments (images, PDFs) as well. So the tool **call and
its arguments remain** in history; only the **result body** is replaced by a fixed
33-character string. The model retains the fact that it ran `grep foo` and lost what
`grep foo` said.

Note the interaction with M1: if that result was large enough to have been truncated, a
copy of the full text is still on disk in the spill dir for up to 7 days — so pruning is
irreversible *in context* but not necessarily *on disk*.

### M6 · The subagent context firewall, and its economics (P-004)

`tool/task.ts`, 169 lines. The economics are the part a summary loses, so they are
itemised.

**What the model can see.** The tool description is built from `Agent.list()` filtered to
`mode !== "primary"` (`:16-21`), and the dynamic variant additionally filters by
permission — `Permission.evaluate("task", a.name, agent.permission).action !== "deny"`
(`:158-169`). An agent is only shown subagents it is allowed to call.

**What a spawn costs the parent.** The parent pays for one tool call whose result is
bounded by:

```
task_id: <sessionID> (for resuming to continue this task if needed)

<task_result>
<the child's LAST text part>
</task_result>
```

— `:136-144`. The extraction is literally
`result.parts.findLast((x) => x.type === "text")?.text ?? ""` (`:136`). **Every child
tool call, every intermediate assistant message, every file the child read is discarded
from the parent's context.** Because `task.ts` sets no `metadata.truncated`, that result
is itself subject to M1, so the parent-visible task result is *additionally* capped at
2000 lines / 50 KB.

**What is discarded vs. merely hidden.** Nothing is deleted. The child is a real session
row with `parent_id` (`session/index.ts:96`), enumerable via `Session.children(parentID)`
(`session/index.ts:448-454`). It is hidden from the parent's *context*, not from the
system.

**What the parent is billed.** The child inherits the parent's model unless the agent
config overrides it — `agent.model ?? { modelID/providerID of the parent assistant
message }` (`:98-101`) — so the child's tokens are real API spend at the same per-token
rate, on the same account, simply accounted to a different session id. Cost is computed
per assistant message from `tokens.input/output/cache.read/cache.write/reasoning`
(`session/index.ts:296-302`).

One small saving is explicit: `session/prompt.ts:193` — `if (input.session.parentID)
return` inside `ensureTitle`. **A child session skips the title-generation model call.**

**Recursion and tool bounds.** The child session is created with deny rules unless the
subagent's own permission grants them: `task` denied (`:78-86`) — so **depth-1 by
default** — and `todowrite` denied (`:69-77`); both are also disabled in the child's tool
map (`:129-130`). `config.experimental.primary_tools` are re-allowed in the child
(`:87-91`) and disabled for it as tools (`:131`).

**Resumption.** `task_id` resumes the same child session with its previous messages and
tool outputs intact (`:29-34`, `:60-62`) — the child's context persists server-side
across calls while never entering the parent.

**What the prompt instructs** — `tool/task.txt`:

* `:17` — *"When the agent is done, it will return **a single message** back to you. The result returned by the agent is not visible to the user… The output includes a task\_id you can reuse later to continue the same subagent session."*
* `:18` — *"Each agent invocation starts with a **fresh context** unless you provide task\_id… your prompt should contain a highly detailed task description for the agent to perform autonomously and you should **specify exactly what information the agent should return back to you in its final and only message to you**."*
* `:16` — *"Launch multiple agents concurrently whenever possible… use a single message with multiple tool uses"*
* `:9-12` — an explicit NOT-to-use list: a specific file path → Read/Glob; `class Foo` → Glob; code within 2-3 known files → Read. The firewall is scoped to *exploration*, not to all reading.

#### The coupling worth noticing: the spill and the firewall are one system

`tool/truncate.ts:30-33` defines:

```ts
function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}
```

and the truncation hint **branches on it** (`:109-111`):

* **with `task`:** `"…Full output saved to: <file>\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context."`
* **without `task`:** `"…Full output saved to: <file>\nUse Grep to search the full content or Read with offset/limit to view specific sections."`

That is the design in one place: **overflow is spilled to disk, and then a subagent is
directed to read the spill so the bytes never enter the parent's context.** Truncation
without a firewall just defers the problem to whoever reads the file; opencode wires them
together so the reader is disposable.

### M7 · Prompt caching

`provider/transform.ts:192-215`, `applyCaching`:

* `system` = the first **2** system messages (`:193`); `final` = the last **2** non-system messages (`:194`).
* Per-provider marker (`:196-212`): anthropic and openrouter `cacheControl: {type:"ephemeral"}`, bedrock `cachePoint: {type:"default"}`, openaiCompatible `cache_control: {type:"ephemeral"}`, copilot `copilot_cache_control: {type:"ephemeral"}`.
* Applied to `unique([...system, ...final])` (`:214`) — **at most 4 cache breakpoints**.

Cost lever only; per M3 the cached tokens still occupy the window.

***

## OMP — the mechanisms

### O1 · Output caps — confirmed numbers, corrected location

`session/streaming-output.ts`:

| constant                      | value                                     | line  |
| ----------------------------- | ----------------------------------------- | ----- |
| `DEFAULT_MAX_LINES`           | `3000`                                    | `:10` |
| `DEFAULT_MAX_BYTES`           | `50 * 1024`                               | `:11` |
| `DEFAULT_MAX_COLUMN`          | `512` — *"Max chars per grep match line"* | `:12` |
| `ARTIFACT_DEFAULT_MAX_BYTES`  | `0` — **`0` means unbounded**             | `:20` |
| `ARTIFACT_DEFAULT_HEAD_BYTES` | `3 * 1024 * 1024` (3 MiB)                 | `:22` |

The recalled numbers were right; the recalled file was not — `tools/output-meta.ts` is the
metadata *builder* (825 lines, as recalled), and the caps live in `streaming-output.ts`.

The **third dimension is the interesting one**: `DEFAULT_MAX_COLUMN = 512` caps
characters *per line*, and is stateful across streaming chunks so a mid-line split still
respects the budget (`:870-873`). opencode has a per-line cap only inside `read` and
`grep`; OMP applies it at the sink.

The comment at `:850-851` states the intent of the split explicitly: *"Live preview gets
the raw (pre-cap) chunk so the TUI never lags behind what reached the sink — the column
cap is for the persisted LLM view."* The human sees uncapped output; the model sees the
capped one.

### O2 · Truncation direction and the metadata envelope

`session/streaming-output.ts` exports `truncateMiddle` and `truncateTail` alongside head
truncation (imported at `tools/output-meta.ts:19`), and `TruncationMeta.truncatedBy` is
typed `"lines" | "bytes" | "middle"` (`tools/output-meta.ts:26-28`). **Middle-elision is
a first-class mode** — opencode has head and tail only (`tool/truncate.ts:27`).

`tools/output-meta.ts` builds a structured envelope rather than only a text notice:
`TruncationMeta` (`:26`), `SourceMeta` (`:52`), `DiagnosticMeta` (`:60`), `LimitsMeta`
(`:68`), `OutputMeta` (`:78`), including `nextOffset` for pagination
(`:45`). Three ingestion paths exist — from a `TruncationResult` (`:125`), from an
`OutputSummary` (`:193`), and by *detecting* truncation in already-truncated text
(`:262-268`).

Notices are rendered by `formatTruncationMetaNotice` (`:445`), which for a middle elision
reports `Showing N of M lines; middle elided` (`:459`) and appends the artifact reference
when one exists (`:461-462`).

### O3 · The artifact store — OMP's spill design (P-006)

This is the mechanism most fully specified on the OMP side, so it is itemised against
the five questions the plan asked.

**Where it is stored.** Per-session, on disk. `artifactsDirectoryFor(sessionFile)` is
simply the session file path with its `.jsonl` suffix stripped
(`session/session-manager.ts:94-96`) — session `<x>.jsonl` gets directory `<x>/`. The
directory is created lazily on first write (`session/artifacts.ts:59-63`).

**Under what identifier.** Sequential integers per session.
`ArtifactManager.allocatePath(toolType)` returns
`{ id: String(this.allocateId()), path: <dir>/<id>.<toolType>.log }`
(`session/artifacts.ts:101-106`); `allocateId()` is `this.#nextId++` (`:92-94`). On
resume, `#scanExistingIds()` re-derives the counter by parsing `^(\d+)\..*\.log$` from
the directory listing so a resumed session does not overwrite prior artifacts
(`:74-86`).

**One ID space across the whole agent tree.** The class doc-comment states it
(`session/artifacts.ts:34-36`): *"Subagents do not own their own `ArtifactManager`. The
parent's instance is adopted via `SessionManager.adoptArtifactManager`, so the whole
parent + subagent tree shares one ID space and one directory."* Implemented at
`session/session-manager.ts:1347-1349` and `:1342-1345`. Consequently **a subagent's
artifact id is directly addressable by the parent** — an `artifact://7` written by a
child resolves for the parent.

**What the agent sees instead of the full output.** A preview plus an internal URL.
`sdk.ts:1577` returns `` `${preview}\nFull output: artifact://${artifactId}` ``;
`session/streaming-output.ts:631` appends `` `[raw output: artifact://${artifactId}]` ``
so the composed result stays under `maxBytes` (`:614`); `tools/gh.ts:2432` does the same
for GitHub results.

**How it is fetched back — with sub-ranges.** `artifact://` is one of the internal URL
schemes handled by the read tool (`tools/read.ts:2195`, `:3108`; scheme list at
`tools/bash-skill-urls.ts:272` — `skill://`, `agent://`, `artifact://`, `memory://`,
`rule://`, `local://`). The notable capability is a **selector grammar**:
`tools/path-utils.ts:376` and `:401` cite real forms `artifact://3:raw:-100` and
`artifact://5:1-50`, and `tools/read.ts:822` cites `artifact://5:conflicts:1-1`. So the
agent can fetch a *line range* or a *named section* of a spilled artifact rather than
the whole blob. `splitInternalUrlSel` (`tools/path-utils.ts:387`) peels those selectors,
including common malformed shapes, so errors surface as selector errors rather than as
misleading "host invalid" errors.

**Whether anything expires. No.** `ArtifactManager` (`session/artifacts.ts`, 153 lines)
has **no retention, TTL, sweep, or prune path** — its surface is `allocateId`,
`allocatePath`, `save`, `exists`, `listFiles`, `getPath`. Artifacts live exactly as long
as the session directory does. **This is the sharpest single contrast with opencode**,
whose spill is swept hourly on a 7-day retention (`tool/truncate.ts:15`, `:51-61`,
`:123-131`).

**Non-persistent sessions degrade gracefully:** `SessionManager.saveArtifact` falls back
to an in-memory `Map` with its own counter *"so spill truncation still works"*
(`session/session-manager.ts:1359-1368`).

**Streaming, not post-hoc.** The spill is written as the output streams, not after it
completes. `OutputSink` mirrors the **raw, pre-column-cap** chunk to the artifact file so
the on-disk record is lossless, and triggers that mirror on *"in-memory overflow OR this
chunk's column cap dropped bytes OR file already open"*
(`session/streaming-output.ts:877-880`). Default `spillThreshold = DEFAULT_MAX_BYTES`
(50 KB, `:787`). When an on-disk cap *is* configured, the sink keeps a head budget plus a
rolling tail ring and flushes the tail behind an `[ARTIFACT TRUNCATED: …]` notice
(`:768-776`) — but the default is unbounded precisely so *"advertised `artifact://<id>`
captures are lossless"* (`:772-773`).

### O4 · "Shake" — recoverable in-place context eviction

The mechanism the recalled table missed entirely, and the closest OMP analogue to
opencode's prune (M5) — except **recoverable**.

`session/agent-session.ts:10833` — `shake(mode, opts)` with
`ShakeMode = "elide" | "images"` (`session/shake-types.ts:9`):

* **`elide`** *"replaces whole tool-call results and large fenced/XML blocks with short placeholders that embed an `artifact://` recovery link"* (`:10824-10825`).
* **`images`** delegates to `dropImages()` (`:10834-10836`).

The elide path (`:10839-10881`): collect regions under a config (default
`AGGRESSIVE_SHAKE_CONFIG`, `:10841`) that skips anything already summarized away by the
latest compaction — *"shaking them only churns persisted history with no prompt/cache
effect"* (`:10842-10844`); write **all** region contents into **one** artifact
(`#saveShakeArtifact`, `:10851`, `:10897`); replace each region with a placeholder;
then `rewriteEntries()` → `agent.replaceMessages()` → reset advisor runtimes → tear down
provider sessions that cache message identity (`:10869-10873`).

The placeholder is the whole point (`:10884-10889`):

```ts
`[shaken ~${region.tokens} tokens — recover: artifact://${artifactId} (region ${index + 1})]`
```

with a bare `[shaken ~N tokens]` fallback when the session is not persisted. Compare
opencode's fixed `"[Old tool result content cleared]"` (`session/message-v2.ts:718`):
OMP's placeholder tells the model **how much was removed and how to get it back**;
opencode's tells it neither.

`ShakeResult` reports `toolResultsDropped`, `blocksDropped`, `imagesDropped`,
`tokensFreed` (`session/shake-types.ts:12-21`) and renders as
`Shook … (~N tokens freed).` (`:42`).

Reachable manually as `/shake` (`slash-commands/builtin-registry.ts:1490`,
`modes/controllers/command-controller.ts:1256`) **and automatically** — see O6.

### O5 · Compaction modes, including bitmap-image archival

`session/compact-modes.ts:47-65` defines three:

| mode          | description (verbatim from source)                                                  |
| ------------- | ----------------------------------------------------------------------------------- |
| `soft`        | *"Summarize locally with the active model (skip remote endpoints)"*                 |
| `remote`      | *"Summarize via the remote endpoint / provider-native compaction"*                  |
| `snapcompact` | *"Archive history onto dense bitmap images the model reads back (**no LLM call**)"* |

**`snapcompact` is the outlier and the table missed it.** It converts history into dense
bitmap images the model reads back through vision, so compaction costs **no summarization
model call** at all. Implementation is `session/snapcompact-inline.ts` (frames capped by
`MAX_SYSTEM_PROMPT_FRAMES = 6`, `:51`; tool results swapped for frames at `:431-486`)
plus a dedicated `@oh-my-pi/snapcompact` package and supporting prompt stubs
(`src/prompts/system/snapcompact-*.md`).

### O6 · The tiered dead-end rescue — where shake and compaction compose

`session/agent-session.ts:13706` — `#rescueCompactionDeadEnd`, whose doc-comment
(`:13685-13705`) states the failure it exists for: the summarizer cut at the only
available turn boundary, but the kept tail is *still* over the recovery band because one
recent turn is itself bigger than the band and `findCutPoint` cannot cut inside a single
message.

* **Tier 1 — `shake("elide")`** *"reaches INSIDE that tail"* (`:13692`, called `:13716`). Skipped if this pass already shook (`skipElide`).
* **Tier 2 — `dropImages()`** (`:13743`), the manual `/shake images` remedy automated. It runs only after elide fails the progress re-test, and the comment gives the reason (`:13696-13698`): *"unlike elided text they are NOT artifact-recoverable"*.

Each tier that rewrote history re-anchors the in-flight snapshot
(`#rebasePendingContextSnapshotAfterCompaction`, `:13724`, `:13744`), the caller's
progress predicate is re-tested, and the first tier that restores progress emits one
notice and stops (`:13731-13738`, `:13750-13757`). Failure of both falls through to a
dead-end warning.

**The ordering rule is worth extracting on its own: recoverable reductions are attempted
before irrecoverable ones.** Elided text can be fetched back from `artifact://`; dropped
images cannot; so images are the later tier.

### O7 · Subagents: `task` is the firewall, `vibe` is something else

Two corrections to the recalled row.

**`vibe_*` is not the context firewall.** `tools/vibe.ts:50` —
`VIBE_TOOL_NAMES = ["vibe_spawn","vibe_send","vibe_wait","vibe_kill","vibe_list"]`
(underscores, not hyphens). The header comment (`:4-5`) describes them as *"Five thin
tools over `VibeSessionRegistry`: spawn/send/wait/kill/list persistent worker sessions
("fast"/"good" CLIs)"* — they drive **external CLI worker processes**, each rendered
as a live screen in a TUI "TV wall" (`:9-10`). `vibe_spawn` returns immediately with a
session id and job id and tells the model to keep working (`:118`). That is a
parallel-work primitive, not a context firewall.

**The firewall is the `task` subsystem** — `src/task/`, 25 files including
`executor.ts`, `spawn-policy.ts`, `parallel.ts`, `isolation-runner.ts`,
`structured-subagent.ts`, `yield-assembly.ts`, `output-manager.ts`, `worktree.ts`,
`prompt-policy.ts`, `persisted-revive.ts`. There is no single `task.ts` under `src/`.

**Its result contract is a template, and it spills like everything else** —
`src/prompts/tools/task-summary.md`:

```
<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `hub` to resume instead of redoing the work.</abort-reason>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
...
</task-result>
```

Three things follow that opencode's `<task_result>` (M6) does not do:

1. The parent is told **how big the discarded output was** — `<meta lines size />` (`:2`).
2. A truncated subagent result is itself **spilled and id-referenced**: `<preview full-output="agent://{{id}}">` (`:7`). The subagent-result path and the tool-output path use the same spill idiom.
3. An aborted subagent advertises that it is **still live with its full context** and should be messaged rather than redone (`:4`).

Caps on a subagent's own output are env-overridable
(`task/types.ts:53`, `:56`):

```ts
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);
```

— note these are **an order of magnitude larger** than the 50 KB / 3000-line tool-output
caps, i.e. a subagent is allowed to return substantially more than a tool call is.

**The async contract** — `src/prompts/tools/task-async-contract.md`, quoted in full
because it is one paragraph and every clause is load-bearing:

> *"No polling is needed. Inspecting a settled job with `hub jobs` or `hub wait` makes that snapshot its delivery, so no duplicate `async-result` follows. Job IDs live in process memory for roughly five minutes after settlement; afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`. `completed` means the subagent yielded successfully, not that claimed artifacts were verified."*

Three designed properties: **push not poll**; **a short-lived in-memory job id with a
durable id to fall back to**; and an explicit **anti-trust clause** — `completed` is a
statement about the yield, not about the work.

Subagent sessions are stored *inside* the parent's artifacts directory as
`<parent>/<agentId>.jsonl`, and `resolveBreadcrumbToInteractiveRoot` walks back up
(depth-capped at 8) so `--continue` resumes the real conversation rather than a subagent
transcript (`session/session-manager.ts:98-117`).

***

## Side-by-side, every cell cited or struck

No "us" column, by design.

| mechanism                                   | opencode 1.4.0                                                                                                  | OMP 17.0.7                                                                                                                                        | confidence    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **Line cap on tool output**                 | 2000 — `tool/truncate.ts:17`                                                                                    | 3000 — `session/streaming-output.ts:10`                                                                                                           | High          |
| **Byte cap on tool output**                 | 50 KB — `truncate.ts:18`                                                                                        | 50 KB — `streaming-output.ts:11`                                                                                                                  | High          |
| **Per-line/column cap**                     | only within tools: `read.ts:17` (2000 ch), `grep.ts:130-132`                                                    | global at the sink: `DEFAULT_MAX_COLUMN = 512` — `streaming-output.ts:12`, applied `:870-873`                                                     | High          |
| **Cap combination**                         | AND — both must pass — `truncate.ts:70`                                                                         | per-dimension, tracked separately in `TruncationMeta` — `output-meta.ts:26-28`                                                                    | High          |
| **Truncation directions**                   | head, tail — `truncate.ts:27`                                                                                   | head, tail, **middle** — `output-meta.ts:28`, `:19`                                                                                               | High          |
| **Applied universally?**                    | **Yes** — every tool result via `tool/tool.ts:86`; opt-out at `:83-85`                                          | Per-sink (`OutputSink`), wired per tool — `bash.ts:20`, `eval.ts:12`                                                                              | High / Medium |
| **Full output spilled to disk**             | **Yes** — `truncate.ts:104-107`                                                                                 | **Yes** — `session/artifacts.ts:101-119`                                                                                                          | High          |
| **Spill identifier**                        | monotonic `ToolID` as filename — `truncate.ts:104`                                                              | sequential int per session, `<id>.<tool>.log` — `artifacts.ts:104`                                                                                | High          |
| **Spill addressed as**                      | a filesystem path in the hint text — `truncate.ts:110-111`                                                      | a URL scheme `artifact://<id>` — `sdk.ts:1577`, `streaming-output.ts:631`                                                                         | High          |
| **Sub-range fetch of a spill**              | not as a spill feature; generic `Read` offset/limit — `truncate.ts:111`                                         | **yes, selector grammar** `artifact://5:1-50`, `artifact://3:raw:-100`, `artifact://5:conflicts:1-1` — `path-utils.ts:376`, `:401`, `read.ts:822` | High          |
| **Spill ID space across subagents**         | per-session dirs, no shared id space found                                                                      | **shared parent+subagent id space** — `artifacts.ts:34-36`, `session-manager.ts:1347-1349`                                                        | High          |
| **Spill expiry**                            | **7 days**, hourly sweep — `truncate.ts:15`, `:51-61`, `:123-131`                                               | **none** — `artifacts.ts` has no retention path (153 lines, full surface read)                                                                    | High          |
| **Spill written when**                      | after the fact, on overflow — `truncate.ts:106-107`                                                             | **streaming, raw/pre-cap** — `streaming-output.ts:877-880`                                                                                        | High          |
| **Model told the caps**                     | yes — bash description interpolates them, `bash.ts:469-470`                                                     | via `LimitsMeta` in the output envelope — `output-meta.ts:68`                                                                                     | High / Medium |
| **Overflow trigger**                        | absolute tokens vs `model.limit.input - reserved`, `reserved = min(20k, maxOutput)` — `overflow.ts:6`, `:16-21` | budget-reserve vs context window — `agent-session.ts:13673-13683`                                                                                 | High / Medium |
| **Cache tokens count toward window**        | **yes** — `overflow.ts:14`                                                                                      | not determined                                                                                                                                    | High / —      |
| **Compaction**                              | dedicated `"compaction"` agent, plugin-replaceable prompt — `compaction.ts:179`, `:183-185`, `:219`             | three modes: `soft`, `remote`, **`snapcompact`** — `compact-modes.ts:47-65`                                                                       | High          |
| **Compaction without an LLM call**          | none found                                                                                                      | **`snapcompact`** — bitmap images read back by vision — `compact-modes.ts:58-63`                                                                  | High          |
| **Evict tool results without summarizing**  | **prune** — `compaction.ts:35-37`, `:93-139`                                                                    | **shake("elide")** — `agent-session.ts:10833-10882`                                                                                               | High          |
| **…protection band**                        | newest 40k tokens of tool output + last 2 user turns — `compaction.ts:36`, `:111`                               | config-driven; skips post-compaction-boundary entries — `agent-session.ts:10840-10845`                                                            | High / Medium |
| **…hysteresis**                             | only fires if >20k tokens would be freed — `compaction.ts:35`, `:130`                                           | none found                                                                                                                                        | High / Low    |
| **…what the model sees after**              | `"[Old tool result content cleared]"` — `message-v2.ts:718`                                                     | `"[shaken ~N tokens — recover: artifact://<id> (region N)]"` — `agent-session.ts:10886`                                                           | High          |
| **…recoverable by the model?**              | **No** in-context pointer (the spilled copy may exist for ≤7d, unlinked)                                        | **Yes**, by design — the placeholder carries the recovery URL                                                                                     | High          |
| **Image/attachment dropping**               | attachments dropped with pruned parts — `message-v2.ts:719`; `stripMedia` option                                | `dropImages()` / `/shake images` — `agent-session.ts:10834-10836`                                                                                 | High          |
| **Tiered reduction ladder**                 | none found — prune and compact are separate paths                                                               | **yes** — `#rescueCompactionDeadEnd`, elide → dropImages, recoverable first — `agent-session.ts:13685-13760`                                      | Medium / High |
| **Subagent context firewall**               | `task` — child session, only last text part returns — `task.ts:65`, `:136-144`                                  | `task` subsystem (`src/task/`, 25 files); result template `prompts/tools/task-summary.md`                                                         | High          |
| **…parent-visible result**                  | `task_id` + `<task_result>` + last text part, then capped by M1 — `task.ts:138-144`                             | `<task-result>` + `<meta lines size/>` + `<preview full-output="agent://id">` — `task-summary.md:1-14`                                            | High          |
| **…parent told the discarded size**         | **no**                                                                                                          | **yes** — `<meta lines size />`, `task-summary.md:2`                                                                                              | High          |
| **…subagent result itself spilled**         | no (truncated by M1, spilled as any tool output)                                                                | **yes**, `agent://<id>` — `task-summary.md:7`                                                                                                     | High          |
| **…recursion depth**                        | 1 by default — `task` denied in child — `task.ts:78-86`, `:130`                                                 | governed by `task/spawn-policy.ts` (not read in detail)                                                                                           | High / Low    |
| **…resumable**                              | yes, `task_id` — `task.ts:29-34`, `:60-62`                                                                      | yes, `hub send` / `agent://<id>` / `history://<id>` — `task-async-contract.md`                                                                    | High          |
| **…subagent output caps**                   | inherits 2000 lines / 50 KB (M1)                                                                                | `MAX_OUTPUT_BYTES=500_000`, `MAX_OUTPUT_LINES=5000`, env-overridable — `task/types.ts:53`, `:56`                                                  | High          |
| **…async / no-poll contract**               | synchronous `await SessionPrompt.prompt` — `task.ts:120`                                                        | explicit push contract, \~5 min job-id memory — `task-async-contract.md`                                                                          | High          |
| **…"done" ≠ verified warning**              | none found                                                                                                      | **explicit** — *"`completed` means the subagent yielded successfully, not that claimed artifacts were verified"*                                  | High          |
| **Prompt-mandated firewall use**            | yes but **Anthropic-prompt-only** for the hard form — `anthropic.txt:86`; soft form in 3 prompts                | not located in the prompts read                                                                                                                   | High / Low    |
| **Prompt caching**                          | ≤4 breakpoints, first 2 system + last 2 messages — `transform.ts:192-215`                                       | not determined                                                                                                                                    | High / —      |
| **External CLI worker fan-out**             | none found                                                                                                      | `vibe_spawn/send/wait/kill/list` — `tools/vibe.ts:50`                                                                                             | Medium / High |
| **"Code mode" / script-batched tool calls** | **STRUCK — does not exist at v1.4.0**                                                                           | not searched                                                                                                                                      | High / —      |

***

## Could not determine

Recording these explicitly, because an honest gap is worth more than a plausible cell.

* **Wall-clock cost of an opencode subagent spawn.** Not measurable by reading; would need a run.
* **Whether opencode rolls child-session cost into the parent's displayed totals.** Cost is computed per assistant message (`session/index.ts:296-302`) and children are separate session rows; no aggregation path was located, but the search was not exhaustive.
* **OMP's prompt-caching strategy.** Not located in the files read.
* **Whether OMP's cache tokens count toward its overflow arithmetic** (opencode's do — `overflow.ts:14`).
* **OMP's exact compaction thresholds.** `resolveBudgetReserveTokens` / `compactionContextTokens` are imported into `agent-session.ts` (`:59`, `:69`) but their defining module was not read.
* **OMP's `AGGRESSIVE_SHAKE_CONFIG` / `DEFAULT_SHAKE_CONFIG` values** — referenced at `agent-session.ts:10841`, `:14528`; the defining module was not located.
* **OMP's subagent recursion depth policy** — `task/spawn-policy.ts` exists but was not read.
* **`code-mode.ts` in opencode's other 18 packages.** Absent from `packages/opencode/src` and no file in the tree matches `*code-mode*`; a full-repo content search for the concept under another name was not run.
* **Whether OMP applies its caps as universally as opencode's `tool.ts:86` does.** `OutputSink` is wired per tool (`bash.ts`, `eval.ts`, …) rather than at a single choke point, but no exhaustive audit of every tool was performed.

## What would change these findings

Both codebases move fast — OMP went 15.5.13 → 16.3.3 → 17.0.7 within recent months, and
this box's opencode is a pinned dpkg from April. Re-run against the pinned identifiers in
the ground section before treating any number here as current. The two cheapest re-checks
are `tool/truncate.ts:17-18` (opencode's caps) and `session/streaming-output.ts:10-12`
(OMP's) — if those four constants still read as documented, the rest of the structure has
almost certainly not moved.
