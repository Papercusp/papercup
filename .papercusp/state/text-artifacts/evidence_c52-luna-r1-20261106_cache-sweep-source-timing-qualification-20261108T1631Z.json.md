---
rel_path: "evidence/c52-luna-r1-20261106/cache-sweep-source-timing-qualification-20261108T1631Z.json"
updated_at: 1794155454596
_body: "content"
---

{
  "schema": "luna-r1-cache-sweep-source-timing-v1",
  "createdAt": "2026-11-08T16:30:31.884478+00:00",
  "workItem": "WI-6554700010045700",
  "target": "WI-6554700010045992",
  "sourceRefs": [
    {
      "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010045992.json",
      "sha256": "50b8166380285d76972819d61035ffcd9b3c5cbacb54021c4dab1774aab9a285"
    },
    {
      "path": "/tmp/c52-terminal92-readback.json",
      "sha256": "f6ebe5562e2215ae91d66b0b0f1a8f09a26d3385c9b8a1861ed2ac7c6a73045a",
      "scope": "saved exact92 raw capture, single target extracted; completed92 assessments not read or changed"
    }
  ],
  "original": {
    "title": "cache_l2 expired entries are never swept by production code",
    "summary": "Discovered while investigating WI-6554700010045964. PgL2Store.set writes expires_at; PgL2Store.get treats expired rows as misses but intentionally leaves them stored. PgL2Store.sweepExpired() is documented as the periodic janitor and deletes expired rows, but a source search of packages/operator-core/lib found only its method definition and no production caller. Active l2:true cachedRead call sites use the L2 tier. A workspace-scoped, positive-controlled read on 2026-11-06 found 42/42 cache_l2 rows in papercusp-workspace expired, totaling 13,811,986 bytes of value::text. This proves retained expired payloads, not that they explain the entire 7.87 GB TOAST relation. Reuse an existing periodic cleanup routine if one fits, add a conventional regression test for scheduled expiry cleanup, and measure after old MVCC horizons clear. Do not use the sweep as a substitute for vacuum/rewrite reclamation.",
    "createdAt": "2026-11-06T17:54:01.075Z",
    "freshnessEnvelope": {
      "observedAt": "2026-11-06T17:54:01.075Z",
      "linkedFixRefs": [],
      "reporterSession": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
      "observedSourceSha": "d740fc3802",
      "toolSchemaVersion": null,
      "observedRuntimeSha": "d740fc3802",
      "deployBuildIdentity": "d740fc3802@0.0.0",
      "reporterRuntimeVersion": "0.0.0",
      "lastSuccessfulReproductionAt": null
    }
  },
  "savedCompletion": {
    "summary": "Closed as disproven: the production bg-host is running cacheL2ExpirySweep and deleting expired cache_l2 rows in the observed window. This does not explain the broader TOAST bloat, which remains tracked by WI-6554700010045964.",
    "verifiedHow": "Filtered papercusp-bg-host logs for six hours returned 23 cache-l2-expiry-sweep records, including removed=35 at 2026-11-07T02:05:08.379Z; DBOS workflow_status records the matching 02:05 run as SUCCESS.",
    "closed_ts": 1794017833989,
    "scope": "saved six-hour runtime report only; not freshly queried or independently runtime-attested"
  },
  "sourceWitnesses": [
    {
      "ref": "d740fc3802877d1c8c3b1068768681ee32ef0025",
      "path": "packages/operator-core/lib/dbos/periodic-workflows.ts",
      "gitBlob": "e758461cf269c1d96eaeafb61760c038bb849558",
      "sha256": "7e9389fcb53d7ec263b61b1200c6b760e1aabddad279759da05da264d3fdec2c",
      "bytes": 115819,
      "containsCacheL2ExpirySweepTick": false,
      "sweepLines": []
    },
    {
      "ref": "d740fc3802877d1c8c3b1068768681ee32ef0025",
      "path": "packages/operator-core/lib/cache/pg-l2-store.ts",
      "gitBlob": "76680ba962bfd41b662977aa4c587fd5de917633",
      "sha256": "eaf32921ed4ed1a7c039745f6923b79d3b2d77105620e9446ac3d21a77908f3c",
      "bytes": 8624,
      "containsCacheL2ExpirySweepTick": false,
      "sweepLines": [
        " * `set` is a single upsert, `invalidateByTags` / `sweepExpired` are single",
        "   * data (sweeping is the separate `sweepExpired` concern). Single SELECT.",
        "  async sweepExpired(): Promise<number> {"
      ]
    },
    {
      "ref": "84bceb17588933bb2abb6ea5b645b34335874be3^",
      "path": "packages/operator-core/lib/dbos/periodic-workflows.ts",
      "gitBlob": "c751bad64ca76492c54a15e32c6e6cc3c5f6482e",
      "sha256": "5274f53963349e4a18c217e7e5d1d03f9277004812968243eb8333fa6069b2ab",
      "bytes": 134355,
      "containsCacheL2ExpirySweepTick": false,
      "sweepLines": [
        "      const { sweepExpiredChatBrainSessions } = await import('../agent-tools/operator/converse-session');",
        "      const r = sweepExpiredChatBrainSessions();"
      ]
    },
    {
      "ref": "84bceb17588933bb2abb6ea5b645b34335874be3^",
      "path": "packages/operator-core/lib/cache/pg-l2-store.ts",
      "gitBlob": "ac2006c89af72b55beceb89a29ab4135ab7f8d4b",
      "sha256": "5a7489013e9dc9447c793851ecdda239680164a4f334c51a7ddb0f18fbde2bc0",
      "bytes": 9535,
      "containsCacheL2ExpirySweepTick": false,
      "sweepLines": [
        " * `set` is a single upsert, `invalidateByTags` / `sweepExpired` are single",
        "   * data (sweeping is the separate `sweepExpired` concern). Single SELECT.",
        "  async sweepExpired(batchSize = CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE): Promise<number> {"
      ]
    },
    {
      "ref": "84bceb17588933bb2abb6ea5b645b34335874be3",
      "path": "packages/operator-core/lib/dbos/periodic-workflows.ts",
      "gitBlob": "96b14c61b3a4a2970182ff2128c093897a7e33ad",
      "sha256": "647548cef3db6769619c9d987548396a2ac869eed16722164982b727b18e94f2",
      "bytes": 135568,
      "containsCacheL2ExpirySweepTick": true,
      "sweepLines": [
        "async function cacheL2ExpirySweepTick(): Promise<void> {",
        "      const removed = await new PgL2Store().sweepExpired(CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE);",
        "const cacheL2ExpirySweepWorkflow = idempotentRegisterWorkflow('cacheL2ExpirySweep', () =>",
        "  DBOS.registerWorkflow(cacheL2ExpirySweepTick, {",
        "    name: 'cacheL2ExpirySweep',",
        "DBOS.registerScheduled(cacheL2ExpirySweepWorkflow, { name: 'cacheL2ExpirySweep', crontab: '0 1-59/5 * * * *' });",
        "      const { sweepExpiredChatBrainSessions } = await import('../agent-tools/operator/converse-session');",
        "      const r = sweepExpiredChatBrainSessions();"
      ]
    },
    {
      "ref": "84bceb17588933bb2abb6ea5b645b34335874be3",
      "path": "packages/operator-core/lib/cache/pg-l2-store.ts",
      "gitBlob": "ac2006c89af72b55beceb89a29ab4135ab7f8d4b",
      "sha256": "5a7489013e9dc9447c793851ecdda239680164a4f334c51a7ddb0f18fbde2bc0",
      "bytes": 9535,
      "containsCacheL2ExpirySweepTick": false,
      "sweepLines": [
        " * `set` is a single upsert, `invalidateByTags` / `sweepExpired` are single",
        "   * data (sweeping is the separate `sweepExpired` concern). Single SELECT.",
        "  async sweepExpired(batchSize = CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE): Promise<number> {"
      ]
    }
  ],
  "introduction": {
    "sha": "84bceb17588933bb2abb6ea5b645b34335874be3",
    "metadata": "84bceb17588933bb2abb6ea5b645b34335874be3\n2026-11-06T17:29:08-05:00\n2026-11-06T17:29:08-05:00\nsync(operator-core): packages/operator-core (5 files, +213/-17) [skip ci]\n",
    "diff": "diff --git a/packages/operator-core/lib/dbos/periodic-workflows.ts b/packages/operator-core/lib/dbos/periodic-workflows.ts\nindex c751bad64c..96b14c61b3 100644\n--- a/packages/operator-core/lib/dbos/periodic-workflows.ts\n+++ b/packages/operator-core/lib/dbos/periodic-workflows.ts\n@@ -178,6 +178,29 @@ const scratchGcWorkflow = idempotentRegisterWorkflow('scratchGc', () =>\n );\n DBOS.registerScheduled(scratchGcWorkflow, { name: 'scratchGc', crontab: SCRATCH_GC_CRONTAB });\n \n+// Every five minutes at :01+: cache_l2 rows become read misses at expiry, but\n+// their JSONB values otherwise remain physically present. The daily filesystem\n+// scratch GC is retention-flagged and too infrequent for these short-lived rows;\n+// reuse this DBOS maintenance lane with a bounded database batch instead.\n+async function cacheL2ExpirySweepTick(): Promise<void> {\n+  await DBOS.runStep(async () => {\n+    try {\n+      const { PgL2Store, CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE } = await import('../cache/pg-l2-store');\n+      const removed = await new PgL2Store().sweepExpired(CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE);\n+      console.log(`[cache-l2-expiry-sweep] removed=${removed} batchLimit=${CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE}`);\n+    } catch (err) {\n+      console.warn(`[cache-l2-expiry-sweep] sweep failed (non-fatal): ${(err as Error).message}`);\n+    }\n+  }, { name: 'cache-l2-expiry-sweep' });\n+}\n+const cacheL2ExpirySweepWorkflow = idempotentRegisterWorkflow('cacheL2ExpirySweep', () =>\n+  DBOS.registerWorkflow(cacheL2ExpirySweepTick, {\n+    name: 'cacheL2ExpirySweep',\n+    maxRecoveryAttempts: 5,\n+  }),\n+);\n+DBOS.registerScheduled(cacheL2ExpirySweepWorkflow, { name: 'cacheL2ExpirySweep', crontab: '0 1-59/5 * * * *' });\n+\n // (The 6-hourly mem0 ephemeral-TTL sweep was removed — the `ephemeral` kind is\n // retired, so nothing carries expires_at; ephemeral state lives in coord now.\n // docs-and-memory-as-projections-2026-06-05 D-006.)\n",
    "historyCommand": "git log -2 -S cacheL2ExpirySweepTick -- packages/operator-core/lib/dbos/periodic-workflows.ts"
  },
  "reportedSnapshotSearch": {
    "command": "git grep -n -w sweepExpired d740fc3802 -- packages/operator-core/lib",
    "output": "d740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/cache/pg-l2-store.ts:16: * `set` is a single upsert, `invalidateByTags` / `sweepExpired` are single\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/cache/pg-l2-store.ts:102:   * data (sweeping is the separate `sweepExpired` concern). Single SELECT.\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/cache/pg-l2-store.ts:190:  async sweepExpired(): Promise<number> {\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/deferral-drop-owed.test.ts:100:    expect(buf.sweepExpired(5_000)).toBe(1);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/deferral-drop-owed.test.ts:110:    expect(buf.sweepExpired(60_000)).toBe(0);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/deferral-drop-owed.test.ts:117:    expect(buf.sweepExpired(60_000)).toBe(0);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/deferral-drop-owed.test.ts:118:    expect(buf.sweepExpired(60_999)).toBe(0);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/deferral-drop-owed.test.ts:119:    expect(buf.sweepExpired(61_000)).toBe(2);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/deferral-drop-owed.test.ts:163:    buf.sweepExpired(5_000);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/__tests__/feature-content-federation.integration.test.ts:1921:      expect(buffer.sweepExpired(Date.now() + DEFAULT_MEMBER_CONTENT_TTL_MS + 1)).toBe(1);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:127:  it('sweepExpired evicts at/after the deadline (kept while now < expiresAt)', () => {\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:130:    expect(buf.sweepExpired(999)).toBe(0); // still live before the deadline\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:132:    expect(buf.sweepExpired(1_000)).toBe(1); // evicted once now >= expiresAt\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:170:      expect(buf.sweepExpired(999)).toBe(0); // not yet expired\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:177:      // A later defer()'s internal sweepExpired(now) crosses the TTL for the ghost entry —\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:195:    it('an explicit sweepExpired() call (the drain-hot-path sweep) also trips the signal', () => {\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.test.ts:198:      expect(buf.sweepExpired(1_000)).toBe(1); // evicted at the deadline\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:130:  /** WI-3852 + D-016: every deferral `sweepExpired` or `evictOldest` drops, recorded under\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:186:    this.sweepExpired(now);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:218:    this.sweepExpired(now);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:261:    this.sweepExpired(now);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:281:    this.sweepExpired(now);\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:288:  sweepExpired(now: number): number {\nd740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/sync/hyperbee/pending-membership-content.ts:324:  /** Read and clear whether `sweepExpired`/`evictOldest` have dropped anything since the last\n",
    "scope": "literal symbol references in named committed library tree; unrelated Hyperbee sweep methods are not PgL2Store callers; no dynamic reflection or external caller absence asserted"
  },
  "findings": [
    "The source snapshot named by the original report lacks cacheL2ExpirySweep registration; the PgL2Store sweep method has no statically named caller in the searched library tree. This supports the report for that source snapshot.",
    "Commit84bceb175889 adds the workflow and schedule to a parent without them; its recorded commit time2026-11-06T22:29:08Z is later than original report17:54:01.075Z. Commit time is repository metadata, not loaded-runtime proof.",
    "Later positive sweep logs/DBOS SUCCESS in the saved completion support subsequent behavior, not falsification of the original source-time missing-caller report.",
    "Current source now uses the existing DBOS periodic lane and bounded sweep; no newly added durable system is needed."
  ],
  "disposition": "Original source premise supported at named snapshot; intervening source repair independently established. Later saved runtime success is reported but exact runtime/source identity remains unverified. Do not count original report as disproven or code-free no-action solely from later sweep success.",
  "remaining": [
    "Qualify original regression execution and scheduled-registration guard without rerunning tests; no tests were run this turn.",
    "Exact loaded runtime identity and raw saved log/workflow evidence remain unqualified here.",
    "This finding neither explains nor resolves the separate TOAST/MVCC item WI-6554700010045964."
  ],
  "constraints": [
    "No completed92/20pairs reassessment/requery.",
    "No fresh tests, controls, source edits, gate operations or peer monitoring.",
    "All12parent/12loop checks preserved; originalR1 staysOPEN."
  ]
}
