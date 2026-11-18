/** R23 preparation frozen from historical test/source bytes before follow-up
 * replay work. Extends the existing pilot fixture workflow and source-path census.
 * These eight candidates do not establish the exhaustive concrete worker-surface
 * inventory, independent oracle qualification, replay execution or acceptance.
 * Keep the unresolved obligations explicit; never grade the draft as a pass.
 */
export const PAPERWORK_ORDINARY_INPUT_PREPARATION = {
  "schemaVersion": "paperwork-ordinary-input-preparation-v1",
  "status": "draft-pending-concrete-inventory-and-independent-review",
  "sourceCommit": "7391fad3b8c4e0c7d5efe519cc1040347642476e",
  "sourcePlan": "agent-paperwork-and-restart-tax-reduction-2026-10-15",
  "sourceRequirement": "R-23",
  "sourceSpec": "AUTO-BAR-R-23-P-018@4",
  "preparationAuthor": "su-1a1d1b35-c317-44f4-a10b-51661ce46a8e",
  "collector": {
    "path": "scripts/lib/source-path-census.mjs",
    "sha256": "2f6da9672e87756667b98744ea9453213e7c2a2fa0319c0a0ae6711a81fd4783",
    "includeDefinitions": true
  },
  "caseManifestSha256": "680c2469f058b610744bc9cc47c01c439aa122c381db2b07b17e373d9caedb30",
  "flows": [
    {
      "itemId": "P-016",
      "family": "claim/conversion/admission/autobind",
      "fixture": {
        "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.test.ts",
        "sha256": "eaba8b9255fca19571871282896f0dccc0401789871b8ab25ba44596a1458f5b",
        "caseTitle": "replays the migrated P536 rows as one canonical execution lane on resume",
        "caseSha256": "86e8b673abc856cc19e7873bd37d50d26bf11217718cce74843e12a7eb9c555d",
        "caseSource": "it('replays the migrated P536 rows as one canonical execution lane on resume', () => {\n    // Physical topology read from WI-6554700010037375 and WI-6554700010026007\n    // on 2026-11-07. Only plan readiness/lane availability are simulated: this\n    // unit replay does not reopen the real blocked P536 or admit its native run.\n    const execution = { id: 'WI-6554700010026007', family: 'issue' as const,\n      state: 'open', parent: 'WI-6554700010037375', sourcePlanItemIds: ['P-536'],\n      payload: { plan_item: { item_id: 'P-536', plan_slug: 'p2p-public-release-endgame-2026-09-01', harness_slug: 'papercusp' } } };\n    const shadow = { id: 'WI-6554700010037375', family: 'feature' as const,\n      state: 'blocked', sourcePlanItemIds: ['P-536'],\n      payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } };\n    const replay = (workItems: Array<typeof execution | typeof shadow>) => evaluateExactPlanAdmission({\n      planSlug: 'p2p-public-release-endgame-2026-09-01', planItems: [item('P-536')],\n      workItems, laneHealth: lane({ issue: 1, feature: 0 }),\n    });\n    const canonical = [{ planItemId: 'P-536', workItemId: execution.id }];\n\n    expect(replay([execution])).toMatchObject({ ready: true, actionableRows: canonical });\n    expect(replay([shadow, execution])).toMatchObject({ ready: true,\n      promotion: { rows: 2, duplicateActionable: [], missingActionableItemIds: [] }, actionableRows: canonical });\n    expect(replay([shadow])).toMatchObject({ ready: false, reason: 'promotion-lag',\n      promotion: { missingActionableItemIds: ['P-536'] } });\n    // A real second execution row must still be rejected; migration metadata\n    // exempts only the parked shadow, not arbitrary duplicate work.\n    expect(replay([shadow, execution, { ...execution, id: 'WI-competing', parent: 'WI-unrelated' }]))\n      .toMatchObject({ ready: false, reason: 'duplicate-coverage', promotion: {\n        duplicateActionable: [{ planItemId: 'P-536', workItemIds: [execution.id, 'WI-competing'] }],\n      } });\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.ts",
        "sha256": "9b91bb39f55e87c76a24679d61801e263931a874a61364ea384f5e4a1a69611b",
        "candidateCensusSha256": "87b7ae756d732a6e6c8e7d9a92c4decf54cee097d42332a019170e84458064d7",
        "calls": 316,
        "definitions": 784
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/work_items/claim.ts",
        "packages/operator-core/lib/agent-tools/work_items/claim_next.ts",
        "packages/operator-core/lib/agent-tools/plan-items/claim.ts",
        "packages/operator-core/lib/agent-tools/plan-items/convert.ts",
        "packages/operator-core/lib/agent-tools/plans/start.ts"
      ]
    },
    {
      "itemId": "P-017",
      "family": "custody intake/release",
      "fixture": {
        "path": "packages/operator-core/lib/storage/retention-pins.test.ts",
        "sha256": "bd1f1208f54aa78cdbf23ce81d679734812ed6bf0692a530c305292849030cbb",
        "caseTitle": "permits only the pin owner to release an exact id",
        "caseSha256": "b8724f23b93d428f91702c41a639f8c620b3780477053af8ed6de468a632261e",
        "caseSource": "it('permits only the pin owner to release an exact id', () => {\n    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'review', expiresAt: f.expiresAt }, f);\n    expect(() => removeRetentionPin(pin.id, 'agent-b', f)).toThrow(/only the pin owner/);\n    expect(readRetentionPins(f).pins).toEqual([pin]);\n    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(true);\n    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(false);\n    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/storage/retention-pins.ts",
        "sha256": "58eaf729096714a4ecf4289354bb672073b0935196292c1e7788878046d8acc1",
        "candidateCensusSha256": "9fb3d852a9c7372047d0a510ac55ea35e4900a021631392b8363e1de6951b9af",
        "calls": 67,
        "definitions": 126
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/work_items/get.ts",
        "packages/operator-core/lib/agent-tools/work_items/checkpoint.ts",
        "packages/operator-core/lib/agent-tools/work_items/complete.ts",
        "scripts/source-preview.mjs"
      ]
    },
    {
      "itemId": "P-018",
      "family": "claim/history/carry/recovery",
      "fixture": {
        "path": "packages/operator-core/lib/plan-decisions-claim-port.test.ts",
        "sha256": "0d83b676bb85baf14849726b368db7d046aa65912f684ebbc6f57f02773c4403",
        "caseTitle": "keeps an older task-linked ruling ahead of recent unrelated decisions, with exact omitted refs",
        "caseSha256": "5a7e696f28427fb600a4c42daf495df962242273367a82a33a3717c38f1d052d",
        "caseSource": "it('keeps an older task-linked ruling ahead of recent unrelated decisions, with exact omitted refs', async () => {\n    mockGetPlanRow.mockResolvedValueOnce({\n      content: PLAN_WITH_MANY_DECISIONS.replace('Body of early ruling 1.', 'P-003 must preserve the selected route.'),\n    });\n    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('busy-plan') });\n    expect(r?.decisions.map((d) => d.id)).toEqual([\n      'D-001', 'D-006', 'D-007', 'D-008', 'D-009', 'D-010', 'D-011', 'D-012',\n    ]);\n    expect(r?.taskLinkedDecisions).toBe(1);\n    expect(r?.omittedDecisionRefs).toEqual([\n      'busy-plan#D-002', 'busy-plan#D-003', 'busy-plan#D-004', 'busy-plan#D-005',\n    ]);\n    expect(renderPlanDecisionsNote(r!)).toContain('task-linked');\n    expect(renderPlanDecisionsNote(r!)).not.toContain('8 MOST RECENT');\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/plan-decisions-claim-port.ts",
        "sha256": "6b939908875c20de107b03a3f0aa84049cdafa3a096a4b2c415aec106228ca53",
        "candidateCensusSha256": "2d637190b4b788497a1e637da99348e0c666e5e7ac09cdb5a8737eb41e588091",
        "calls": 66,
        "definitions": 217
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/work_items/claim.ts",
        "packages/operator-core/lib/agent-tools/work_items/claim_next.ts",
        "packages/operator-core/lib/agent-tools/plan-items/claim.ts",
        "packages/operator-core/lib/agent-tools/coordination/tools/orient.ts",
        "packages/operator-core/lib/carry-doc.ts",
        "packages/operator-core/lib/prior-attempt-context.ts"
      ]
    },
    {
      "itemId": "P-019",
      "family": "optional context/event delivery",
      "fixture": {
        "path": "packages/operator-core/lib/events/await/inbox-wake-actionability.test.ts",
        "sha256": "a757128572617809423cd58f1a75263d5732168b009877c46e10c5ae1a92b859",
        "caseTitle": "a directed ask (%s) is actionable",
        "caseSha256": "9fb07e8139738d311f5e9373db847375ccca3782fe32267d6deb1033652ea2e3",
        "caseSource": "it.each([\n    ['expects action', msg({ expects: 'action' })],\n    ['expects answer', msg({ expects: 'answer' })],\n    ['expectsReply', msg({ expectsReply: true })],\n  ])('a directed ask (%s) is actionable', (_label, env) => {\n    const v = classifyInboxWakeMessage(env);\n    expect(v.actionable).toBe(true);\n    expect(v.class).toBe('directed-ask');\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/events/await/inbox-wake-actionability.ts",
        "sha256": "5f4aa9ba70f3e26f0be8aded5a3777adfc13103a8b9d1f3da2e4a4e9d46810a1",
        "candidateCensusSha256": "8fccf87ec19a690f93b12d41de1e0e4c0a84285a78c5e101432ffcb53e591e9c",
        "calls": 47,
        "definitions": 189
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/coordination/tools/send.ts",
        "packages/operator-core/lib/agent-tools/memory/remember.ts"
      ]
    },
    {
      "itemId": "P-020",
      "family": "ordinary close/remaining responsibility",
      "fixture": {
        "path": "packages/operator-core/lib/mission-continuity.test.ts",
        "sha256": "afc61ee0c5ab8a59c85ca890a39665e55b6faa4406602ac1748b4f3204e0c7f4",
        "caseTitle": "returns from a completed detour using fresh parent disposition, not child acceptance",
        "caseSha256": "cace4811e4e249308d18520855a03c059a25d15b2b11ebb86bbadcc3eb4e67d1",
        "caseSource": "it('returns from a completed detour using fresh parent disposition, not child acceptance', () => {\n    const result = reduceMissionContinuity(detour(), { id: 'done', kind: 'child-ended', childRef: 'message:question', terminal: true },\n      { ...parent, assignmentRevision: 2, nextActionRef: 'plan:mission#P-003' }, 3_000);\n    expect(result.state.currentWorkRef).toBe('WI-step');\n    expect(result.state.disposition).toBe('ready');\n    expect(result.state.frames).toEqual([]);\n    expect(result.consequences).toMatchObject([{ assignmentRevision: 2, continuationRef: 'plan:mission#P-003' }]);\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/mission-continuity.ts",
        "sha256": "676c890709bcdd65353fcd7b351d0ddc27ae60ecfab0122f1aff02531007a351",
        "candidateCensusSha256": "13ef78b5f9fa73a961ff6b4f1722d8d6fa0d4941c50eaf8c8d84cb9337d2b626",
        "calls": 31,
        "definitions": 266
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/work_items/complete.ts",
        "packages/operator-core/lib/agent-tools/plans/set-status.ts"
      ]
    },
    {
      "itemId": "P-021",
      "family": "runner/setup/reuse",
      "fixture": {
        "path": "packages/operator-core/lib/source-preview-export.test.ts",
        "sha256": "fb3e0638dca5a2b27ed6e1d1cac8ee070ec429b646cdbe5797afe5d373e7725d",
        "caseTitle": "reuses dependency hashes only while full source records and manifests remain unchanged",
        "caseSha256": "563bacdb5da6c5cc57dcf40340d166744d5fa02dd3359413e75c146018ac9522",
        "caseSource": "it('reuses dependency hashes only while full source records and manifests remain unchanged', async () => {\n    const root = join(tmp, 'dependency-census-cache-fingerprint');\n    const helper = 'papercusp-desktop/bin/lib/pinned-deps.sh';\n    write(root, helper, '#!/bin/bash\\nset -eu\\ntest \"$1\" = trees\\necho node_modules\\n');\n    write(root, DEPENDENCY_POLICY_PATH, DEPENDENCY_POLICY);\n    write(root, 'node_modules/example/index.mjs', 'export default 1;\\n');\n    write(root, 'app/index.mjs', 'workspace app');\n    write(root, 'lib/index.mjs', 'workspace lib');\n    symlinkSync('../app', join(root, 'node_modules/workspace'));\n    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),\n      testedInputs: [{ path: 'input.mjs', sha256: 'b'.repeat(64) }], files: [], submodules: [] };\n    const capture = (currentReceipt = receipt) => {\n      const progress: Array<{ cacheHit?: boolean }> = [];\n      const result = captureVerifierDependencies({ dest: root, receipt: currentReceipt,\n        onProgress: event => progress.push(event) });\n      return { result, progress: progress[0] };\n    };\n\n    const first = capture();\n    expect(first.progress).toMatchObject({ cacheHit: false });\n    const unchanged = capture();\n    expect(unchanged.progress).toMatchObject({ cacheHit: true });\n    expect(unchanged.result).toEqual(first.result);\n\n    const dependency = join(root, 'node_modules/example/index.mjs');\n    const originalMtime = statSync(dependency).mtime;\n    writeFileSync(dependency, 'export default 2;\\n');\n    await fsPromises.utimes(dependency, originalMtime, originalMtime);\n    const sameSizeEdit = capture();\n    expect(sameSizeEdit.progress).toMatchObject({ cacheHit: false });\n    expect(sameSizeEdit.result.trees[0]!.files.find(file => file.path === 'example/index.mjs')!.sha256)\n      .not.toBe(first.result.trees[0]!.files.find(file => file.path === 'example/index.mjs')!.sha256);\n    expect(capture().progress).toMatchObject({ cacheHit: true });\n\n    chmodSync(dependency, 0o755);\n    const modeEdit = capture();\n    expect(modeEdit.progress).toMatchObject({ cacheHit: false });\n    expect(modeEdit.result.trees[0]!.files.find(file => file.path === 'example/index.mjs')!.executable).toBe(true);\n    expect(capture().progress).toMatchObject({ cacheHit: true });\n\n    const link = join(root, 'node_modules/workspace');\n    rmSync(link);\n    symlinkSync('../lib', link);\n    const targetEdit = capture();\n    expect(targetEdit.progress).toMatchObject({ cacheHit: false });\n    expect(targetEdit.result.trees[0]!.files.find(file => file.path === 'workspace')!.sha256)\n      .not.toBe(modeEdit.result.trees[0]!.files.find(file => file.path === 'workspace')!.sha256);\n\n    const policyPath = join(root, DEPENDENCY_POLICY_PATH);\n    writeFileSync(policyPath, DEPENDENCY_POLICY + '\\n# census policy revision\\n');\n    const policyEdit = capture();\n    expect(policyEdit.progress).toMatchObject({ cacheHit: false });\n    expect(policyEdit.result.policy.sha256).not.toBe(targetEdit.result.policy.sha256);\n    const receiptEdit = capture({ ...receipt, sourceCommit: 'c'.repeat(40) });\n    expect(receiptEdit.progress).toMatchObject({ cacheHit: false });\n    expect(receiptEdit.result.sourceReceiptSha256).not.toBe(policyEdit.result.sourceReceiptSha256);\n  })"
      },
      "sourceRoot": {
        "path": "scripts/source-preview.mjs",
        "sha256": "05833210dd5743fe5035de1ea17bde024ed1b76e392c996b67e0e1d39bb13a05",
        "candidateCensusSha256": "0608613d66642f383c72f0637cb4d900c3ee54176403dfed890a090555f9b42a",
        "calls": 3205,
        "definitions": 3788
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/testing/run.ts",
        "scripts/source-preview.mjs"
      ]
    },
    {
      "itemId": "P-022",
      "family": "measurement/results emission",
      "fixture": {
        "path": "packages/operator-core/lib/agent-tools/plans/spec-evidence-autobind.test.ts",
        "sha256": "a7ebf1107dedb4c4c3347260325df7fd33d9722191dc03b8aa5f7226451c8a73",
        "caseTitle": "preserves the P536 execution proof on resume and binds again only for a changed clause",
        "caseSha256": "f5ccf36d415e93ee01b411fb703e3cd6686cbc6c2ff40370ff44862da366ac03",
        "caseSource": "it('preserves the P536 execution proof on resume and binds again only for a changed clause', async () => {\n    // Same canonical execution identity as the measured migrated P536 admission\n    // fixture. The clause, ledger run and binding below are unit fixture data,\n    // not an assertion that the historical native P536 controls passed.\n    const originalTarget = { ...target, planSlug: 'p2p-public-release-endgame-2026-09-01',\n      workItemId: 'WI-6554700010026007', specId: 'SPEC-P536-fixture', specRevision: 1 };\n    const originalProof = Object.freeze(binding(7, 10));\n    const { deps, writes } = fixture({ runs: [run(10, 'pass')] });\n    let currentTarget = originalTarget;\n    deps.loadTargets = async () => [currentTarget];\n    deps.loadLiveBindings = async () => new Map([[clauseKey(originalTarget), [originalProof]]]);\n\n    const before = await runSpecEvidenceAutobind('ws', deps);\n    // Rehydrating the execution target after its migration shadow was attached\n    // changes bookkeeping, not the clause, run, binding id or proof payload.\n    currentTarget = { ...originalTarget };\n    const resumed = await runSpecEvidenceAutobind('ws', deps);\n    expect(before.decisions).toEqual({ noop: 1, bind: 0, retract: 0 });\n    expect(resumed.decisions).toEqual(before.decisions);\n    expect(writes).toEqual([]);\n    expect((await deps.loadLiveBindings('ws', [currentTarget])).get(clauseKey(currentTarget)))\n      .toEqual([originalProof]);\n    expect(originalProof).toEqual(binding(7, 10));\n\n    // Scope/revision changes cannot inherit the unchanged-clause receipt.\n    currentTarget = { ...originalTarget, specRevision: 2 };\n    const changed = await runSpecEvidenceAutobind('ws', deps);\n    expect(changed.outcomes).toEqual([{ kind: 'bound', target: currentTarget, runId: 10 }]);\n    expect(writes).toEqual([{ op: 'bind', runId: 10 }]);\n    expect(originalProof).toEqual(binding(7, 10));\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/agent-tools/plans/spec-evidence-autobind.ts",
        "sha256": "4d15838e7cfe3c279179a34a801d3bf277b767a7c275416163ddec2c481094d2",
        "candidateCensusSha256": "661d039e732d306ac03db5552bdf0693fa70c4927a7146b9e290f674e554ead5",
        "calls": 155,
        "definitions": 492
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/testing/run.ts",
        "packages/operator-core/lib/agent-tools/scorecards/emit.ts",
        "packages/operator-core/lib/agent-tools/plans/bind-spec-evidence.ts",
        "packages/operator-core/lib/prior-attempt-measurement.ts"
      ]
    },
    {
      "itemId": "P-023",
      "family": "acceptance/ship gates",
      "fixture": {
        "path": "packages/operator-core/lib/agent-tools/plans/get-ship-readiness.test.ts",
        "sha256": "d3d77d75422d06be2ac200ac0dc0671748aaa1d35a6014e1974664a19c050492",
        "caseTitle": "returns the shared evaluator's verdict VERBATIM when requested",
        "caseSha256": "d35e57156969b12a3a0d7719ce88e447c71a0a0f885cc0e570a43d02fabe200f",
        "caseSource": "it(\"returns the shared evaluator's verdict VERBATIM when requested\", async () => {\n    const result = await run({ slug: 'alpha', shipReadiness: true });\n    expect(M.resolvePlanAcceptanceGateVerdict).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'alpha' }));\n    // The teaching message is passed through unsummarized — an agent acts on the\n    // named repair, so paraphrasing it here would defeat the point.\n    expect(result.results[0].shipReadiness).toMatchObject({\n      satisfied: false,\n      code: 'audit_coverage_stale',\n      message: '3 item audit(s) are missing or stale — P-002; P-004; P-005.',\n      buildProvenance: { sha: 'gate-sha', version: '1.2.3' },\n      acceptanceBarContractSnapshot: {\n        schemaVersion: 1,\n        contentHash: 'snapshot-hash',\n        readiness: {\n          nextRepair: { code: 'bar_snapshot_method_missing', barKey: 'R-1' },\n        },\n      },\n    });\n  })"
      },
      "sourceRoot": {
        "path": "packages/operator-core/lib/agent-tools/plans/get.ts",
        "sha256": "6eee6dcda663f1c097b30c90a387acd2d566701cff860d25443175d487f85297",
        "candidateCensusSha256": "13c424f217f374dc12c92ec5b6c00f6882161ed1ae761325f871679a141dc425",
        "calls": 405,
        "definitions": 1078
      },
      "qualification": "unknown",
      "workerSurfaceRootPaths": [
        "packages/operator-core/lib/agent-tools/plans/get.ts",
        "packages/operator-core/lib/agent-tools/plans/set-plan-status.ts",
        "packages/operator-core/lib/plan-acceptance-gate.ts"
      ]
    }
  ],
  "independentReviewRef": null,
  "executionReceiptRefs": [],
  "unresolved": [
    "These are historical unit input candidates, not an exhaustive inventory or R23 replay acceptance.",
    "Resolve every concrete outer worker schema, prompt, adapter/API and gate plus required fields/calls under all eight items; close transitive source membership and freeze that population.",
    "The complete historical test file is pinned because case callbacks refer to its helpers, mocks and setup. Resolve those inputs before claiming a self-contained replay.",
    "Independently review exact source/input/expected-output identity before follow-up replay implementation; copied case expectations and matching output do not establish independence.",
    "Freeze the expected-output manifest separately and join eligible original execution receipts at the exact source/input/spec identities.",
    "Run no-residue source comparison and all six prohibited-paperwork controls against the frozen concrete inventory; removed surfaces and unexecuted paths remain UNKNOWN.",
    "The7391 snapshot is a candidate baseline for follow-up work only; establish the historical ordinary-input identity for each worker surface before claiming absence of prior added paperwork."
  ],
  "workerSurfaceSources": [
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/tools/orient.ts",
      "sha256": "7a58cc7ca07c6723931c51d798b58e113773e1143ab8ea45965469c69ec4d797",
      "candidateCensusSha256": "c75d792e4ea12f5f9771ddca9980a5ecb1d9d294066e8d60313129ced7512d94",
      "importsSha256": "5d4024e4805de3401e1818f15c4ec2060e6ee12ab65dc03f4832d8bdb8fc41f9",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/tools/send.ts",
      "sha256": "a201b4cec297878410bcd0b3b6d1c66e38154a3c7659f5f3ddc51f0b790b5d6f",
      "candidateCensusSha256": "dc1da18431b558690baddc82e85608ce37255e9a915f43105823e5c672994673",
      "importsSha256": "5f3c602efd7d8c5241d67d849d9aa21a496c81f40114ad19c10fe64a878cc22a",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/memory/remember.ts",
      "sha256": "71b8de70e6852bc12631fcd1b7ece8044f9482a614eedfc63facd969ce437106",
      "candidateCensusSha256": "40ae5c8c39ac04299d7d4dcacc27098559d7318514e5e9107fcb29ab90f73332",
      "importsSha256": "ff9066970d4adcac314b6383e5c5d7776b6c334a7ccda01736d3d850fc077b52",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plan-items/claim.ts",
      "sha256": "cd715720072a681cedb232ced0efb4b0cb788a75bb2fe97079145512c505e49e",
      "candidateCensusSha256": "2a36ec7d627bc7da1d9ce22cf867829d5af42a0d46b5b187ca1aab397903b48c",
      "importsSha256": "23515b9ef460d6c4f539cc2df1988ee6df7f638c9082b1cd000f754ca06f3a48",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plan-items/convert.ts",
      "sha256": "46b699c995c7dbf4ef9eab78041195a012f13944686e321487a87a1622f43b2d",
      "candidateCensusSha256": "a1a8cca35f5280a974228f781660138d5d8928803e4bb947040862eb549d868d",
      "importsSha256": "8917b7d97b83cf4f4212307b670ebc4d7cb9219121d6a26130afcab65aa0a627",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/bind-spec-evidence.ts",
      "sha256": "6e55b4e7a81c180ff600b24d4bb1119e9857aa1b903620f2aec8d3bcde02f9ff",
      "candidateCensusSha256": "986b7864e130f3948c931ab358c922c1ab5eae869d88339dfeb94af95ba0148b",
      "importsSha256": "7f59b34ac4c23425b799b1444dc85cb0241da327bc8b141e5429e0e358754bbd",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/get.ts",
      "sha256": "6eee6dcda663f1c097b30c90a387acd2d566701cff860d25443175d487f85297",
      "candidateCensusSha256": "13c424f217f374dc12c92ec5b6c00f6882161ed1ae761325f871679a141dc425",
      "importsSha256": "5a126280fe28ad7656ac1f76e9220051040de2fdacac187343bcc5e173a467a8",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/set-plan-status.ts",
      "sha256": "7441289b4c796f6c1662b9c19e61821720876db28ed5208c358ddd74c5865def",
      "candidateCensusSha256": "17040444ce184d69e1ecd3fdd65f5bf9a98527d7a735fb4ae77d4a74779d42e7",
      "importsSha256": "63ba100532b1cde30f5dcb7af7b61fb7252232b484cc741ab33dddf403fe476e",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/set-status.ts",
      "sha256": "d1a2fb4770d4fba1b5b841e828c7700f6cd727916a72f221cf1de3d2e8cb6b8e",
      "candidateCensusSha256": "f007a0ef8c1ecce364a4747cdd3abc4e48aa3040bcf3fa21baa008229b4c554b",
      "importsSha256": "15ee50efe1de09ae22fa1b8688008dc811d2f25e753845e656d3afa792e22efe",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/start.ts",
      "sha256": "e2702b1cea63057927c901a16924e6927f01de70ac5df59147fd5d050d327a5d",
      "candidateCensusSha256": "2ba1bf9d8a33aa511989689d2d735a0d3de4c99d0bc7c3f52c012fa242e4ccb7",
      "importsSha256": "42781d6c66b83405c082c20b899635146c2742b6ae897843795b42105af0fc57",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/scorecards/emit.ts",
      "sha256": "528803afdf919a2ccab5ee49d26b3ded3fd8ac756d1dbaf045f35916181ec483",
      "candidateCensusSha256": "88df521a27ee5b350f883bbe0b3d10fcc0fef5571027a4b77d39cb6224e5a299",
      "importsSha256": "ebd0bf5fc155dcfff0145e0e264a0dcd179f984a1d8434d2a1bee2b1a58fed6a",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/testing/run.ts",
      "sha256": "c54d80c5247db4af57f5344c79ee9b09864724268f5da14cad682f143d067534",
      "candidateCensusSha256": "142fee35d13927e9725eda7cc9150e5f182efc0288c25bff32dc29841dcdb931",
      "importsSha256": "9b8a1bb482d9a27cafb9fe7bc95a9860165e104afbb7519ec8ea194c06e42bfa",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/checkpoint.ts",
      "sha256": "928b66c81f84c8353e34e4ee8937c97c1c00965828c8dc396c2750aa7e6ddf6a",
      "candidateCensusSha256": "da42efed7049e7adc32d56fa491487c2e204112b2990dcb67f15caa77c6a14ca",
      "importsSha256": "321ab8827d546e7a3e71b7753cc15ad73cc6d362e9ba5934e6fa14a12040cdc7",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/claim.ts",
      "sha256": "6161c23221b63ad5501774ed72e555f12aa2f04468421c7f366d4c121ba36130",
      "candidateCensusSha256": "9e6b65860d9025bb1ee0fbdaa33e9ff9e12091f0f48c7118f83a0a13c204d27f",
      "importsSha256": "f9e1df0cfeaba8e3140b1c3bb4daf4f7b99850224dd2929aed4d79dd847c59ed",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/claim_next.ts",
      "sha256": "5813d4ed28122b4c0b52f2dd3cb8923d734748824d239a9dafbdb8d1467249e7",
      "candidateCensusSha256": "5bab41fdb03ab6505840c4be88bc14648c720a8161e34287f39675c2cf1520f9",
      "importsSha256": "470dbc9de934997fa196d16c8d3293fc835893c9de893a9fdaf47b19b205b5d9",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/complete.ts",
      "sha256": "e3ff0a7b7426babf7e122d18e3d7fb87f436f0e4dc8ce05507403049f98a4660",
      "candidateCensusSha256": "8683aa4bb653c936f0051d6cb63911bad094b84bb8144358b81f3262b065701a",
      "importsSha256": "3eba13fb3d4076e2af206752de965295d56e182e03e63f0613c487e24e548832",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/get.ts",
      "sha256": "42a7042f12c06425243f636ba22d34c9f3a97a6fd33ce50bed9bf1b012342581",
      "candidateCensusSha256": "25b97b7bb321396086da226f85784243b4a6904e19822af165a8861349bb3487",
      "importsSha256": "9b040fe00911aafad355715eea6f74601eaab8dad35b45cdd74c316d0f46da6a",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/carry-doc.ts",
      "sha256": "bc9a20d2e82bb85d03d07ada4bd3c137db20a0f33be49bfde9cf81c2effcb3fa",
      "candidateCensusSha256": "de1e4c82b18786c57d86347902ecc0e312e21f0b7a21589c2d338eaf2a3c5e72",
      "importsSha256": "8af713d0a836ba9a2eb8742e13eaafb9256f871df63e1fce14c92aa2d8c48f78",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/plan-acceptance-gate.ts",
      "sha256": "b8011d2c416ccc50f085b1d0b883cc3d4848e84edabeef19edd381b124f1b71e",
      "candidateCensusSha256": "9d9a0de421bba8821f5652e2b0d1d3e3752270d93c991b3ca2b8f28123e0ac3f",
      "importsSha256": "21008adccfea059f8dc9cc452c8effdbce7554374ab2636d8d1e49241d264a81",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/prior-attempt-context.ts",
      "sha256": "1aa1aa5bd31c1178e7aeff611b9a408192de485eb978056aa94b1c3e5b7e1844",
      "candidateCensusSha256": "88f3f1a609678a56dfafd885ff66f25d403d837eff14c679cf9d4fd14239cee9",
      "importsSha256": "abba6fa606d1a803d61ea66c85112371700e202c9ccd79349333904cac989b00",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "packages/operator-core/lib/prior-attempt-measurement.ts",
      "sha256": "cb7257953f4a46b166dbfdc1bbdcbf2b524d68b61c46be3aadcdad8a70c05155",
      "candidateCensusSha256": "c8c4ed6c7fe6bf45fb2105e076bc953b9b84d14475050aa4ae21d890e20fca96",
      "importsSha256": "c2eda381f2f968b01f8fd94919b6d9403533a5fb791b33fcbc4bac2fa38a8f7c",
      "qualification": "unknown-transitive-membership-and-requiredness"
    },
    {
      "path": "scripts/source-preview.mjs",
      "sha256": "05833210dd5743fe5035de1ea17bde024ed1b76e392c996b67e0e1d39bb13a05",
      "candidateCensusSha256": "0608613d66642f383c72f0637cb4d900c3ee54176403dfed890a090555f9b42a",
      "importsSha256": "6a51713fcb20e59c8f85f8a0e27e4d737f00363b79d42c16e5b780b3899a4d1e",
      "qualification": "unknown-transitive-membership-and-requiredness"
    }
  ],
  "workerSurfaceSourceManifestSha256": "80298623d745931d8d8792b218c013a991430eeed78db60a954ff61769c49f44",
  "rootContractInventory": {
    "status": "partial-source-preparation-not-acceptance",
    "artifact": {
      "tool": "artifacts:load",
      "slug": "papercusp",
      "rel_path": "checkpoints/WI-6554700010045883/r23-root-contract-inventory-0960f8194f2b.json",
      "sha256": "0960f8194f2b4af951cc8ab71869e7989d9ed264d062e126ce793d11f514d331",
      "bytes": 1050104,
      "readback": "complete-byte-equal"
    },
    "scope": "The declared22 roots at the two frozen commits, composed root fields and variant alternatives, local contract/prompt spans, source-diff classes, and literal one-hop relative import targets. Candidate membership is not an exhaustive worker population.",
    "requiredness": {
      "method": "Resolve local schema aliases, preprocessing wrappers, object spreads and union alternatives. Preserve unresolved imported helpers and dynamic aliases instead of guessing requiredness. Root optionality does not prove nested or handler compatibility.",
      "addedOptionalRootFields": [
        "plans:get.discoveryAudit",
        "plans:get.planItemStartReadiness",
        "plans:set-status.noteKind",
        "plans:set-status.blockerDecision",
        "plans:start.owner_review",
        "testing:run.privatePgSetupTimeoutMs",
        "work_items:complete.blockerDecision",
        "work_items:get.adoptionSnapshot"
      ],
      "changedExistingRootFields": [
        "coord:orient.mode",
        "plans:get.activationReadiness",
        "plans:get.executionReadiness",
        "scorecards:emit.rerunRecipe",
        "scorecards:emit.subject",
        "testing:run.background",
        "testing:run.timeoutMs"
      ],
      "unresolved": [
        "work_items:complete derives legacy completion aliases through Object.fromEntries; the static root shape leaves this dynamic field population unresolved.",
        "Imported schema helpers, nested completion/binding/scorecard fields, refinements and handler gates need explicit requiredness dispositions at both frozen commits.",
        "Optional owner_review/blockerDecision/proof fields may become conditionally required in handler gates. No old ordinary input was replayed by this inventory.",
        "Internal adapters, source-preview CLI inputs and gates have no defineTool root schema here; their entrypoint signatures and downstream conditions remain separate inventory work."
      ]
    },
    "sourceDiffDispositions": [
      {
        "kind": "byte-identical-root-only",
        "paths": [
          "packages/operator-core/lib/agent-tools/memory/remember.ts",
          "packages/operator-core/lib/agent-tools/plan-items/claim.ts",
          "packages/operator-core/lib/agent-tools/plan-items/convert.ts"
        ],
        "meaning": "Root bytes match; dependencies, prompts and runtime acceptance are not qualified."
      },
      {
        "kind": "changed-needs-semantic-and-replay-disposition",
        "meaning": "Every remaining declared root has a source delta. The artifact retains added/removed syntax classes and first-hop import hashes; no change is waived as harmless or counted as a new paperwork requirement from syntax alone."
      }
    ],
    "remaining": [
      "Close recursive import/package/dispatch and actual worker prompt/hook membership without dropping unresolved or removed paths.",
      "Disposition every changed refinement, handler refusal and required call, including completion outcome/native-proof and blocker-decision gates, against the historical ordinary-input boundary.",
      "Freeze complete ordinary input/helper/mock identities and a separately reviewed expected-output manifest, then run eligible replay and six prohibited-paperwork controls."
    ],
    "independentReview": "unknown",
    "runtimeReplay": "not-run",
    "fullClosureQualified": false,
    "executionAdmitted": false
  },
  "historicalBaseline": {
    "status": "candidate-not-independent-review-qualified",
    "sourceCommit": "2531675c144198acfa435f5cbd883d7208c3eaf8",
    "sourceCommitTime": "2026-11-05T22:49:19-05:00",
    "boundaryRefs": [
      "session_turn:codex:01a1aec2-c618-7e13-a98b-abc1ce4d8ebf:20",
      "session_turn:codex:01a1af93-3edc-7c82-9392-809d90c3b0e8:6"
    ],
    "selection": "Existing canonical commit before the 2026-11-06 source directives. Source chronology alone does not establish the accepted ordinary-input baseline.",
    "roots": [
      {
        "path": "packages/operator-core/lib/agent-tools/coordination/tools/orient.ts",
        "baselineSha256": "f05367681b2db30354c0cad2bf78a126924be8d05bb8a2490907ea43308b2acf",
        "followupSha256": "7a58cc7ca07c6723931c51d798b58e113773e1143ab8ea45965469c69ec4d797"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/coordination/tools/send.ts",
        "baselineSha256": "d56823d50db865f3d21f38966bd69be7ba16a708c206e5507ef4056c4a30862b",
        "followupSha256": "a201b4cec297878410bcd0b3b6d1c66e38154a3c7659f5f3ddc51f0b790b5d6f"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/memory/remember.ts",
        "baselineSha256": "71b8de70e6852bc12631fcd1b7ece8044f9482a614eedfc63facd969ce437106",
        "followupSha256": "71b8de70e6852bc12631fcd1b7ece8044f9482a614eedfc63facd969ce437106"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plan-items/claim.ts",
        "baselineSha256": "cd715720072a681cedb232ced0efb4b0cb788a75bb2fe97079145512c505e49e",
        "followupSha256": "cd715720072a681cedb232ced0efb4b0cb788a75bb2fe97079145512c505e49e"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plan-items/convert.ts",
        "baselineSha256": "46b699c995c7dbf4ef9eab78041195a012f13944686e321487a87a1622f43b2d",
        "followupSha256": "46b699c995c7dbf4ef9eab78041195a012f13944686e321487a87a1622f43b2d"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plans/bind-spec-evidence.ts",
        "baselineSha256": "27003ee23d3329604ca04bf3331e595017527006ad40aba42f39ef48ba81cfde",
        "followupSha256": "6e55b4e7a81c180ff600b24d4bb1119e9857aa1b903620f2aec8d3bcde02f9ff"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plans/get.ts",
        "baselineSha256": "b4366821246c2e2abb400aa198b6da2fa9f82338d5f473ab3b046444e124a8db",
        "followupSha256": "6eee6dcda663f1c097b30c90a387acd2d566701cff860d25443175d487f85297"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plans/set-plan-status.ts",
        "baselineSha256": "bd61bfffc3e22c3a5feedeb5a45849bbad0504b657d0b851cb50806bab14407d",
        "followupSha256": "7441289b4c796f6c1662b9c19e61821720876db28ed5208c358ddd74c5865def"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plans/set-status.ts",
        "baselineSha256": "ee43ba6fabe9974dea2bb5a08a318b52dc3dc0eac636da16409d1d2e23a8764a",
        "followupSha256": "d1a2fb4770d4fba1b5b841e828c7700f6cd727916a72f221cf1de3d2e8cb6b8e"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/plans/start.ts",
        "baselineSha256": "c80f43ea52646a07aec3a42740b01c40cba515e8064c40f5cb1b4d733c7383ae",
        "followupSha256": "e2702b1cea63057927c901a16924e6927f01de70ac5df59147fd5d050d327a5d"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/scorecards/emit.ts",
        "baselineSha256": "b8fc8a03e046eeb580e1aa2fefc432a4d0f9722a734770a6abad664ec67e5248",
        "followupSha256": "528803afdf919a2ccab5ee49d26b3ded3fd8ac756d1dbaf045f35916181ec483"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/testing/run.ts",
        "baselineSha256": "edc87ccf07f5b800836fe1ed74a045341844de998e5c7abed1e4d699551e4d2b",
        "followupSha256": "c54d80c5247db4af57f5344c79ee9b09864724268f5da14cad682f143d067534"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/work_items/checkpoint.ts",
        "baselineSha256": "2f795636de984b935c845118eafbed44ecc7db36909cb50b44c14230c22b845e",
        "followupSha256": "928b66c81f84c8353e34e4ee8937c97c1c00965828c8dc396c2750aa7e6ddf6a"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/work_items/claim.ts",
        "baselineSha256": "3a1a2ca045245fdf4f6f5c4104dbf068da2ae09220d6685b396f6ae9a3d9b314",
        "followupSha256": "6161c23221b63ad5501774ed72e555f12aa2f04468421c7f366d4c121ba36130"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/work_items/claim_next.ts",
        "baselineSha256": "028e2a643827cb20853afaed055641d04e39be968130300073631020f5cc714d",
        "followupSha256": "5813d4ed28122b4c0b52f2dd3cb8923d734748824d239a9dafbdb8d1467249e7"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/work_items/complete.ts",
        "baselineSha256": "7d2a9fdb93ac56891384e2c292b2e31a419c14f67a14a0c18f6f519e41af0717",
        "followupSha256": "e3ff0a7b7426babf7e122d18e3d7fb87f436f0e4dc8ce05507403049f98a4660"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/work_items/get.ts",
        "baselineSha256": "6bc489fb8c8eaab7542a13f85b1e0b9ae20687e36573989ffe9dc54725e721f7",
        "followupSha256": "42a7042f12c06425243f636ba22d34c9f3a97a6fd33ce50bed9bf1b012342581"
      },
      {
        "path": "packages/operator-core/lib/carry-doc.ts",
        "baselineSha256": "0120a2158d9815447aff2d9e29e37f7356657fd3e70d5c220866d67a9ec24aa0",
        "followupSha256": "bc9a20d2e82bb85d03d07ada4bd3c137db20a0f33be49bfde9cf81c2effcb3fa"
      },
      {
        "path": "packages/operator-core/lib/plan-acceptance-gate.ts",
        "baselineSha256": "2408fdde3abce38e9d825a553365e85b5197349f68735d73f81a5b80c6344381",
        "followupSha256": "b8011d2c416ccc50f085b1d0b883cc3d4848e84edabeef19edd381b124f1b71e"
      },
      {
        "path": "packages/operator-core/lib/prior-attempt-context.ts",
        "baselineSha256": "cd75180c37ef1d464ae5e67bb205003b957d67dcff0eeae6d5e2e215385f3c70",
        "followupSha256": "1aa1aa5bd31c1178e7aeff611b9a408192de485eb978056aa94b1c3e5b7e1844"
      },
      {
        "path": "packages/operator-core/lib/prior-attempt-measurement.ts",
        "baselineSha256": "35abc6f380d6e112dbfa7b081be7e685ad864c9d68a65cc4277809da2918066b",
        "followupSha256": "cb7257953f4a46b166dbfdc1bbdcbf2b524d68b61c46be3aadcdad8a70c05155"
      },
      {
        "path": "scripts/source-preview.mjs",
        "baselineSha256": "5b7fb44010ac7cc0d4785f2237e4230126bda5a60d53465a4700cf933f34f5e1",
        "followupSha256": "05833210dd5743fe5035de1ea17bde024ed1b76e392c996b67e0e1d39bb13a05"
      }
    ],
    "ordinaryInputCandidates": [
      {
        "itemId": "P-016",
        "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.test.ts",
        "sha256": "2072191a2f8290116019275914d1e0008f509f475b145688bbcad027da5b0def",
        "caseTitle": "admits an issue-only lane and recognizes the legacy payload.plan_item provenance fallback",
        "caseSha256": "7df4ab45d304727cd62a8cf5934fc74fb8447eed986ce9afbc459ab3c03a500b",
        "caseSource": "it('admits an issue-only lane and recognizes the legacy payload.plan_item provenance fallback', () => {\n    const verdict = evaluateExactPlanAdmission({\n      planSlug: 'plan-a',\n      planItems: [item('P-001')],\n      workItems: [\n        {\n          id: 'WI-1',\n          family: 'issue',\n          sourcePlanItemIds: null,\n          payload: { plan_item: { item_id: 'P-001' } },\n        },\n      ],\n      laneHealth: lane({ issue: 1, featureReachable: false }),\n    });\n\n    expect(verdict).toMatchObject({\n      ready: true,\n      reason: 'ready',\n      promotion: { byFamily: { feature: 0, issue: 1 }, coveredActionable: 1 },\n      lane: { effective: { claimable: 1, basis: 'issue-family' } },\n    });\n  })",
        "qualification": "unknown"
      },
      {
        "itemId": "P-017",
        "path": "packages/operator-core/lib/storage/retention-pins.test.ts",
        "sha256": "9f83c26cafb5bcdf958aa8f01eb1348c022387d0b16f38fd3ea4e8b62b0d0d04",
        "caseTitle": "permits only the pin owner to release an exact id",
        "caseSha256": "b8724f23b93d428f91702c41a639f8c620b3780477053af8ed6de468a632261e",
        "caseSourceRef": "/flows/1/fixture/caseSource",
        "qualification": "unknown"
      },
      {
        "itemId": "P-018",
        "path": "packages/operator-core/lib/plan-decisions-claim-port.test.ts",
        "sha256": "52730c5a45a5d2a72ae373220f16e6d367416d39c6b56717dde7d14a3798c724",
        "caseTitle": "surfaces every structured decision, bounded + slug-tagged, when the plan has decisions",
        "caseSha256": "eba674cbf81bfcb2c98571a718d0f6567434797b41a9389a82597c2aeb18a284",
        "caseSource": "it('surfaces every structured decision, bounded + slug-tagged, when the plan has decisions', async () => {\n    mockGetPlanRow.mockResolvedValueOnce({ content: PLAN_WITH_DECISIONS });\n    const r = await getClaimTimePlanDecisions({ workItem: workItemWithPlan('agent-trap-guards-2026-07-26') });\n    expect(r).not.toBeNull();\n    expect(r?.planSlug).toBe('agent-trap-guards-2026-07-26');\n    expect(r?.decisions.map((d) => d.id)).toEqual(['D-001', 'D-002']);\n    expect(r?.decisions[1]?.title).toMatch(/ruling other lanes must follow/);\n    // The snippet is a bounded, single-line excerpt of the body — never the raw\n    // multi-line markdown.\n    expect(r?.decisions[1]?.snippet).not.toMatch(/\\n/);\n    // Under the cap, the window IS the whole set — so the count a caller renders\n    // is honest without any \"showing N of M\" hedging.\n    expect(r?.totalDecisions).toBe(2);\n  })",
        "qualification": "unknown"
      },
      {
        "itemId": "P-019",
        "path": "packages/operator-core/lib/events/await/inbox-wake-actionability.test.ts",
        "sha256": "a757128572617809423cd58f1a75263d5732168b009877c46e10c5ae1a92b859",
        "caseTitle": "a directed ask (%s) is actionable",
        "caseSha256": "9fb07e8139738d311f5e9373db847375ccca3782fe32267d6deb1033652ea2e3",
        "caseSourceRef": "/flows/3/fixture/caseSource",
        "qualification": "unknown"
      },
      {
        "itemId": "P-020",
        "path": "packages/operator-core/lib/mission-continuity.test.ts",
        "sha256": "afc61ee0c5ab8a59c85ca890a39665e55b6faa4406602ac1748b4f3204e0c7f4",
        "caseTitle": "returns from a completed detour using fresh parent disposition, not child acceptance",
        "caseSha256": "cace4811e4e249308d18520855a03c059a25d15b2b11ebb86bbadcc3eb4e67d1",
        "caseSourceRef": "/flows/4/fixture/caseSource",
        "qualification": "unknown"
      },
      {
        "itemId": "P-021",
        "path": "packages/operator-core/lib/source-preview-export.test.ts",
        "sha256": "e74dd8dd1f8036debb999a02bdff16b04318f671d0f90bb397c1333e3dd364ae",
        "caseTitle": "reuses dependency hashes only while full source records and manifests remain unchanged",
        "caseSha256": "563bacdb5da6c5cc57dcf40340d166744d5fa02dd3359413e75c146018ac9522",
        "caseSourceRef": "/flows/5/fixture/caseSource",
        "qualification": "unknown"
      },
      {
        "itemId": "P-022",
        "path": "packages/operator-core/lib/agent-tools/plans/spec-evidence-autobind.test.ts",
        "sha256": "b991c4c25060401fd3790cbd8b50dea776fbf6a4f53a5fc4fff46183cb430028",
        "caseTitle": "produces a binding from a qualifying pass without any agent call",
        "caseSha256": "ee43b0511b436ab44f2c6e1c86f95ac33a01bf0b17735976731f384cbd04d703",
        "caseSource": "it('produces a binding from a qualifying pass without any agent call', async () => {\n    const { deps, writes } = fixture({ runs: [run(9, 'fail'), run(10, 'pass')] });\n    const result = await runSpecEvidenceAutobind('ws', deps);\n    expect(writes).toEqual([{ op: 'bind', runId: 10 }]);\n    expect(result.outcomes).toEqual([{ kind: 'bound', target, runId: 10 }]);\n  })",
        "qualification": "unknown"
      },
      {
        "itemId": "P-023",
        "path": "packages/operator-core/lib/agent-tools/plans/get-ship-readiness.test.ts",
        "sha256": "63096d0798c57ba2060b0e825cc1eb51d98f464684e607eed56363ac19dfe78c",
        "caseTitle": "returns the shared evaluator's verdict VERBATIM when requested",
        "caseSha256": "d35e57156969b12a3a0d7719ce88e447c71a0a0f885cc0e570a43d02fabe200f",
        "caseSourceRef": "/flows/7/fixture/caseSource",
        "qualification": "unknown"
      }
    ],
    "ordinaryInputManifestSha256": "1955b84fac5fdfce6cc381cc7fb3cee418b920714407bc5e28e5a6a7653e96a1",
    "sourceComparison": {
      "comparison": "different",
      "checked": [
        "packages/operator-core/lib/agent-tools/coordination/tools/orient.ts",
        "packages/operator-core/lib/agent-tools/coordination/tools/send.ts",
        "packages/operator-core/lib/agent-tools/memory/remember.ts",
        "packages/operator-core/lib/agent-tools/plan-items/claim.ts",
        "packages/operator-core/lib/agent-tools/plan-items/convert.ts",
        "packages/operator-core/lib/agent-tools/plans/bind-spec-evidence.ts",
        "packages/operator-core/lib/agent-tools/plans/get.ts",
        "packages/operator-core/lib/agent-tools/plans/set-plan-status.ts",
        "packages/operator-core/lib/agent-tools/plans/set-status.ts",
        "packages/operator-core/lib/agent-tools/plans/start.ts",
        "packages/operator-core/lib/agent-tools/scorecards/emit.ts",
        "packages/operator-core/lib/agent-tools/testing/run.ts",
        "packages/operator-core/lib/agent-tools/work_items/checkpoint.ts",
        "packages/operator-core/lib/agent-tools/work_items/claim.ts",
        "packages/operator-core/lib/agent-tools/work_items/claim_next.ts",
        "packages/operator-core/lib/agent-tools/work_items/complete.ts",
        "packages/operator-core/lib/agent-tools/work_items/get.ts",
        "packages/operator-core/lib/carry-doc.ts",
        "packages/operator-core/lib/plan-acceptance-gate.ts",
        "packages/operator-core/lib/prior-attempt-context.ts",
        "packages/operator-core/lib/prior-attempt-measurement.ts",
        "scripts/source-preview.mjs"
      ],
      "gaps": [],
      "differences": [
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/tools/orient.ts",
          "beforeSha256": "f05367681b2db30354c0cad2bf78a126924be8d05bb8a2490907ea43308b2acf",
          "afterSha256": "7a58cc7ca07c6723931c51d798b58e113773e1143ab8ea45965469c69ec4d797",
          "addedOrChanged": 102,
          "removedOrChanged": 63
        },
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/tools/send.ts",
          "beforeSha256": "d56823d50db865f3d21f38966bd69be7ba16a708c206e5507ef4056c4a30862b",
          "afterSha256": "a201b4cec297878410bcd0b3b6d1c66e38154a3c7659f5f3ddc51f0b790b5d6f",
          "addedOrChanged": 20,
          "removedOrChanged": 20
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/bind-spec-evidence.ts",
          "beforeSha256": "27003ee23d3329604ca04bf3331e595017527006ad40aba42f39ef48ba81cfde",
          "afterSha256": "6e55b4e7a81c180ff600b24d4bb1119e9857aa1b903620f2aec8d3bcde02f9ff",
          "addedOrChanged": 113,
          "removedOrChanged": 102
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/get.ts",
          "beforeSha256": "b4366821246c2e2abb400aa198b6da2fa9f82338d5f473ab3b046444e124a8db",
          "afterSha256": "6eee6dcda663f1c097b30c90a387acd2d566701cff860d25443175d487f85297",
          "addedOrChanged": 241,
          "removedOrChanged": 86
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/set-plan-status.ts",
          "beforeSha256": "bd61bfffc3e22c3a5feedeb5a45849bbad0504b657d0b851cb50806bab14407d",
          "afterSha256": "7441289b4c796f6c1662b9c19e61821720876db28ed5208c358ddd74c5865def",
          "addedOrChanged": 48,
          "removedOrChanged": 4
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/set-status.ts",
          "beforeSha256": "ee43ba6fabe9974dea2bb5a08a318b52dc3dc0eac636da16409d1d2e23a8764a",
          "afterSha256": "d1a2fb4770d4fba1b5b841e828c7700f6cd727916a72f221cf1de3d2e8cb6b8e",
          "addedOrChanged": 267,
          "removedOrChanged": 69
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/start.ts",
          "beforeSha256": "c80f43ea52646a07aec3a42740b01c40cba515e8064c40f5cb1b4d733c7383ae",
          "afterSha256": "e2702b1cea63057927c901a16924e6927f01de70ac5df59147fd5d050d327a5d",
          "addedOrChanged": 1077,
          "removedOrChanged": 835
        },
        {
          "path": "packages/operator-core/lib/agent-tools/scorecards/emit.ts",
          "beforeSha256": "b8fc8a03e046eeb580e1aa2fefc432a4d0f9722a734770a6abad664ec67e5248",
          "afterSha256": "528803afdf919a2ccab5ee49d26b3ded3fd8ac756d1dbaf045f35916181ec483",
          "addedOrChanged": 2276,
          "removedOrChanged": 2089
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/run.ts",
          "beforeSha256": "edc87ccf07f5b800836fe1ed74a045341844de998e5c7abed1e4d699551e4d2b",
          "afterSha256": "c54d80c5247db4af57f5344c79ee9b09864724268f5da14cad682f143d067534",
          "addedOrChanged": 1059,
          "removedOrChanged": 369
        },
        {
          "path": "packages/operator-core/lib/agent-tools/work_items/checkpoint.ts",
          "beforeSha256": "2f795636de984b935c845118eafbed44ecc7db36909cb50b44c14230c22b845e",
          "afterSha256": "928b66c81f84c8353e34e4ee8937c97c1c00965828c8dc396c2750aa7e6ddf6a",
          "addedOrChanged": 214,
          "removedOrChanged": 79
        },
        {
          "path": "packages/operator-core/lib/agent-tools/work_items/claim.ts",
          "beforeSha256": "3a1a2ca045245fdf4f6f5c4104dbf068da2ae09220d6685b396f6ae9a3d9b314",
          "afterSha256": "6161c23221b63ad5501774ed72e555f12aa2f04468421c7f366d4c121ba36130",
          "addedOrChanged": 33,
          "removedOrChanged": 20
        },
        {
          "path": "packages/operator-core/lib/agent-tools/work_items/claim_next.ts",
          "beforeSha256": "028e2a643827cb20853afaed055641d04e39be968130300073631020f5cc714d",
          "afterSha256": "5813d4ed28122b4c0b52f2dd3cb8923d734748824d239a9dafbdb8d1467249e7",
          "addedOrChanged": 16,
          "removedOrChanged": 12
        },
        {
          "path": "packages/operator-core/lib/agent-tools/work_items/complete.ts",
          "beforeSha256": "7d2a9fdb93ac56891384e2c292b2e31a419c14f67a14a0c18f6f519e41af0717",
          "afterSha256": "e3ff0a7b7426babf7e122d18e3d7fb87f436f0e4dc8ce05507403049f98a4660",
          "addedOrChanged": 764,
          "removedOrChanged": 372
        },
        {
          "path": "packages/operator-core/lib/agent-tools/work_items/get.ts",
          "beforeSha256": "6bc489fb8c8eaab7542a13f85b1e0b9ae20687e36573989ffe9dc54725e721f7",
          "afterSha256": "42a7042f12c06425243f636ba22d34c9f3a97a6fd33ce50bed9bf1b012342581",
          "addedOrChanged": 113,
          "removedOrChanged": 34
        },
        {
          "path": "packages/operator-core/lib/carry-doc.ts",
          "beforeSha256": "0120a2158d9815447aff2d9e29e37f7356657fd3e70d5c220866d67a9ec24aa0",
          "afterSha256": "bc9a20d2e82bb85d03d07ada4bd3c137db20a0f33be49bfde9cf81c2effcb3fa",
          "addedOrChanged": 19,
          "removedOrChanged": 9
        },
        {
          "path": "packages/operator-core/lib/plan-acceptance-gate.ts",
          "beforeSha256": "2408fdde3abce38e9d825a553365e85b5197349f68735d73f81a5b80c6344381",
          "afterSha256": "b8011d2c416ccc50f085b1d0b883cc3d4848e84edabeef19edd381b124f1b71e",
          "addedOrChanged": 4,
          "removedOrChanged": 4
        },
        {
          "path": "packages/operator-core/lib/prior-attempt-context.ts",
          "beforeSha256": "cd75180c37ef1d464ae5e67bb205003b957d67dcff0eeae6d5e2e215385f3c70",
          "afterSha256": "1aa1aa5bd31c1178e7aeff611b9a408192de485eb978056aa94b1c3e5b7e1844",
          "addedOrChanged": 57,
          "removedOrChanged": 6
        },
        {
          "path": "packages/operator-core/lib/prior-attempt-measurement.ts",
          "beforeSha256": "35abc6f380d6e112dbfa7b081be7e685ad864c9d68a65cc4277809da2918066b",
          "afterSha256": "cb7257953f4a46b166dbfdc1bbdcbf2b524d68b61c46be3aadcdad8a70c05155",
          "addedOrChanged": 259,
          "removedOrChanged": 0
        },
        {
          "path": "scripts/source-preview.mjs",
          "beforeSha256": "5b7fb44010ac7cc0d4785f2237e4230126bda5a60d53465a4700cf933f34f5e1",
          "afterSha256": "05833210dd5743fe5035de1ea17bde024ed1b76e392c996b67e0e1d39bb13a05",
          "addedOrChanged": 1868,
          "removedOrChanged": 633
        }
      ],
      "receipt": false,
      "fullClosureQualified": false,
      "executionAdmitted": false
    }
  }
} as const;

