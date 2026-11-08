---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/fixture-read-bridge-20261107/tsc-attempt1.log"
updated_at: 1794095643172
_body: "content"
---

COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 3763190, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: node scripts/lint-tsc.mjs --files=packages/operator-core/lib/external-bench/private-fixture-reads.ts,packages/operator-core/lib/external-bench/private-fixture-reads.test.ts,packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts,packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts,packages/operator-core/lib/capability-envelope/session-confinement.ts,packages/operator-core/lib/capability-envelope/session-confinement-store.ts,packages/operator-core/lib/external-bench/current-su.ts,packages/operator-core/lib/external-bench/current-su.test.ts,packages/operator-core/lib/external-bench/reproducibility/schema.ts,packages/operator-core/lib/agent-tools/index.ts --all-errors (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
LINT_TSC_RUN_STAMP label=operator-core at=2026-11-07T23:26:33.395Z head=3e9430e483 scope=files files=10
  checked files : packages/operator-core/lib/external-bench/private-fixture-reads.ts
                 packages/operator-core/lib/external-bench/private-fixture-reads.test.ts
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts
                 packages/operator-core/lib/capability-envelope/session-confinement.ts
                 packages/operator-core/lib/capability-envelope/session-confinement-store.ts
                 packages/operator-core/lib/external-bench/current-su.ts
                 packages/operator-core/lib/external-bench/current-su.test.ts
                 packages/operator-core/lib/external-bench/reproducibility/schema.ts
                 packages/operator-core/lib/agent-tools/index.ts
LINT_TSC_CROSS_LEG checked=4 clean=- red=lint:tsc:operator-vite,lint:tsc:orchestrator,lint:tsc:operator,lint:tsc:scripts undetermined=- uncheckable=lint:tsc:papercusp-libs,lint:tsc:workspaces notMember=-
❌ cross-leg: lint:tsc:operator-vite reaches a named file by import and reports a regression there:
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=queued elapsedMs=0 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=refresh elapsedMs=12174 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=compiler-initialize elapsedMs=15278 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=compiler-initialized elapsedMs=15343 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=snapshot-update elapsedMs=15343 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=snapshot-rpc-completed elapsedMs=20357 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=snapshot-updated elapsedMs=20389 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=project-roots-refresh elapsedMs=20389 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=project-roots-refreshed elapsedMs=20432 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=refreshed elapsedMs=20432 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=program-files elapsedMs=20896 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 serverPhase=scope elapsedMs=20960 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 resultOrigin=pending
   TSC_SERVICE state=queued requestId=00eab84d-66ca-40f6-a7c3-ab734d902601 resultOrigin=pending
   ❌ operator-vite: packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts has 1 error(s) in this leg (baseline 0); this leg reaches it by import.
      packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts(19,9): error TS2769: No overload matches this call.
❌ cross-leg: lint:tsc:orchestrator reaches a named file by import and reports a regression there:
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=queued elapsedMs=0 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=refresh elapsedMs=21816 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=compiler-initialize elapsedMs=26624 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=compiler-initialized elapsedMs=26680 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=snapshot-update elapsedMs=26680 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=snapshot-rpc-completed elapsedMs=29875 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=snapshot-updated elapsedMs=29942 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=project-roots-refresh elapsedMs=29943 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=project-roots-refreshed elapsedMs=29953 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=refreshed elapsedMs=29953 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=program-files elapsedMs=29953 resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f serverPhase=scope elapsedMs=29993 resultOrigin=pending
   ⚠ TSC_SERVICE request failed at /run/user/1000/papercusp-tsc-service.sock (no answer within 30000 ms requestId=4e9f1704-0ecc-44d5-b7da-e970ab33a89f) — running the full orchestrator cross-leg consumer compile instead. state=timed-out resultOrigin=full-compile-required
   ❌ orchestrator: packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts has 1 error(s) in this leg (baseline 0); this leg reaches it by import.
      packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts(19,9): error TS2769: No overload matches this call.
❌ cross-leg: lint:tsc:operator reaches a named file by import and reports a regression there:
   TSC_SERVICE state=queued requestId=4e422c9b-50fb-42ee-85cd-760d1f05801e resultOrigin=pending
   TSC_SERVICE state=queued requestId=4e422c9b-50fb-42ee-85cd-760d1f05801e serverPhase=queued elapsedMs=0 resultOrigin=pending
   ⚠ TSC_SERVICE request failed at /run/user/1000/papercusp-tsc-service.sock (connection closed before an answer requestId=4e422c9b-50fb-42ee-85cd-760d1f05801e) — running the full operator cross-leg consumer compile instead. state=protocol-error resultOrigin=full-compile-required
   ❌ operator: packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts has 1 error(s) in this leg (baseline 0); this leg reaches it by import.
      packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts(19,9): error TS2769: No overload matches this call.
❌ cross-leg: lint:tsc:scripts reaches a named file by import and reports a regression there:
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=queued elapsedMs=0 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=refresh elapsedMs=0 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=compiler-initialize elapsedMs=51 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=compiler-initialized elapsedMs=82 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=snapshot-update elapsedMs=82 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=snapshot-rpc-completed elapsedMs=2492 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=snapshot-updated elapsedMs=2522 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=project-roots-refresh elapsedMs=2522 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=project-roots-refreshed elapsedMs=2531 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=refreshed elapsedMs=2531 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=program-files elapsedMs=2531 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 serverPhase=scope elapsedMs=2555 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 resultOrigin=pending
   TSC_SERVICE state=accepted requestId=c10bf07c-8e90-467f-9a60-cba84e6787f8 resultOrigin=pending
   ❌ scripts: packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts has 1 error(s) in this leg (baseline 0); this leg reaches it by import.
      packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.ts(19,9): error TS2769: No overload matches this call.
   The owning leg can pass while these fail: the full gate runs every leg. Skip with --no-cross-leg only to debug.
LINT_TSC_RESULT label=operator-core scope=files exit=1 status=routed-failed at=2026-11-07T23:26:33.395Z head=3e9430e483

