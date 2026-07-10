# Injecting precomputed state into an agent's prompt (the wake-brief pattern)
URL: /internal/docs/agent-insights/agent-prompt-state-injection

Five load-bearing rules for handing an agent a precomputed state snapshot in its prompt instead of making it gather state via tools — tail-not-prefix (cache), strip the framing delimiter (breakout), only-tell-it-to-skip-reads-actually-in-the-brief (blindness), fresh-per-wake makes a stateless digest safe, and fail-soft to tools. Generalized from the Mug wake-brief.

## What

When you precompute state and hand it to an agent **in its prompt** (so its
first turn is a decision, not 5 survey tool calls), you are doing *prompt-state
injection*. The Mug wake-brief (\[\[mug-brief-cache-assembly-2026-06-13]]) is
the reference implementation. The pattern is reusable for any agent — but it has
five non-obvious traps. All five were live bugs or near-bugs in that build.

## The five rules

1. **Volatile state goes in the TAIL, never the cached prefix.** Prompt caching
   is a strict prefix match — any byte change before a breakpoint invalidates the
   cache for everything after it. A per-wake snapshot changes every wake, so
   splicing it into the persona/system prefix yields a 0% hit rate on the most
   valuable block. Render it as a `<system-reminder>` appended to the **volatile
   tail** (`buildPrompt({ queenBrief })` → `prompt-build.ts`), after the cached
   preamble. **Verify with a preamble-byte-stability test**: build two prompts
   that differ ONLY in the injected content and assert `wake1.preamble ===
   wake2.preamble` (see the MUG preamble test in `prompt-build.test.ts`).

2. **Strip the framing delimiter from embedded content (breakout defense).** The
   injected block wraps free-text the agent or *other* agents authored — a
   carry-note, ranked work-item titles, change-feed/escalation summaries. A
   literal `</system-reminder>` anywhere in that content closes the wrapper early
   and the following text reads as un-framed operator instructions. Strip it
   before wrapping — mirror the existing `wrapUntrusted` `DELIMITER_RE` defense
   (`SYSTEM_REMINDER_RE` in `prompt-build.ts`). This is content-confusion even
   when the content isn't "remote": a work-item title is semi-untrusted.

3. **Only tell the agent to skip a read whose content is ACTUALLY in the brief.**
   The big win is the agent NOT re-running the tools the brief replaces — so you
   teach "don't call `pot:survey` / `coord:inbox` / … to gather this." But if a
   read is listed in that skip-set while its content is **not** folded into the
   brief, the agent goes **blind** to it. This was a real bug: the brief told the
   Mug to skip `coord:inbox`, but the floor didn't carry the inbox →
   handoffs/acks/plan-events invisible. Keep the skip-set and the
   actually-injected set **identical**; carve out anything not folded in, or fold
   it in (we folded it in — D-021).

4. **Fresh-per-wake makes a read-only "recent" digest of a stateful source
   safe — no watermark needed.** Folding a delta-shaped source (an inbox) looks
   hard: "new since last wake" implies a per-agent watermark, and advancing it at
   precompute time risks marking items seen on a wake that then fails. But if the
   consuming agent is **fresh-per-wake / stateless** (no memory of last wake), it
   already re-reads the source from scratch every wake with no unread-tracking —
   so a read-only *recent* digest in the brief is **equivalent** to its own tool
   call. Skip the watermark; just cap a recent window. (If the agent were a
   long-lived session, you'd need the watermark.)

5. **Fail-soft to the tools, and teach the whole-brief-absent fallback.** The
   precompute must degrade to `null`/empty on any error so the launch still fires
   and the agent falls back to gathering state itself. Each sub-gather should fail
   independently (one flaky read drops its section, not the brief). And the
   persona must say: *"if the brief is absent, gather it yourself"* — otherwise a
   best-effort failure leaves a skip-instructed agent with nothing.

## Why it matters

Rules 2 and 3 are silent correctness bugs (breakout / blindness) that pass every
happy-path test — the kind a "marked done" feature hides. Rule 1 is the entire
point of the feature (a leak into the prefix destroys the cache it exists to
build). Rule 4 is the difference between "this is a hard deferred design task"
and "this is a 20-line read-only digest." When you build (or review) any
prompt-state-injection feature, walk these five explicitly.

## See also

* \[\[mug-brief-cache-assembly-2026-06-13]] — the reference build (D-001 tail-not-prefix, D-015 breakout strip, D-017/D-021 skip-set consistency + inbox fold).
* `agent-insights/pot-mug-fresh-per-wake` — why the Mug is stateless per wake (rule 4's precondition).
* `agent-insights/mcp-tool-surface-prompt-cache` — the prefix-cache mechanics this rides on.
