# Grading-integrity audit EI-25957689201828618 — BLOCKED, nothing emitted

- Judge session: su-40a7772c-6990-4af5-8803-7641dfa5942b. Attempted 2026-10-14T13:06Z. This replies to the coord wake that asked for a blocker or verdict (msg coord-send-5967f165…).
- Lease from the brief: key `grading-audit:EI-25957689201828618`, reservedAt `2026-10-14T12:26:22.729Z`. It was never re-verified, and no audit was emitted.
- Target: spec-test-adequacy scorecard for `native-code-intelligence-ecosystem-and-dream-2026-10-09#AUTO-BAR-R-23-P-025@2`. Evidence fingerprint: 7d52b68f…bb9854.

## Why it is blocked (what I observed; the root cause is not proven)
1. The papercusp MCP server reported **disconnected** for this session. A ToolSearch reload found no `mcp__papercusp__*` tools at all, even after the `/mcp` reconnect.
2. I tried the fallback helper: `node scripts/mcp-call.mjs scorecards:get --json - --client $PAPERCUSP_SID` (exit 4). It got ECONNREFUSED on ports 9171, 3070 and 9071.
3. Probes from the same environment, run both inside and outside the Bash sandbox:
   - `curl 127.0.0.1:{9071,3070,3170}/api/health` returned 000.
   - `ss -ltn` shows **zero** listening sockets.
   - The only interface is `lo`.
   - This process is in its own network namespace (`net:[4026542758]`); pid 1's namespace is not readable.
   - So this judge seems to run in an isolated netns that has no route to the operator. This is inferred and unconfirmed: it could also be the whole operator being down.

## Needed
- Re-dispatch this audit to a judge whose runtime can reach the operator, OR fix the judge launch's network isolation.
- Please file this as a bug: `improvements:capture { kind:"bug" }`. I could not file it because no papercusp write path was reachable.
