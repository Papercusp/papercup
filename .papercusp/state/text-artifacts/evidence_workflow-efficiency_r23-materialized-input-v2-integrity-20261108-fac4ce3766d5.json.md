---
rel_path: "evidence/workflow-efficiency/r23-materialized-input-v2-integrity-20261108-fac4ce3766d5.json"
updated_at: 1794157628614
_body: "content"
---

{
  "packetSha256": "fac4ce3766d5ceacba6bf53437ef051c2ec501fa75f865d00db56469b62d76b1",
  "previousInputAudit": "c7e65bcea4975cd100670db5907208b634b0e9f2514c124426052ee538f40510",
  "selectedInputChecks": [
    {
      "caseCallSha256": "a5a0cda35c422229dbad0842c496c65a64447f7f06ddeb5ce69735ef78801f72",
      "inputsEqualToPreviouslyIndependentlyEvaluatedV1": true
    },
    {
      "caseCallSha256": "5fd710c6286775de72fd92b1cdd4625c49a6256c814ebf9762c5d10da063be21",
      "inputsEqualToPreviouslyIndependentlyEvaluatedV1": true
    },
    {
      "caseCallSha256": "8f47516ec27b240d18e71ea0ee2caabc72f87a5c98dbea1b7c2556069e844d1b",
      "inputsEqualToPreviouslyIndependentlyEvaluatedV1": true
    },
    {
      "caseCallSha256": "2f1d6683d4caa565fff45fffeae9aa0cc31a644250c54df3a99b1b41b85f92f8",
      "inputsEqualToPreviouslyIndependentlyEvaluatedV1": true
    }
  ],
  "p017LifecycleCase": {
    "testName": "retains an active lease, then reclaims after %s consumer expiry",
    "source": {
      "path": "packages/operator-core/lib/storage/disk-reclaim.integration.test.ts",
      "start": 15991,
      "end": 22054,
      "line": 271,
      "sourceBytes": "it.each(['terminal', 'dead', 'abandoned', 'revoked'] as const)('retains an active lease, then reclaims after %s consumer expiry', async loss => {\n    const { root, options } = await setup();\n    const db = await createFreshPgDb('open-evidence-retention');\n    const home = join(root, 'home'), repository = join(fixture!, 'repo'), dir = join(fixture!, 'leases');\n    const evidenceRoot = join(home, '.papercusp/evidence');\n    const retained = join(evidenceRoot, 'WI-open-native'), unrelated = join(evidenceRoot, 'unrelated');\n    await mkdir(retained, { recursive: true }); await mkdir(unrelated);\n    await writeFile(join(retained, 'result.json'), '{\"passed\":true}'); await writeFile(join(unrelated, 'data'), 'expired');\n    await mkdir(join(repository, 'docs/evidence'), { recursive: true });\n    const evidenceRef = 'docs/evidence/native.json';\n    await writeFile(join(repository, evidenceRef), JSON.stringify({ retainedEvidence: {\n      root: '.papercusp/evidence/WI-open-native', pathBase: 'Operating account home directory',\n    } }));\n    const nowMs = options.nowMs + 48 * 3_600_000;\n    const repositories = new Map([['fixture', repository]]);\n    let lost = false;\n    const consumer = {\n      nowMs,\n      listPresence: async () => [{\n        ownerId: 'consumer', ownerLabel: 'Fixture consumer', workspaceId: 'fixture', source: 'fixture',\n        intent: '', currentPlanSlug: null, currentFiles: [], host: 'fixture-host', pid: null, tty: null,\n        startedAt: new Date(nowMs).toISOString(), heartbeatAt: new Date(nowMs).toISOString(),\n        lastActiveAt: null, intentDeclaredAt: null, agentRole: 'su', potSlug: null,\n        capabilityTags: [], stale: false, userId: null, revoked: lost && loss === 'revoked',\n      } satisfies PresenceRecord],\n      resolveSessionStates: ((subjects, opts) => resolveSessionStates(subjects, { ...opts,\n        fetchWakeabilityFn: async ids => new Map(ids.map(id => [id, { wakeable: false, liveTurn: !lost }])),\n        fetchRecordedLiveFn: async () => new Set(), fetchRecordedEndedFn: async () => new Set(), probePidFn: () => null,\n      })) as typeof resolveSessionStates,\n    };\n    try {\n      await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared;\n        CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text, feature_id text, status text, taken_by text);\n        CREATE TABLE harness_shared.spec_evidence_bindings (workspace_id text, harness_slug text, work_item_id text, evidence_ref text, retracted_at timestamptz)`);\n      await db.sql`INSERT INTO harness_shared.work_items VALUES ('fixture', 'fixture', 'WI-open', 'blocked', 'consumer'),\n        ('fixture', 'fixture', 'WI-done', 'done', 'consumer'), ('foreign', 'fixture', 'WI-foreign', 'open', 'consumer'),\n        ('fixture', 'fixture', 'WI-retracted', 'open', 'consumer')`;\n      await db.sql`INSERT INTO harness_shared.spec_evidence_bindings VALUES\n        ('fixture', 'fixture', 'WI-open', ${evidenceRef}, NULL), ('fixture', 'fixture', 'WI-done', ${evidenceRef}, NULL),\n        ('fixture', 'fixture', 'WI-foreign', ${evidenceRef}, NULL), ('fixture', 'fixture', 'WI-retracted', ${evidenceRef}, now())`;\n      expect(await readOpenWorkItemEvidenceReferences(db.sql, 'fixture', consumer)).toEqual([\n        { harness_slug: 'fixture', work_item_id: 'WI-open', evidence_ref: evidenceRef },\n      ]);\n      const readProtection = async () => {\n        const refs = await readOpenWorkItemEvidenceReferences(db.sql, 'fixture', consumer);\n        const renewal = await renewWorkItemEvidencePins(refs, { repositories, home, dir, nowMs });\n        expect(renewal.missing).toEqual([]);\n        return { paths: [], pins: readRetentionPins({ dir, nowMs }).pins };\n      };\n      const policy = options.policy.map(cls => ({ ...cls, roots: [evidenceRoot] }));\n      const receipt = await runDiskReclaimOnce({ ...options, nowMs, policy, roots: [{ path: evidenceRoot, classId: 'fixture' }], readProtection });\n      expect(receipt.errors).toEqual([]);\n      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: retained, status: 'protected' }));\n      expect(receipt.entries).toContainEqual(expect.objectContaining({ path: unrelated, status: 'removed' }));\n      expect(JSON.parse(await readFile(join(retained, 'result.json'), 'utf8'))).toEqual({ passed: true });\n      await expect(stat(unrelated)).rejects.toMatchObject({ code: 'ENOENT' });\n      const originalPin = readRetentionPins({ dir, nowMs }).pins[0]!;\n      if (loss === 'terminal') await db.sql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = 'WI-open'`;\n      if (loss === 'abandoned') await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE feature_id = 'WI-open'`;\n      lost = true;\n      const refs = await readOpenWorkItemEvidenceReferences(db.sql, 'fixture', consumer);\n      expect(refs).toEqual([]);\n      await renewWorkItemEvidencePins(refs, { repositories, home, dir, nowMs: nowMs + 48 * 3_600_000 });\n      expect(readRetentionPins({ dir, nowMs }).pins).toEqual([originalPin]);\n      const protectedRun = await runDiskReclaimOnce({ ...options, nowMs: nowMs + 48 * 3_600_000,\n        policy, roots: [{ path: evidenceRoot, classId: 'fixture' }],\n        readProtection: async () => ({ paths: [], pins: readRetentionPins({ dir, nowMs: nowMs + 48 * 3_600_000 }).pins }) });\n      expect(protectedRun.errors).toEqual([]);\n      expect(protectedRun.entries).toContainEqual(expect.objectContaining({ path: retained, status: 'protected' }));\n      const later = nowMs + 73 * 3_600_000;\n      const final = await runDiskReclaimOnce({ ...options, nowMs: later, policy, roots: [{ path: evidenceRoot, classId: 'fixture' }],\n        readProtection: async () => ({ paths: [], pins: readRetentionPins({ dir, nowMs: later }).pins }) });\n      expect(final.errors).toEqual([]);\n      expect(final.entries).toContainEqual(expect.objectContaining({ path: retained, status: 'removed' }));\n      await expect(stat(retained)).rejects.toMatchObject({ code: 'ENOENT' });\n    } finally { await db.cleanup(); }\n  }, 120_000)",
      "sha256": "eb540696b226806f7024589f8bbcff6daf666816a2d9759ab818b52a8f284d41"
    },
    "parameterTable": {
      "sourceBytes": "['terminal', 'dead', 'abandoned', 'revoked'] as const",
      "value": [
        "terminal",
        "dead",
        "abandoned",
        "revoked"
      ]
    },
    "parameterBindings": [
      {
        "loss": "terminal"
      },
      {
        "loss": "dead"
      },
      {
        "loss": "abandoned"
      },
      {
        "loss": "revoked"
      }
    ]
  },
  "scope": "data preparation integrity only; no whole-flow execution, oracle or acceptance claim"
}
