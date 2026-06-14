# Worker log — EI-20 (auto-implement, attempt 2)

## Bug
:3070 hono-host fatal-exited via the deliberate fail-fast `unhandledRejection`
guard with `SyntaxError: Unexpected end of JSON input` — stack was only
`at parse (<anonymous>)` + `processTicksAndRejections`, ZERO user frames. An
async `JSON.parse`/`res.json()` on an empty/truncated body somewhere, during the
agent-briefs wave (~20 sessions hammering the host, host restarting mid-stream).
Unattributable → unfixable-by-grep. Asks: (1) make fatal parse failures carry
async context; (2) audit unguarded empty-body parse sites.

## Root cause (the implicated site)
`packages/operator-core/lib/agents-list.ts` `computeAllAgents()` did
`const projData = (await projR.json())` UNGUARDED after only an `if (!projR.ok)`
check. A 200 with a zero-byte/truncated body (host restarting mid-stream) passes
`res.ok` but rejects in `.json()` with the exact frame-less SyntaxError. This is a
hot path: cross-harness agent enumeration polled by the agents UI / delegate MCP
during the wave. (Sibling `fetchOneSlug` at line 53 already guarded with
`.catch(() => null)`; line 71 did not.)

## Fix (self/inline-sized)
1. New helper `readJsonBody<T>(res, context?)` in
   `packages/operator-core/lib/loopback-fetch.ts` — the natural home; that file
   already makes loopback failures self-diagnosing (`describeFetchError`, EI-390).
   It reads the body as text FIRST, then `JSON.parse`; on failure it rethrows an
   Error naming the URL (explicit context or `res.url`), HTTP status, and body
   byte length (+ a body snippet, or "(empty body)"), preserving the original
   SyntaxError as `cause`. A frame-less crash becomes attributable to a route.
2. Migrated the implicated hot site `agents-list.ts:71` to `readJsonBody(projR)`.

Did NOT touch the fail-fast policy in `bin/hono-host.ts` (issue explicitly says
not to — deliberate EI-11 choice) and did NOT touch the authority RPC parse site
(`authority/http-peer-rpc-transport.ts` — protected lock-authority surface).

## Tests (regression, fails-before/passes-after)
Added 4 cases to `packages/operator-core/lib/loopback-fetch.test.ts`:
well-formed parse; EMPTY body → attributable "0 byte body ... (empty body)";
TRUNCATED body → names URL + "HTTP 200" + "19 byte body" + cause is SyntaxError;
falls back to `res.url` when no context. (Before the helper, the empty-body case
is the frame-less `Unexpected end of JSON input` that killed :3070.)

## Verification
- `cd packages/operator-core && npx vitest run lib/loopback-fetch.test.ts` →
  32 passed (incl. 4 new). EXIT 0.
- `npm run test:affected` (root) → 1383 files / 14147 tests passed, 12 skipped,
  4 todo. EXIT 0. "All affected tests passed."

## Follow-up (noted, NOT done — out of self-sized scope)
Other host-side loopback `.json()` sites mostly already guard with
`.catch(() => null)`. `spawnable-templates.ts:42` guards on `r.ok` only (still
empty-body-vulnerable, low traffic) — could adopt `readJsonBody` later. The
helper is now available repo-wide for that hardening.

## For the validator to re-verify
- The helper's error message format + that `cause` is the original SyntaxError.
- That `agents-list.ts` still type-checks and returns the same shape.
- No other UNGUARDED host-side loopback `.json()` in the hot wave path.
