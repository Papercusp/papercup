---
rel_path: "portability/census/v41-proof/03-source.json.part-000"
updated_at: 1794241878699
_body: "content"
---

{
  "root": "/home/marsh-office/papercupai-workspace/papercusp",
  "worktree": {
    "commit": "3c12ce8e910c88f8d1b195c396d80137995e25c9",
    "porcelain": "M apps/operator/bin/hono-host.ts\n M apps/operator/bin/llm-test.ts\n M apps/operator/bin/release/dependency-generation.sh\n M apps/operator/lib/no-hand-rolled-cli-entry-guard.test.ts\n M apps/operator/scripts/__tests__/kopia-healthcheck-source-age.test.ts\n M apps/operator/scripts/hooks/inject/__tests__/delivery-ledger.test.ts\n M apps/operator/scripts/hooks/inject/__tests__/dispatcher.test.ts\n M apps/operator/scripts/hooks/inject/__tests__/hook-outcome.test.ts\n M apps/operator/scripts/hooks/inject/core.d.mts\n M apps/operator/scripts/hooks/inject/core.mjs\n M apps/operator/scripts/hooks/inject/delivery-ledger.d.mts\n M apps/operator/scripts/hooks/inject/delivery-ledger.mjs\n M apps/operator/scripts/hooks/omp/__tests__/coord-hook.test.ts\n M apps/operator/scripts/hooks/omp/__tests__/inject-hook.test.ts\n M apps/operator/scripts/hooks/omp/coord-hook.ts\n M apps/operator/scripts/psu-launcher-import-safety.test.ts\n M apps/operator/scripts/psu-launcher.d.mts\n M apps/operator/scripts/ptool.d.mts\n M apps/operator/scripts/systemd/kopia-healthcheck.sh\n M apps/slack-asana-bug-drill\n M apps/tui/src/app.rs\n M apps/tui/src/client.rs\n M apps/tui/src/main.rs\n M apps/tui/src/workbench.rs\n M libs/generic/resumable-download\n M libs/generic/tooldef\n M libs/papercusp\n M libs/test-config\n M package-lock.json\n M packages/omp-plugin/__tests__/native-extension.integration.test.ts\n M packages/omp-plugin/__tests__/native-extension.test.ts\n M packages/omp-plugin/src/native-extension.ts\n M packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts\n M packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.integration.test.ts\n M packages/operator-core/lib/agent-tools/capability/launch-agent.test.ts\n M packages/operator-core/lib/agent-tools/capability/launch-agent.ts\n M packages/operator-core/lib/agent-tools/locks/acquire.ts\n M packages/operator-core/lib/agent-tools/locks/attribution-nudge.integration.test.ts\n M packages/operator-core/lib/agent-tools/locks/attribution-nudge.test.ts\n M packages/operator-core/lib/agent-tools/locks/attribution-nudge.ts\n M packages/operator-core/lib/agent-tools/testing/__tests__/run.integration.test.ts\n M packages/operator-core/lib/agent-tools/testing/run-artifacts.ts\n M packages/operator-core/lib/backup/state-census-producers.test.ts\n M packages/operator-core/lib/backup/state-census-producers.ts\n M packages/operator-core/lib/edit-attribution.ts\n M packages/operator-core/lib/endpoint-route/routes/agent-mcp/mid-turn-context.test.ts\n M packages/operator-core/lib/external-bench/current-su.test.ts\n M packages/operator-core/lib/external-bench/current-su.ts\n M packages/operator-core/lib/external-bench/latency-attention-replay.integration.test.ts\n M packages/operator-core/lib/external-bench/private-fixture-reads.test.ts\n M packages/operator-core/lib/external-bench/run-launcher.ts\n M packages/operator-core/lib/harness/git-sync/lifecycle-candidate.integration.test.ts\n M packages/operator-core/lib/harness/routines/loop-execution-recovery.integration.test.ts\n M packages/operator-core/lib/harness/routines/loop-execution-recovery.test.ts\n M packages/operator-core/lib/harness/routines/loop-unreachable-guard.test.ts\n M packages/operator-core/lib/llm-testing/battery-harness.test.ts\n M packages/operator-core/lib/llm-testing/battery-harness.ts\n M packages/operator-core/lib/measurement-provenance.test.ts\n M packages/operator-core/lib/memory/context-injection-reliability.integration.test.ts\n M packages/operator-core/lib/memory/corpus-surfaced-ledger.ts\n M packages/operator-core/lib/memory/fixtures/native-mcp-export.ts\n M packages/operator-core/lib/memory/injection.test.ts\n M packages/operator-core/lib/memory/injection.ts\n M packages/operator-core/lib/memory/native-mcp-export.integration.test.ts\n M packages/operator-core/lib/memory/session-epoch-cross-port.integration.test.ts\n M packages/operator-core/lib/memory/session-epoch-ledger.test.ts\n M packages/operator-core/lib/memory/session-epoch-ledger.ts\n M packages/operator-core/lib/memory/temporal-render.test.ts\n M packages/operator-core/lib/memory/temporal-render.ts\n M packages/operator-core/lib/omp-managed-tools.native.integration.test.ts\n M packages/operator-core/lib/omp-managed-tools.native.test.ts\n M packages/operator-core/lib/su-session-rpc-engine.test.ts\n M packages/operator-core/lib/su-session-rpc-engine.ts\n M packages/operator-core/lib/su-session-stdio-peer.integration.test.ts\n M packages/operator-core/lib/su-session-stdio-peer.ts\n M packages/operator-core/lib/task-artifacts-client-baseline.integration.test.ts\n M packages/operator-core/test/committed-reader-source-preflight.test.ts\n M packages/operator-core/test/omp-managed-native-lifecycle.ts\n M packages/operator-core/test/private-http-workspace-preflight.ts\n M packages/operator-core/test/staging-first-http-fixture.ts\n M packages/plugin-loader/package.json\n M papercusp-desktop\n M scripts/lib/budgeted-task-scheduler.mjs\n?? .papercusp/evidence/luna-bg-preparation-20261107-measure-v3/binding.json\n?? apps/operator-docs/src/content/docs/agent-insights/blocker-resolution-evidenced-deferral.mdx\n?? packages/operator-core/lib/memory/source-version-ledgers.integration.test.ts"
  },
  "inputs": [
    {
      "path": "packages/operator-core/lib/backup/state-census-producers.test.ts",
      "sha256": "f256f113cb56143c636f4f8ba7683bac2877633fa8b6e4c0cae1b4d9ce2e1b74"
    },
    {
      "path": "packages/operator-core/lib/backup/state-census-cli.test.ts",
      "sha256": "edb3ebe125d9730fcf1e761f147c09a27b030273008d8a9edb437b8b5d7c21cc"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/testing/run-artifacts.test.ts",
      "sha256": "13c1253ca673ce32af33556f930cad92b303755105b835d97f8752ed70db875f"
    },
    {
      "path": "package.json",
      "sha256": "f6c19daf03ff3ae8a8468ca91ceb3365f707e0a66032b0d5b74af0959a8086d7"
    },
    {
      "path": "package-lock.json",
      "sha256": "09f19fbc305254d5e21b44f46a3f48fbed3a909197a6046f41f98a52102cf233"
    },
    {
      "path": "scripts/test-files.mjs",
      "sha256": "00b38eaf36a0774ad348245ee62a3e0ccc393fb980ed3d987d8c38b39d5774bb"
    }
  ],
  "coverage": "selected files and dependency lock; loaded import closure is reporter-owned",
  "runtimeInputs": "/home/marsh-office/.papercusp/test-artifacts/testing-run/run-5p7For/executed-inputs"
}

