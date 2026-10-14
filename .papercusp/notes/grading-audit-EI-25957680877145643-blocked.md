# Grading-integrity audit EI-25957680877145643 — BLOCKED (no verdict emitted)

- Auditor session: su-e7854f7d-6123-41be-a327-ee083ea186ae (judge role, headless launch)
- Observed: 2026-10-14T13:06Z (UTC)
- Lease in kickoff: key `grading-audit:EI-25957680877145643`, reservedAt `2026-10-14T12:26:14.499Z`
- Target: spec-test-adequacy card EI-25957680877145643, subject
  `native-code-intelligence-ecosystem-and-dream-2026-10-09#AUTO-BAR-R-20-P-025@2`,
  fingerprint `3562f1aa97cfa61bd4728e1edaaaa38c2c6c28632be863b78d7278f5bcb928c2`

## What blocked it (observations, not an inferred cause)

1. This session's `papercusp` MCP server was reported disconnected. After the server
   re-sent its instructions, tool search still returned no `papercusp` tools
   (`scorecards`, `coord`, `events`, `code:run` all absent).
2. The sanctioned fallback `node scripts/mcp-call.mjs scorecards:get` exited 4 with
   ECONNREFUSED on ports 9171, 3070 and 9071. It failed both inside and outside the
   Bash sandbox.
3. `curl /api/health` on 9071, 9171, 3070 and 3170 returned 000. `ss -ltn` lists **zero**
   listening sockets, and the process is in netns `net:[4026542684]` with NoNewPrivs=1.
   So this session's shells run in an isolated network namespace and cannot reach loopback
   operator ports. This tells us nothing about whether the operator itself is up.

## Consequence

- The currentness guard (`scorecard.gradingAuditCurrentness.state`) could not be read. Per the
  brief, nothing was graded and no `scorecards:emit` was issued. The target stays `pending`
  for this auditor's side, so a re-dispatch is safe.
- The bug could not be filed with `improvements:capture` because no MCP route was reachable.
  Whoever reads this: please file it as a judge-launch defect. A headless judge was
  launched with an MCP client that has no tools, and its shell has no route to :9071, so the
  documented mcp-call recovery path cannot work from inside the session.
