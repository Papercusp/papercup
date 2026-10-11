# Parked-agent rubric source replay

This source archive supports WI-6554700010008670 and construction review of acceptance rubric revision 6. It does not establish product acceptance or waive R7 recovery or R14's 24-hour census.

The required historical source commit is `9026e6c25e79b8e9ee44a4dd773fb00d6de7a2ab`. The census/wake detector is `packages/operator-core/lib/agent-tools/coordination/parked-agent-audit.e2e.test.ts`; its exact UTF-8 source has SHA-256 `e50361b3cc3183d0a584bbb78cf6a941d63bb166cb1e72b8e9e690c9aaaba1a9` and 18,175 bytes.

The maintained `lint:as-committed --materialize-only` route prepared the historical archive at `/tmp/pcv/papercusp-lint-as-committed-9026e6c25e-6CpBdj`. `verifyCommittedWorkRoot` verified its commit, source path, and dependency on this document; the source byte hash matches the value above. This document retains the archive for its lifetime.

The current repaired guard archive is `/tmp/pcv/papercusp-lint-as-committed-c9e7527a29-WTTy37`, pinned to `c9e7527a29c77ccb057cd41b62b3277dd070f8eb` and retained by the same verified dependency. Its `packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts` suite passed 88 tests with zero skips; ledger `21131436` records `papercusp-workspace`, harness `papercusp`, and `worktreeDirty:false`. This does not establish shared bg-host containment.

For historical detector paths in posts `1175120` and `1175121`, prepend the historical archive root and read with `capability:read`. The author replayed the complete 18,175-byte census/wake source through five contiguous byte pages to `eof:true`, and separately verified that the same permitted reader opens all 16 unique indexed test paths. The complete census/wake source is 352 lines: start with `{file_path:"/tmp/pcv/papercusp-lint-as-committed-9026e6c25e-6CpBdj/packages/operator-core/lib/agent-tools/coordination/parked-agent-audit.e2e.test.ts",byte_offset:0,byte_limit:4096}` and follow every returned `next_cursor` until `eof:true`. Byte pages are bounded and preserve exact source; do not infer completeness from a truncated line window. For R7's repaired recovery assertions, use the current guard archive instead.

Reviewer capability preflight found `capability:read`, `conversations:get`, `rubrics:get`, `plans:get-spec-evidence`, and `testing:runs` available to the judge role. Historical Git readers were unavailable. Use the permitted file reader on the pinned archive; do not require Git or change reviewer permissions.

The previous grading failures were missing artifact access and then missing Git access. Indexes of path names and hashes do not replace assertion bodies. A replacement card must require only the permitted source reader and the already accessible canonical stores.

Preserved owner source: `thread-post:1175113`. Revision-specific independent critique: `thread-post:1174989`. Compact historical detector index: `thread-post:1175120` and `thread-post:1175121`.
