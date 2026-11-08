---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/fixture-read-bridge-20261107/tsc-attempt2.log"
updated_at: 1794095643172
_body: "content"
---

COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 281371, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: node scripts/lint-tsc.mjs --files=packages/operator-core/lib/external-bench/private-fixture-reads.ts,packages/operator-core/lib/external-bench/private-fixture-reads.test.ts,packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts,packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts,packages/operator-core/lib/capability-envelope/session-confinement.ts,packages/operator-core/lib/capability-envelope/session-confinement-store.ts,packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts,packages/operator-core/lib/external-bench/current-su.ts,packages/operator-core/lib/external-bench/current-su.test.ts,packages/operator-core/lib/external-bench/reproducibility/schema.ts,packages/operator-core/lib/agent-tools/index.ts --all-errors (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
LINT_TSC_RUN_STAMP label=operator-core at=2026-11-07T23:39:21.579Z head=14ee0e3754 scope=files files=11
  checked files : packages/operator-core/lib/external-bench/private-fixture-reads.ts
                 packages/operator-core/lib/external-bench/private-fixture-reads.test.ts
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts
                 packages/operator-core/lib/capability-envelope/session-confinement.ts
                 packages/operator-core/lib/capability-envelope/session-confinement-store.ts
                 packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts
                 packages/operator-core/lib/external-bench/current-su.ts
                 packages/operator-core/lib/external-bench/current-su.test.ts
                 packages/operator-core/lib/external-bench/reproducibility/schema.ts
                 packages/operator-core/lib/agent-tools/index.ts
LINT_TSC_CROSS_LEG checked=4 clean=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts red=- undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=-
gen:declarations: no enrolled modules explicitly selected; no declarations published
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=queued elapsedMs=0 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=refresh elapsedMs=12496 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=compiler-initialize elapsedMs=12535 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=compiler-initialized elapsedMs=12536 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=snapshot-release elapsedMs=12536 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=snapshot-update elapsedMs=12537 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=snapshot-rpc-completed elapsedMs=13509 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=snapshot-updated elapsedMs=13556 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=project-roots-refresh elapsedMs=13556 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=project-roots-refreshed elapsedMs=13641 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=refreshed elapsedMs=13641 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=program-files elapsedMs=13641 resultOrigin=pending
TSC_SERVICE state=queued requestId=70c0a41b-fea3-429d-a97c-291f7c3064f5 serverPhase=scope elapsedMs=13665 resultOrigin=pending
⚠ TSC_SERVICE declined (scope-too-wide: at least 1501 files (limit 1500); a full compile is cheaper) — running the full operator-core compile instead. state=scope-too-wide resultOrigin=full-compile-required
[pc-heavy] slot acquired — starting real work
PC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=21 admittedCgroupMiB=19585 admissionId=pc-heavy-314496-1794094808263624696 retryHandle=psi-recovery:pc-heavy-314496-1794094808263624696 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-314496-1794094808263624696 retryHandle=psi-recovery:pc-heavy-314496-1794094808263624696 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TSC operator-core: 257 type errors across 150 file(s) (baseline total 224) [--files]
❌ 1 file(s) YOU NAMED added type errors above their baseline:
   packages/operator-core/lib/external-bench/current-su.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/external-bench/current-su.test.ts(2442,121): error TS2345: Argument of type '(ledger: "off" | "on" | undefined, planning: "off" | "on", memory: "off" | "on", carry: "off" | "on" | undefined, privateReads: true | undefined) => Promise<void>' is not assignable to parameter of type '(...args: [undefined, "off", "off", undefined] | ["off", "off", "off", "off"] | ["off", "off", "off", "on"] | ["off", "off", "on", "off"] | ["off", "on", "off", "off"] | ["on", "off", "off", "off"] | [...] | [...] | [...]) => Awaitable<...>'.
      packages/operator-core/lib/external-bench/current-su.test.ts(2449,5): error TS18048: 'protocol.sampling' is possibly 'undefined'.
      (this file's baseline is 0 — every error above is new.)
   (also 75 NEW file(s) with errors — see below)
   packages/operator-core/lib/agent-tools/tools/invoke.ts: 0 → 14  (+14)
      packages/operator-core/lib/agent-tools/tools/invoke.ts(320,17): error TS7006: Parameter 'raw' implicitly has an 'any' type.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(377,9): error TS2769: No overload matches this call.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(378,23): error TS2339: Property 'name' does not exist on type 'Request'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(389,52): error TS2339: Property 'build' does not exist on type 'Request'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(390,14): error TS2339: Property 'servingGeneration' does not exist on type 'Request'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(397,37): error TS2339: Property 'servingGeneration' does not exist on type 'Request'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(399,67): error TS2339: Property 'servingGeneration' does not exist on type 'Request'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(403,14): error TS2339: Property 'dispatchTool' does not exist on type 'RouteContext<undefined>'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(412,63): error TS2339: Property 'args' does not exist on type 'Request'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(420,11): error TS2339: Property 'codeMode' does not exist on type 'RouteContext<undefined>'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(423,53): error TS2339: Property 'progress' does not exist on type 'RouteContext<undefined>'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(425,40): error TS2339: Property 'progress' does not exist on type 'RouteContext<undefined>'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(435,26): error TS2339: Property 'dispatchTool' does not exist on type 'RouteContext<undefined>'.
      packages/operator-core/lib/agent-tools/tools/invoke.ts(449,9): error TS2339: Property 'metadata' does not exist on type 'RouteContext<undefined>'.
   packages/operator-core/lib/agent-tools/capability/bash_output.ts: 0 → 10  (+10)
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1358,95): error TS2339: Property 'taskId' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1382,32): error TS2339: Property 'taskId' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1383,32): error TS2339: Property 'bashJobId' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1384,32): error TS2339: Property 'scopeUnit' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1386,32): error TS2339: Property 'invocationId' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1387,32): error TS2339: Property 'nonce' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1400,65): error TS2339: Property 'scopeUnit' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1401,36): error TS2339: Property 'invocationId' does not exist on type '{ status: RecoveredJobStatus; exitCode: number | null; }'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1401,74): error TS2339: Property 'logPath' does not exist on type 'StrandedJobLogInspection'.
      packages/operator-core/lib/agent-tools/capability/bash_output.ts(1494,92): error TS2339: Property 'logPath' does not exist on type 'StrandedJobLogInspection'.
   packages/operator-core/lib/agent-tools/git_sync/run.ts: 0 → 7  (+7)
      packages/operator-core/lib/agent-tools/git_sync/run.ts(448,23): error TS2339: Property 'localCommitSha' does not exist on type 'GitSyncFireOutcome'.
      packages/operator-core/lib/agent-tools/git_sync/run.ts(449,31): error TS2339: Property 'localCommitShas' does not exist on type 'GitSyncFireOutcome'.
      packages/operator-core/lib/agent-tools/git_sync/run.ts(450,17): error TS2339: Property 'localCommitShas' does not exist on type 'GitSyncFireOutcome'.
      packages/operator-core/lib/agent-tools/git_sync/run.ts(450,39): error TS7006: Parameter 'sha' implicitly has an 'any' type.
      packages/operator-core/lib/agent-tools/git_sync/run.ts(452,23): error TS2339: Property 'committedCount' does not exist on type 'GitSyncFireOutcome'.
      packages/operator-core/lib/agent-tools/git_sync/run.ts(452,83): error TS2339: Property 'committedCount' does not exist on type 'GitSyncFireOutcome'.
      packages/operator-core/lib/agent-tools/git_sync/run.ts(453,19): error TS2339: Property 'committedCount' does not exist on type 'GitSyncFireOutcome'.
   packages/operator-core/lib/cupboard/installed-tool-funding.test.ts: 0 → 7  (+7)
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(111,65): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 5 more ...; createIdentityHost: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(123,64): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 6 more ...; remoteSeller: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(143,55): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 6 more ...; readWorkItem: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(164,86): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 6 more ...; readWorkItem: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(172,79): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 5 more ...; createIdentityHost: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(181,64): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 5 more ...; createIdentityHost: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
      packages/operator-core/lib/cupboard/installed-tool-funding.test.ts(188,102): error TS2345: Argument of type '{ workspaceId: () => string; nowMs: () => number; sql: () => Promise<Sql<{}>>; readKey: Mock<(key: string) => Promise<string | undefined>>; readFunding: Mock<() => Promise<Map<string, { skuRef: string; ... 4 more ...; pricingCheckedAtMs: null; }>>>; ... 5 more ...; createIdentityHost: Mock<...>; }' is not assignable to parameter of type 'Omit<Deps, "createHost"> & { readApplied?: ((ownerId: string, workspaceId: string, observeTiming?: IdentityRuleReadTimingObserver | undefined) => Promise<...>) | undefined; resolveLayers?: ((worn: Pick<...>, deps?: { ...; }) => Promise<...>) | undefined; createIdentityHost?: ((deps: FundedIdentityTurnHostDeps) => Fu...'.
   packages/operator-core/lib/__tests__/fs-mutex.test.ts: 0 → 6  (+6)
      packages/operator-core/lib/__tests__/fs-mutex.test.ts(1392,22): error TS18048: 'held' is possibly 'undefined'.
      packages/operator-core/lib/__tests__/fs-mutex.test.ts(1397,22): error TS18048: 'held' is possibly 'undefined'.
      packages/operator-core/lib/__tests__/fs-mutex.test.ts(1401,22): error TS18048: 'held' is possibly 'undefined'.
      packages/operator-core/lib/__tests__/fs-mutex.test.ts(1488,42): error TS2353: Object literal may only specify known properties, and 'intent' does not exist in type '{ mode?: "read" | "reader" | undefined; lockRootDir?: string | undefined; timeoutMs?: number | undefined; staleMs?: number | undefined; retryMs?: number | undefined; onWaiting?: ((info: { ...; }) => void) | undefined; waitingNoticeIntervalMs?: number | undefined; onAcquired?: ((info: { ...; }) => void) | undefined; ...'.
      packages/operator-core/lib/__tests__/fs-mutex.test.ts(1506,42): error TS2353: Object literal may only specify known properties, and 'intent' does not exist in type '{ mode?: "read" | "reader" | undefined; lockRootDir?: string | undefined; timeoutMs?: number | undefined; staleMs?: number | undefined; retryMs?: number | undefined; onWaiting?: ((info: { ...; }) => void) | undefined; waitingNoticeIntervalMs?: number | undefined; onAcquired?: ((info: { ...; }) => void) | undefined; ...'.
      packages/operator-core/lib/__tests__/fs-mutex.test.ts(1688,9): error TS2559: Type '{ readdir: (path: string, options?: unknown) => Promise<string[]>; }' has no properties in common with type 'FsMutexIo'.
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts: 0 → 5  (+5)
      packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts(35,38): error TS2339: Property 'loadedFunctionSha256' does not exist on type '{ executorLaunched: boolean; }'.
      packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts(36,38): error TS2339: Property 'loadedFunctionSha256' does not exist on type '{ executorLaunched: boolean; }'.
      packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts(36,95): error TS2339: Property 'loadedFunctionSha256' does not exist on type '{ executorLaunched: boolean; }'.
      packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts(58,33): error TS2339: Property 'name' does not exist on type '{ executorLaunched: boolean; }'.
      packages/operator-core/lib/coverage-census/providers/dbos-workflows.test.ts(59,55): error TS2339: Property 'name' does not exist on type '{ executorLaunched: boolean; }'.
   packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts: 0 → 4  (+4)
      packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts(275,7): error TS2739: Type '{ isSuperuser: true; uiClientId: string; workspaceId: string; }' is missing the following properties from type 'UnifiedToolContext': log, signal, progress, emit
      packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts(278,19): error TS2339: Property 'data' does not exist on type 'ToolResponse<unknown> | ToolResult'.
      packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts(289,19): error TS2339: Property 'data' does not exist on type 'ToolResponse<unknown> | ToolResult'.
      packages/operator-core/lib/agent-tools/scheduler/set_claim_spec.test.ts(290,19): error TS2339: Property 'data' does not exist on type 'ToolResponse<unknown> | ToolResult'.
   packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts: 0 → 4  (+4)
      packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts(52,42): error TS2554: Expected 3 arguments, but got 2.
      packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts(53,27): error TS2345: Argument of type 'string | Promise<string | null | undefined> | null' is not assignable to parameter of type 'string | null'.
      packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts(114,44): error TS2554: Expected 3 arguments, but got 2.
      packages/operator-core/lib/carry-respawn-mechanical-checkpoint.test.ts(115,29): error TS2345: Argument of type 'string | Promise<string | null | undefined> | null' is not assignable to parameter of type 'string | null'.
   packages/operator-core/lib/service-memory-attribution.integration.test.ts: 0 → 4  (+4)
      packages/operator-core/lib/service-memory-attribution.integration.test.ts(1836,55): error TS2339: Property 'path' does not exist on type '{ path: string; bytes: number; sha256: string; state: string; tail: string; expectedPath?: undefined; } | { state: string; expectedPath: string; }'.
      packages/operator-core/lib/service-memory-attribution.integration.test.ts(1837,28): error TS2339: Property 'sha256' does not exist on type '{ path: string; bytes: number; sha256: string; state: string; tail: string; expectedPath?: undefined; } | { state: string; expectedPath: string; }'.
      packages/operator-core/lib/service-memory-attribution.integration.test.ts(1838,28): error TS2339: Property 'bytes' does not exist on type '{ path: string; bytes: number; sha256: string; state: string; tail: string; expectedPath?: undefined; } | { state: string; expectedPath: string; }'.
      packages/operator-core/lib/service-memory-attribution.integration.test.ts(2974,17): error TS2304: Cannot find name 'directory'.
   packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts: 0 → 3  (+3)
      packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts(121,21): error TS2739: Type '{}' is missing the following properties from type '{ file_path: string; old_string: string; new_string: string; replace_all?: boolean | undefined; }': file_path, old_string, new_string
      packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts(127,21): error TS2739: Type '{}' is missing the following properties from type '{ file_path: string; old_string: string; new_string: string; replace_all?: boolean | undefined; }': file_path, old_string, new_string
      packages/operator-core/lib/agent-tools/abort-completion-coverage.test.ts(131,21): error TS2739: Type '{}' is missing the following properties from type '{ file_path: string; old_string: string; new_string: string; replace_all?: boolean | undefined; }': file_path, old_string, new_string
   packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts: 0 → 3  (+3)
      packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts(138,14): error TS2554: Expected 3 arguments, but got 2.
      packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts(4035,65): error TS2353: Object literal may only specify known properties, and 'origin' does not exist in type '{ claim: string; recheck?: string | undefined; }'.
      packages/operator-core/lib/agent-tools/loop/checkpoint.test.ts(4270,98): error TS2353: Object literal may only specify known properties, and 'origin' does not exist in type '{ id?: string | undefined; claim: string; recheck?: string | undefined; }'.
   packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts: 0 → 3  (+3)
      packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts(637,14): error TS2352: Conversion of type 'Record<string, unknown>' to type 'PlanSpecQualityGateVerdict' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
      packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts(717,12): error TS2571: Object is of type 'unknown'.
      packages/operator-core/lib/agent-tools/plans/__tests__/start-guard.test.ts(1059,12): error TS2571: Object is of type 'unknown'.
   packages/operator-core/lib/agent-tools/work_items/create.test.ts: 0 → 3  (+3)
      packages/operator-core/lib/agent-tools/work_items/create.test.ts(625,32): error TS2740: Type '{ all: FilterNode[]; }' is missing the following properties from type 'ClaimSpecSubject': id, title, summary, kind, and 15 more.
      packages/operator-core/lib/agent-tools/work_items/create.test.ts(630,37): error TS2740: Type '{ all: FilterNode[]; }' is missing the following properties from type 'ClaimSpecSubject': id, title, summary, kind, and 15 more.
      packages/operator-core/lib/agent-tools/work_items/create.test.ts(633,51): error TS2740: Type '{ all: FilterNode[]; }' is missing the following properties from type 'ClaimSpecSubject': id, title, summary, kind, and 15 more.
   packages/operator-core/lib/degradation/rail-migration-cases.ts: 0 → 3  (+3)
      packages/operator-core/lib/degradation/rail-migration-cases.ts(4392,32): error TS2345: Argument of type '(_model: string, _dtype: string, device: RerankDevice) => Promise<{ tokenizer: () => {}; model: () => Promise<{ logits: { dims: number[]; data: number[]; }; }>; }>' is not assignable to parameter of type '(model: string, dtype: string, device: RerankDevice) => Promise<LoadedModel>'.
      packages/operator-core/lib/degradation/rail-migration-cases.ts(4396,32): error TS2345: Argument of type '() => Promise<{ tokenizer: () => {}; model: () => Promise<{ logits: { dims: number[]; data: number[]; }; }>; }>' is not assignable to parameter of type '(model: string, dtype: string, device: RerankDevice) => Promise<LoadedModel>'.
      packages/operator-core/lib/degradation/rail-migration-cases.ts(4435,32): error TS2345: Argument of type '() => Promise<{ tokenizer: () => {}; model: () => Promise<{ logits: { dims: number[]; data: number[]; }; }>; }>' is not assignable to parameter of type '(model: string, dtype: string, device: RerankDevice) => Promise<LoadedModel>'.
   packages/operator-core/lib/license-gate.test.ts: 0 → 3  (+3)
      packages/operator-core/lib/license-gate.test.ts(517,73): error TS2322: Type '{ name: string; kind: string; license: string; verdict: string; hits: number; obligations: string | null; } | undefined' is not assignable to type '{ name: string; license?: string | undefined; allow?: boolean | undefined; obligations?: string | undefined; }'.
      packages/operator-core/lib/license-gate.test.ts(556,73): error TS2322: Type '{ name: string; kind: string; license: string; verdict: string; hits: number; obligations: string | null; } | undefined' is not assignable to type '{ name: string; license?: string | undefined; allow?: boolean | undefined; obligations?: string | undefined; }'.
      packages/operator-core/lib/license-gate.test.ts(556,78): error TS2322: Type '{ name: string; kind: string; license: string; verdict: string; hits: number; obligations: string | null; } | undefined' is not assignable to type '{ name: string; license?: string | undefined; allow?: boolean | undefined; obligations?: string | undefined; }'.
   packages/operator-core/lib/scratch-gc.test.ts: 0 → 3  (+3)
      packages/operator-core/lib/scratch-gc.test.ts(988,41): error TS2739: Type '{ XDG_RUNTIME_DIR: string; }' is missing the following properties from type 'Pick<ProcessEnv, "PAPERCUSP_FS_MUTEX_LOCK_DIR" | "PAPERCUSP_SCRATCH_ROOT" | "XDG_RUNTIME_DIR">': PAPERCUSP_FS_MUTEX_LOCK_DIR, PAPERCUSP_SCRATCH_ROOT
      packages/operator-core/lib/scratch-gc.test.ts(990,41): error TS2741: Property 'PAPERCUSP_FS_MUTEX_LOCK_DIR' is missing in type '{ XDG_RUNTIME_DIR: string; PAPERCUSP_SCRATCH_ROOT: string; }' but required in type 'Pick<ProcessEnv, "PAPERCUSP_FS_MUTEX_LOCK_DIR" | "PAPERCUSP_SCRATCH_ROOT" | "XDG_RUNTIME_DIR">'.
      packages/operator-core/lib/scratch-gc.test.ts(994,41): error TS2741: Property 'PAPERCUSP_SCRATCH_ROOT' is missing in type '{ XDG_RUNTIME_DIR: string; PAPERCUSP_FS_MUTEX_LOCK_DIR: string; }' but required in type 'Pick<ProcessEnv, "PAPERCUSP_FS_MUTEX_LOCK_DIR" | "PAPERCUSP_SCRATCH_ROOT" | "XDG_RUNTIME_DIR">'.
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.integration.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/agent-tools/rubrics/amend-receipts.integration.test.ts(428,94): error TS2739: Type '{}' is missing the following properties from type 'UnifiedToolContext': log, signal, progress, emit
      packages/operator-core/lib/agent-tools/rubrics/amend-receipts.integration.test.ts(439,96): error TS2739: Type '{}' is missing the following properties from type 'UnifiedToolContext': log, signal, progress, emit
   packages/operator-core/lib/agent-tools/rubrics/amend-status.ts: 0 → 2  (+2)
      packages/operator-core/lib/agent-tools/rubrics/amend-status.ts(56,18): error TS18048: 'review' is possibly 'undefined'.
      packages/operator-core/lib/agent-tools/rubrics/amend-status.ts(56,81): error TS18048: 'review' is possibly 'undefined'.
   packages/operator-core/lib/agent-tools/work_items/get-shape.ts: 0 → 2  (+2)
      packages/operator-core/lib/agent-tools/work_items/get-shape.ts(1863,27): error TS2339: Property 'workItem' does not exist on type '{}'.
      packages/operator-core/lib/agent-tools/work_items/get-shape.ts(1864,24): error TS2339: Property '_stub' does not exist on type '{}'.
   packages/operator-core/lib/blind-review-source-image.ts: 0 → 2  (+2)
      packages/operator-core/lib/blind-review-source-image.ts(76,24): error TS2345: Argument of type 'Readonly<VerifierSourceFile> | { kind: string; executable: boolean; sha256: string; path: string; }' is not assignable to parameter of type 'VerifierSourceFile'.
      packages/operator-core/lib/blind-review-source-image.ts(85,3): error TS2322: Type '(Readonly<VerifierSourceFile> | { kind: string; executable: boolean; sha256: string; path: string; })[]' is not assignable to type 'VerifierSourceFile[]'.
   packages/operator-core/lib/capability-envelope/identity-tool-surface.ts: 0 → 2  (+2)
      packages/operator-core/lib/capability-envelope/identity-tool-surface.ts(162,27): error TS2345: Argument of type 'KernelEnforcementResult | { kind: "error"; }' is not assignable to parameter of type 'KernelEnforcementResult'.
      packages/operator-core/lib/capability-envelope/identity-tool-surface.ts(163,17): error TS2339: Property 'decision' does not exist on type 'KernelEnforcementResult | { kind: "error"; }'.
   packages/operator-core/lib/carry-brief.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/carry-brief.test.ts(610,19): error TS2339: Property 'id' does not exist on type 'HydratableRef'.
      packages/operator-core/lib/carry-brief.test.ts(2461,54): error TS2353: Object literal may only specify known properties, and 'status' does not exist in type '{ issue_id: string; title: string | null; body: string | null; scope: string; taken_by?: string | null | undefined; workspace_id?: string | null | undefined; last_progress_at?: string | number | Date | null | undefined; }'.
   packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts(136,19): error TS2345: Argument of type '{ otel: { callId: string; traceId: string; spanId: string; traceFlags: number; boundaryObservations: ExecutionBoundaryReceipt[]; }; }' is not assignable to parameter of type 'JSONValue'.
      packages/operator-core/lib/code-intelligence/engineering-evidence-reference.integration.test.ts(139,35): error TS2345: Argument of type '{ schemaVersion: number; root: string; filePath: string; runGroupId: null; workspaceId: string; harnessSlug: string; testNamePattern: null; mutationPhase: null; commitSha: string | null; worktreeDirty: boolean; collectionFailed: boolean; passed: number; failed: number; skipped: number; boundaryObservations: { ...; }...' is not assignable to parameter of type 'JSONValue'.
   packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts(39,14): error TS2339: Property 'VITEST_WORKER_ID' does not exist on type '{ HARNESS_DATABASE_URL: string; HARNESS_ADMIN_DATABASE_URL: string; PAPERCUSP_PGBOUNCER: string; PAPERCUSP_WORKSPACE_ID: string; }'.
      packages/operator-core/lib/dbos/managed-tick-alarm.integration.test.ts(40,14): error TS2339: Property 'VITEST_POOL_ID' does not exist on type '{ HARNESS_DATABASE_URL: string; HARNESS_ADMIN_DATABASE_URL: string; PAPERCUSP_PGBOUNCER: string; PAPERCUSP_WORKSPACE_ID: string; }'.
   packages/operator-core/lib/gate-candidate-failures.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/gate-candidate-failures.test.ts(1055,7): error TS2353: Object literal may only specify known properties, and 'candidateSha' does not exist in type '{ queueLegs?: readonly FrozenRepairLegState[] | undefined; repairTickLegs?: { head: string; atMs: number; ok: boolean; failingSignatures: string[]; legs: ({ id: string; status: "fail"; durationMs: number; } | { ...; })[]; } | null | undefined; }'.
      packages/operator-core/lib/gate-candidate-failures.test.ts(1088,7): error TS2353: Object literal may only specify known properties, and 'candidateSha' does not exist in type '{ queueLegs?: readonly FrozenRepairLegState[] | undefined; repairTickLegs?: { head: string; atMs: number; ok: boolean; failingSignatures: string[]; legs: ({ id: string; status: "fail"; durationMs: number; } | { ...; })[]; } | null | undefined; }'.
   packages/operator-core/lib/grading-integrity.integration.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/grading-integrity.integration.test.ts(394,7): error TS2322: Type 'Promise<Map<string | null | undefined, string | null | undefined>>' is not assignable to type 'Promise<Map<string, string>>'.
      packages/operator-core/lib/grading-integrity.integration.test.ts(407,12): error TS2532: Object is possibly 'undefined'.
   packages/operator-core/lib/harness/improvements/observation-types.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/harness/improvements/observation-types.test.ts(555,22): error TS2339: Property 'current' does not exist on type 'ScorecardRerunRecipe'.
      packages/operator-core/lib/harness/improvements/observation-types.test.ts(559,80): error TS2339: Property 'current' does not exist on type '{ harness: string; slug: string; classRef: string; expectedSpecSetHash: string; specSetHashVersion: number; evaluatorBuild: { sha: string | null; version: string; }; replaySnapshot: { planContentHash: string; clausesAsOf: string; }; } | { ...; }'.
   packages/operator-core/lib/memory/context-injection-reliability.integration.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/memory/context-injection-reliability.integration.test.ts(266,55): error TS2353: Object literal may only specify known properties, and 'hiveSlugs' does not exist in type 'MemoryInjectionInput'.
      packages/operator-core/lib/memory/context-injection-reliability.integration.test.ts(401,56): error TS2353: Object literal may only specify known properties, and 'hiveSlugs' does not exist in type 'MemoryInjectionInput'.
   packages/operator-core/lib/result-door.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/result-door.test.ts(4046,22): error TS2352: Conversion of type '{ text?: string | undefined; review?: unknown; summaryNotice?: Record<string, unknown> | undefined; _projection: { cursor: Record<string, unknown>; next: string; kind: string; truncated: boolean; }; }' to type '{ _partial: boolean; _projection: { cursor: { bodyComplete?: boolean | undefined; }; }; runs: { filePath?: string | undefined; framework?: string | undefined; }[]; }' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
      packages/operator-core/lib/result-door.test.ts(4680,22): error TS2339: Property '_meta' does not exist on type '{ content: { type: "text"; text: string; }[]; }'.
   packages/operator-core/lib/turn-end-tracking-io.test.ts: 0 → 2  (+2)
      packages/operator-core/lib/turn-end-tracking-io.test.ts(238,7): error TS2322: Type 'string | Promise<string | null | undefined> | null' is not assignable to type 'string | null'.
      packages/operator-core/lib/turn-end-tracking-io.test.ts(238,43): error TS2554: Expected 3 arguments, but got 2.
   packages/operator-core/test/omp-managed-native-lifecycle.ts: 0 → 2  (+2)
      packages/operator-core/test/omp-managed-native-lifecycle.ts(58,9): error TS7034: Variable 'observations' implicitly has type 'any[]' in some locations where its type cannot be determined.
      packages/operator-core/test/omp-managed-native-lifecycle.ts(166,12): error TS7005: Variable 'observations' implicitly has an 'any[]' type.
   packages/operator-core/test/private-http-workspace-preflight.ts: 0 → 2  (+2)
      packages/operator-core/test/private-http-workspace-preflight.ts(1489,37): error TS2550: Property 'findLastIndex' does not exist on type '{ at: number; pid: number; step: string; event: string; status?: number | undefined; }[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
      packages/operator-core/test/private-http-workspace-preflight.ts(1489,51): error TS7006: Parameter 'open' implicitly has an 'any' type.
   packages/operator-core/lib/__tests__/test-file-router.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/__tests__/test-file-router.test.ts(4719,15): error TS7006: Parameter 'line' implicitly has an 'any' type.
   packages/operator-core/lib/acceptance-bar-contract-snapshot.ts: 0 → 1  (+1)
      packages/operator-core/lib/acceptance-bar-contract-snapshot.ts(2277,3): error TS2322: Type '{ key: string; intent: RequirementIntent | undefined; model: string; bar: string; barKey: string; driftMarkers: string; requiredScope: string[]; evidencePlane: "deployed" | "live" | "tree" | undefined; ... 7 more ...; coversBarKeys: string[]; }' is not assignable to type 'AcceptanceBarHashInput & Record<"bar" | "barKey" | "check" | "coversBarKeys" | "driftMarkers" | "evidencePlane" | "evidenceRuntime" | "intent" | "key" | ... 7 more ... | "role", unknown>'.
   packages/operator-core/lib/agent-plane-measurement-sweep.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-plane-measurement-sweep.test.ts(16,9): error TS2739: Type '{ callsExamined: number; stampedCalls: number; goalStampedCalls: number; stampFillRate: number; intentBuckets: number; comparableBuckets: number; failuresSeen: number; thrashRuns: number; convergedRuns: number; unsettledRuns: number; stampedLegRan: false; ... 5 more ...; launchFailuresReconciled: number; }' is missing the following properties from type 'DivergenceCoverage': transientFailuresExcluded, rateLimitFailuresExcluded
   packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/coordination/tools/conversations-answer.test.ts(54,7): error TS2739: Type '{ id: number; }' is missing the following properties from type 'ThreadPostRow': thread_id, author_id, body, created_ts
   packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/coordination/tools/dispatch.test.ts(98,36): error TS2322: Type 'null' is not assignable to type 'string'.
   packages/operator-core/lib/agent-tools/dev/restart.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/dev/restart.ts(3047,7): error TS2345: Argument of type '(installReadLeaseHeld?: boolean, lockedBootIntegrity?: RestartPreflightResult | undefined) => Promise<{ content: { type: "text"; text: string; }[]; isError?: true | undefined; }>' is not assignable to parameter of type '(fence: FenceToken) => Promise<{ content: { type: "text"; text: string; }[]; isError?: true | undefined; }>'.
   packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts(534,22): error TS2345: Argument of type 'Map<any, any>' is not assignable to parameter of type 'Map<string, never>'.
   packages/operator-core/lib/agent-tools/plans/__tests__/attention-parallel.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/plans/__tests__/attention-parallel.test.ts(206,51): error TS2345: Argument of type '(plans: readonly ({ parsed: ParsedPlan; row?: { planSlug: string; } | undefined; } | { slug: string; isLegacy: boolean; items: PlanItem[]; })[], harnessSlug: string | null) => AttentionItem[]' is not assignable to parameter of type '() => unknown[]'.
   packages/operator-core/lib/agent-tools/plans/__tests__/new-surface.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/plans/__tests__/new-surface.integration.test.ts(240,32): error TS2741: Property 'sourceRefs' is missing in type '{ anchors: never[]; manualEntry: true; }' but required in type 'AnchorSuggestions'.
   packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/plans/certify-spec-clauses.ts(126,12): error TS2339: Property 'auditTarget' does not exist on type 'ScorecardRow'.
   packages/operator-core/lib/agent-tools/plans/coordination-metadata-preflight.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/plans/coordination-metadata-preflight.integration.test.ts(137,59): error TS2741: Property 'detail' is missing in type '{ harness: string; slug: string; }' but required in type '{ harness?: string | undefined; slug: string; detail: "full" | "summary"; evaluatorBuild?: { sha: string | null; version: string; } | undefined; specSetHashVersion?: number | undefined; expectedSpecSetHash?: string | undefined; classRef?: "plan-class-bugfix" | ... 4 more ... | undefined; replaySnapshot?: { ...; } | ...'.
   packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/plans/legacy-item-index-compatibility.integration.test.ts(112,25): error TS2740: Type 'TransactionSql<{}>' is missing the following properties from type 'Sql<{}>': CLOSE, END, PostgresError, options, and 7 more.
   packages/operator-core/lib/agent-tools/plans/pg-tool-fixture.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/plans/pg-tool-fixture.integration.test.ts(81,7): error TS2322: Type 'RowList<readonly (object | undefined)[]>' is not assignable to type 'unknown[]'.
   packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/recipes/git-sync-liveness-recipe.test.ts(117,12): error TS18046: 'result.result' is of type 'unknown'.
   packages/operator-core/lib/agent-tools/release/trace.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/release/trace.ts(215,22): error TS18048: 'subjectStamp.harnessMismatch' is possibly 'undefined'.
   packages/operator-core/lib/agent-tools/rubrics/amend-receipts.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/rubrics/amend-receipts.ts(363,33): error TS2345: Argument of type 'PreviewedReviewReclaim | null | undefined' is not assignable to parameter of type 'PreviewedReviewReclaim | undefined'.
   packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/scheduler/get_claim_spec.ts(193,57): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
   packages/operator-core/lib/agent-tools/testing/runs.ts: 0 → 1  (+1)
      packages/operator-core/lib/agent-tools/testing/runs.ts(1056,37): error TS2345: Argument of type 'TestRunExecutionDetails | null' is not assignable to parameter of type 'TestRunExecutionDetails | undefined'.
   packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts(489,7): error TS2345: Argument of type 'DurableParkReleaseContract' is not assignable to parameter of type '{ condition: string; owner: string; trigger: string; reachability: "blocked" | "reachable" | "satisfied" | "unreachable"; evidence: string; }'.
   packages/operator-core/lib/cell-read-coalesce.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/cell-read-coalesce.test.ts(79,10): error TS2352: Conversion of type '{ principal: { slug: string; workspaceId: string; capabilities: Set<string>; }; signal: AbortSignal; }' to type 'UnifiedToolContext' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
   packages/operator-core/lib/change-kind-refactor-facts.ts: 0 → 1  (+1)
      packages/operator-core/lib/change-kind-refactor-facts.ts(167,15): error TS2339: Property 'parseDiagnostics' does not exist on type 'SourceFile'.
   packages/operator-core/lib/coverage-census/providers/dbos-workflows.ts: 0 → 1  (+1)
      packages/operator-core/lib/coverage-census/providers/dbos-workflows.ts(42,24): error TS2339: Property 'loadedFunctionSha256' does not exist on type '{ executorLaunched: boolean; }'.
   packages/operator-core/lib/dbos/routines-workflow.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/dbos/routines-workflow.test.ts(879,45): error TS2345: Argument of type 'Mock<() => Promise<undefined>>' is not assignable to parameter of type '(..._args: unknown[]) => Promise<{ workflowID: string; }>'.
   packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/endpoint-route/routes/hosted-lead-binding.test.ts(78,22): error TS2339: Property 'mockRejectedValueOnce' does not exist on type '(input: { graphWorkspaceId: string; personRef: string; environment: "development" | "production" | "staging"; }, token: unknown, principal: HostedPrincipal) => Promise<HostedLeadBindingReceipt | null>'.
   packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/endpoint-route/routes/transport/__tests__/mcp-result-replay.integration.test.ts(148,31): error TS2322: Type '{ content: { type: string; text: string; }[]; }' is not assignable to type 'StoredMcpResult'.
   packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts: 0 → 1  (+1)
      packages/operator-core/lib/endpoint-route/routes/transport/_mcp-result-replay.ts(283,5): error TS2322: Type 'unknown[] | { [x: number]: { result: unknown; is_error: boolean; tool_name: string; }; length: number; toString: () => string; toLocaleString: { (): string; (locales: string | string[], options?: (NumberFormatOptions & DateTimeFormatOptions) | undefined): string; }; ... 36 more ...; columns: ColumnList<...>; }' is not assignable to type '{ result: unknown; is_error: boolean; tool_name: string; }[]'.
   packages/operator-core/lib/event-loop-lag-monitor.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/event-loop-lag-monitor.test.ts(1137,80): error TS2345: Argument of type 'object | undefined' is not assignable to parameter of type 'PromiseLike<{ profile?: unknown; }> | { profile?: unknown; }'.
   packages/operator-core/lib/harness/improvements/agent-review.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/harness/improvements/agent-review.test.ts(2318,7): error TS2698: Spread types may only be created from object types.
   packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts: 0 → 1  (+1)
      packages/operator-core/lib/harness/routines/task-reconcile-consult.fixture.ts(28,14): error TS2352: Conversion of type '{ workspaceId: string; class: "agent-session"; detail: { consultAnswer: { conversationId: string; answeringOwnerId: string; sourceOwnerId: string; operation: string; }; }; }' to type 'TaskRow' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
   packages/operator-core/lib/harness/routines/task-reconcile-consult.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/harness/routines/task-reconcile-consult.integration.test.ts(23,14): error TS2352: Conversion of type '{ workspaceId: string; class: "agent-session"; detail: { consultAnswer: { conversationId: string; answeringOwnerId: string; sourceOwnerId: string; operation: string; }; }; }' to type 'TaskRow' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
   packages/operator-core/lib/inference-gateway/codex-oauth-kernel-adapter.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/inference-gateway/codex-oauth-kernel-adapter.test.ts(930,17): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
   packages/operator-core/lib/memory/corpus-recall-io.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/memory/corpus-recall-io.test.ts(475,9): error TS2532: Object is possibly 'undefined'.
   packages/operator-core/lib/schedule-inventory.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/schedule-inventory.test.ts(277,12): error TS2322: Type '() => Promise<{ name: string; purpose: string; trigger: string; scope: { kind: 'device' | 'workspace' | 'unknown'; id: string | null; }; dependencies: string[] | null; desired: StartupActivityPolicy; ... 7 more ...; entrypointIds: string[]; }[]>' is not assignable to type '() => Promise<StartupActivityFeature[]>'.
   packages/operator-core/lib/scheduler/issue-claim-update-profile.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/scheduler/issue-claim-update-profile.integration.test.ts(138,11): error TS2322: Type '{ all: ({ not?: undefined; all: { any: { all: ({ not?: undefined; op: string; field: string; value: string[]; } | { value?: undefined; field?: undefined; op?: undefined; not: { any: { op: string; field: "plan" | "summary" | "title"; value: string; }[]; }; })[]; }[]; }[]; } | { ...; } | { ...; } | { ...; })[]; }' is not assignable to type 'FilterNode | undefined'.
   packages/operator-core/lib/scratch-gc.ts: 0 → 1  (+1)
      packages/operator-core/lib/scratch-gc.ts(169,3): error TS2322: Type 'ProcessEnv' is not assignable to type 'Pick<ProcessEnv, "PAPERCUSP_FS_MUTEX_LOCK_DIR" | "PAPERCUSP_SCRATCH_ROOT" | "XDG_RUNTIME_DIR">'.
   packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/system-health/desktop-perf-cohort.integration.test.ts(33,10): error TS2352: Conversion of type 'Row & Iterable<Row>' to type '{ budget_pct: number | null; attempt_n: number; distinct_run_n: number; }' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
   packages/operator-core/lib/test-run-receipt-reconciliation.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/test-run-receipt-reconciliation.test.ts(6,45): error TS7016: Could not find a declaration file for module '../../../scripts/test-files.mjs'. '/home/marsh-office/papercupai-workspace/papercusp/scripts/test-files.mjs' implicitly has an 'any' type.
   packages/operator-core/lib/testing-run-store.ts: 0 → 1  (+1)
      packages/operator-core/lib/testing-run-store.ts(828,10): error TS18047: 'requestedFiles' is possibly 'null'.
   packages/operator-core/lib/text-artifacts.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/text-artifacts.integration.test.ts(313,7): error TS2741: Property 'maxInputBytes' is missing in type '{ paths: string[]; maxBytes: number; maxFiles: number; bytesRead: number; filesRead: number; populationComplete: false; }' but required in type '{ paths: string[] | null; maxBytes: number | null; maxFiles: number | null; maxInputBytes: number; bytesRead: number; filesRead: number; populationComplete: boolean; }'.
   packages/operator-core/lib/wait-ref-admission.ts: 0 → 1  (+1)
      packages/operator-core/lib/wait-ref-admission.ts(58,7): error TS2741: Property '"expected-condition-unproven"' is missing in type '{ uncatalogued: string; broad: string; 'change-notification': string; }' but required in type 'Record<UncertifiedConditionReason, string>'.
   packages/operator-core/lib/work-admission/lifecycle.integration.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/work-admission/lifecycle.integration.test.ts(444,75): error TS2345: Argument of type 'Record<string, unknown>' is not assignable to parameter of type 'JSONValue'.
   packages/operator-core/lib/work-item-admission-review.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/work-item-admission-review.test.ts(364,28): error TS2339: Property 'reviewedItemId' does not exist on type 'PromoterRunResult'.
   packages/operator-core/lib/work-items-admission-promoter.test.ts: 0 → 1  (+1)
      packages/operator-core/lib/work-items-admission-promoter.test.ts(835,37): error TS2345: Argument of type '{ id: string; workspaceId: string; harnessSlug: string; title: string; summary: string; state: string; kind: string; admission: string | null; admittedAt: string | null; admittedBy: string | null; ... 19 more ...; ownNode: boolean; }' is not assignable to parameter of type 'AdmissionMergeSnapshot'.
LINT_TSC_RESULT label=operator-core scope=files exit=1 status=regressed at=2026-11-07T23:39:21.579Z head=14ee0e3754

