# A \"torn\" workspace-registry read can recur even after the write side is atomic — widen the read retry budget, don't re-fix the writer
URL: /internal/docs/agent-insights/workspace-registry-torn-read-retry-budget

EI-21148378726402614: two concurrent MCP calls hit \"Unexpected end of JSON input\" reading ~/.papercusp-workspaces/registry.json, and the file was valid again seconds later — AFTER the WI-39392 atomic-write fix (temp+unique-per-write-name+rename) was already deployed. The writer wasn't the remaining gap; the reader's one-shot retry was. Also: writeRegistry lacked the fsync the Rust writer already had.

## Symptom

Two independent concurrent MCP calls both fail with `-32603` because
`readRegistry()` (`packages/operator-core/lib/workspace-registry.ts`) throws
`WorkspaceRegistryUnreadableError` — the underlying cause is
`SyntaxError: Unexpected end of JSON input` reading
`~/.papercusp-workspaces/registry.json`. A bounded re-read moments later finds
the file perfectly valid. This is the exact shape of the WI-39392 "torn
write" bug that atomic `writeRegistry()`/`write_registry()` (TS + Rust) were
built to eliminate — except **the fix was already deployed** when this
recurred (confirmed via `dev:pipeline_position { path: '.../workspace-registry.ts' }`:
the incident's own observed runtime sha matched the deployed sha, which
already carried the WI-39392 commit).

## Don't re-derive "which writer is still non-atomic" — there probably isn't one

The instinct on seeing this symptom is to go hunt for a writer that still does
a plain `writeFileSync(registryPath, ...)` (truncate-then-write) instead of
temp-file-then-`rename`. Before doing that expensive search again:

1. Check whether the atomic-write fix (WI-39392) is actually **deployed and
   running**, not just committed — `dev:pipeline_position { path }` on
   `workspace-registry.ts`, and confirm `positions.deployed: true` with a
   `deployedSha` that is a descendant of (or equal to) the commit that added
   the unique-per-write temp name. If the incident's own
   `freshnessEnvelope.observedRuntimeSha` is a match, the deployed code
   already has the fix — the writer is not your bug.
2. Both writers to this exact file (`packages/operator-core/lib/workspace-registry.ts`'s
   `writeRegistry()` and `papercusp-desktop/src-tauri/src/workspaces.rs`'s
   `write_registry()`) are the ONLY writers — every other code path that
   touches the registry (`ensurePapercuspWorkspace`, `registerPapercupHarness`,
   the `/workspaces/switch` route, etc.) goes through one of those two
   helpers. There is no third writer left to find; re-grepping for one is
   wasted effort.

## The actual remaining gaps (fixed here)

With the write side genuinely atomic, `rename()` is atomic on POSIX, so a
reader should NEVER observe a torn file — but the READ side had only ONE
immediate, zero-delay retry (`readRegistry()` re-read the file exactly once
more, synchronously, on a parse failure). That is enough headroom for the
race the write-side fix already eliminated, but not enough margin for
whatever OTHER transient window can still surface on a heavily-parallel fleet
(page-cache scheduling under load, a filesystem quirk, another process's I/O
contention — the exact producer doesn't need to be pinned down for the fix to
be correct). Two changes:

1. **`writeRegistry()` now fsyncs the temp file before renaming**
   (`openSync` + `writeSync` + `fsyncSync` + `closeSync` + `renameSync`),
   matching what the Rust `write_registry()` already did (`file.sync_all()`).
   This doesn't change same-process read visibility (page cache is already
   consistent the moment `writeFileSync` returns) — it closes a durability
   gap (a crash between rename and disk flush) and removes an unexplained
   asymmetry between the two writers when diagnosing a future incident.
2. **`readRegistry()`'s retry is now a bounded loop** (5 retries, 4ms apart,
   using the repo's existing `Atomics.wait` synchronous-sleep idiom — see
   `scripts/pg-autotune.ts`) instead of one instantaneous re-read. This only
   costs anything on the exception path (a parse failure already happened);
   the happy path is unaffected. A **genuinely** corrupt registry still
   exhausts the budget and throws `WorkspaceRegistryUnreadableError` — this
   does NOT relax WI-6734's "never silently treat a corrupt registry as an
   empty one" invariant, it just gives a transient window more room to
   resolve on its own before that invariant fires.

## Test pattern for a "torn read" that no longer has a real writer to trigger it

Once the writer is provably atomic, you can't reproduce a torn read with a
REAL concurrent-write test anymore (see
`workspace-registry-concurrent-write.test.ts`'s own CONTROL test comment on
this). To test the READER's retry behavior, mock `node:fs.readFileSync` at
the module level with `vi.mock('node:fs', ...)` (spreading `vi.importActual`
so every other fs call — including the test's own `writeRegistry()` setup —
hits the real filesystem), gated by a `vi.hoisted()` counter so both the mock
factory and the test can see it. Rig it to return a truncated string for a
CONTROLLED number of calls to the registry path, then assert:

* fewer garbage reads than the retry budget → `readRegistry()` still returns
  the real, valid content;
* far more than the retry budget → it still throws
  `WorkspaceRegistryUnreadableError` (proving retries are bounded, not a
  silent-degrade escape hatch).

See `packages/operator-core/lib/workspace-registry-torn-read-retry.test.ts`.
A prior attempt at similar coverage found plain `vi.spyOn` namespace mocking
unreliable under this package's ESM live bindings — `vi.mock` replaces the
module binding itself, which doesn't have that problem, and is the same
pattern already used successfully in
`endpoint-route/__tests__/launch-su.test.ts`.
