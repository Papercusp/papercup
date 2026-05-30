---
title: SSE typed-events — round-11 rebase audit
slug: sse-typed-events-rebase-note-from-main-round11
status: shipped
created: 2026-05-12
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** **Status:** I found two security bugs in your T2.3 WIP (`scratch-uri.ts` and `app/api/scratch/[...path]/route.ts`) and applied fixes directly to your working-tree files. The files are still in your `?? untracked` state so your eventual commit captures my fixes naturally — but I want you to read the rationale before squashing, because both are real issues.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Round-11 audit findings — T2.3 scratch-uri / scratch route

**Status:** I found two security bugs in your T2.3 WIP (`scratch-uri.ts` and
`app/api/scratch/[...path]/route.ts`) and applied fixes directly to your
working-tree files. The files are still in your `?? untracked` state so
your eventual commit captures my fixes naturally — but I want you to read
the rationale before squashing, because both are real issues.

If you've already replaced the files in your worktree since I touched them,
re-apply the patches below. If you'd rather solve them differently, that's
fine — the *what* is non-negotiable, the *how* is yours.

## Bug #26: workspaceId `..` escapes the scratch base — **CRITICAL**

`WORKSPACE_REGEX` is `/^[A-Za-z0-9._:-]+$/` which **allows literal `..`**.
A scratch URI with `workspaceId="..": `

- `scratchRootForWorkspace("..")` returned `dirname(scratchRoot())` —
  outside the global scratch base.
- `safeScratchFilesystemPath`'s containment check was against the
  per-workspace root (already escaped), so it passed.
- Net: a tool emitting `outputRef: papercusp://scratch/../<tool>/<run>/<file>`
  could write into the homedir parent. Read path same.

Reproducer:
```ts
import { safeScratchFilesystemPath } from './lib/scratch-uri';
process.env.PAPERCUSP_SCRATCH_ROOT = '/tmp/scratch-test-root';
const uri = 'papercusp://scratch/../my.tool/12345678-1234-1234-1234-123456789012/file.txt';
console.log(safeScratchFilesystemPath(uri));
// BEFORE: /tmp/my.tool/12345678.../file.txt   ← OUTSIDE scratch base
// AFTER:  throws ScratchUriError
```

**Fix applied** to `lib/scratch-uri.ts`:

1. `parseScratchUri`: explicit `workspaceId === '.' || workspaceId === '..'`
   reject after the regex check. Same for `toolName`.
2. `scratchRootForWorkspace`: same explicit reject.
3. `safeScratchFilesystemPath`: containment check now verifies the
   resolved path is under **both** `wsRoot` AND `scratchRoot()` (the
   global root). The double check is defense-in-depth in case the
   regex relaxes in future.

**Regression tests** added to `lib/scratch-uri.test.ts`:
- `rejects "." as workspace`
- `rejects ".." as workspace`
- `rejects "." as toolName`
- `rejects ".." as toolName`

25/25 tests pass.

## Bug #27: XSS via tool-authored scratch — **High**

`guessContentType` returned `text/html` for `.html` and `image/svg+xml` for
`.svg`. Scratch is tool-authored bytes — a tool writing
`<script>alert(document.cookie)</script>` to `scratch.html` would be served
inline-executable. If a chat surface renders a scratch URL as a clickable
link, opening it executes in the operator's loopback origin.

Even with loopback-only bind, the attack vector is real: chat is rendered
in a browser tab that *is* the operator's origin; cookies for any other
local origin reachable from loopback are exposed.

**Fix applied** to `app/api/scratch/[...path]/route.ts`:

1. Always set `Content-Disposition: attachment; filename="<basename>"` so
   browsers download rather than inline-render.
2. Always set `X-Content-Type-Options: nosniff` so browsers don't override
   our content-type via MIME sniffing.
3. Downgrade `text/html` → `text/plain` in `guessContentType`.
4. Downgrade `image/svg+xml` → `application/octet-stream` (SVG can carry
   `<script>` tags).
5. Downgrade `text/markdown` → `text/plain` (some browsers/extensions
   render markdown inline).

## Minor — flagged, not fixed

- `clearAllBuffersForTests` in `packages/agent-mcp/src/replay-buffer.ts`:
  doc comment says "Called by the workspace-registry change handler" but
  the function is only called from tests. Either drop the doc claim or
  wire the call. Buffer keys include `workspaceId` so this is doc-drift
  not a security gap.
- `apps/operator/lib/agent-tools/architect/chat.ts:11-12`: doc comment
  refers to the deleted Hono shims. Cosmetic.

## Tests passing on my side
- `lib/scratch-uri.test.ts` 25/25
- `lib/scratch-gc.test.ts` 9/9
- `lib/rate-limit.test.ts` 5/5
- `packages/agent-mcp` 137/137
- `apps/operator lib/agent-tools` + memory + auth + user-preferences: 276/277 (1 pre-existing `projects:list` unrelated)
- drift 22/0, tsc clean

## Coordination — what I won't commit

These files are still in *your* working tree as untracked. I left my fixes
applied so your `git add + git commit` captures them. If that's the wrong
ergonomics for you, revert my edits and apply this note's patches yourself.

Plan-doc reference: phase-4-endpoint-system-2026-05-12.md § T2.3.
Audit-round reference: audit round 11.
