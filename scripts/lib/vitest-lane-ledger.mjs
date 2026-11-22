import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { affectedTestRunLogPath } from "@papercusp/test-config/hermetic-tmpdir";

function readEvidence(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function settleShardLedger({ directory, env, reporter, argv, code, shard, wsAbsDir, log }) {
  const manifestFile = env[reporter.TEST_RUN_SHARD_MANIFEST_ENV];
  const receiptFile = env[reporter.TEST_RUN_RECOVERY_ENV];
  const runGroupId = env.PAPERCUSP_TEST_RUN_GROUP;
  const auditFile = join(directory, `${shard}.ledger.json`);
  let audit = { runGroupId, shard, argv, exitStatus: code, manifestFile, receiptFile, state: "incomplete" };
  try {
    const manifest = JSON.parse(readEvidence(manifestFile) || "null");
    if (manifest?.version !== 1 || manifest.runGroupId !== runGroupId || !isAbsolute(manifest.root ?? "")
      || !Array.isArray(manifest.selected) || !manifest.selected.every(path => typeof path === "string")) {
      throw new Error("shard selection was not recorded");
    }
    const workspace = relative(manifest.root, wsAbsDir);
    if (isAbsolute(workspace) || workspace === ".." || workspace.startsWith(`..${sep}`)) {
      throw new Error("shard selection belongs to another checkout");
    }
    const expected = manifest.selected;
    const terminal = new Set((manifest.outcomes ?? []).filter(({ state }) =>
      state === "passed" || state === "failed" || state === "skipped").map(({ path }) => path));
    const missingOutcomes = expected.filter(path => !terminal.has(path));
    let receipts = readEvidence(receiptFile);
    const pending = reporter.pendingTestRunRecoveryPaths(receipts, expected, manifest.root);
    const batchSize = reporter.TEST_RUN_INSERT_BATCH_SIZE;
    for (let offset = 0; receipts && offset < pending.length; offset += batchSize) {
      await reporter.reconcileTimedOutTestRunReceipts(receipts, {
        expectedPaths: pending.slice(offset, offset + batchSize), expectedRoot: manifest.root, runGroupId, env,
      });
    }
    if (pending.length > 0) receipts = readEvidence(receiptFile);
    const missingFiles = reporter.missingTestRunReceiptPaths(receipts, expected, manifest.root);
    const missingFileSet = new Set(missingFiles);
    const missingCases = reporter.pendingTestRunRecoveryPaths(receipts, expected, manifest.root)
      .filter(path => !missingFileSet.has(path));
    const complete = ["passed", "failed"].includes(manifest.reason) && Array.isArray(manifest.outcomes)
      && missingOutcomes.length === 0 && missingFiles.length === 0 && missingCases.length === 0;
    audit = { ...audit, state: complete ? "complete" : "incomplete", root: manifest.root, expected: expected.length,
      missingOutcomes, missingFiles, missingCases,
      ...(complete ? { receiptFile: null, ledgerRows: reporter.latestTestRunReceipts(receipts)
        .filter(receipt => receipt.outcome === "inserted").map(({ filePath, id }) => ({ filePath, id })) } : {}) };
  } catch (error) {
    audit = { ...audit, error: error.message };
  }
  try {
    writeFileSync(auditFile, JSON.stringify(audit), { mode: 0o600 });
  } catch (error) {
    audit = { ...audit, state: "incomplete", error: error.message };
  }
  if (audit.state === "complete") {
    try { rmSync(receiptFile, { force: true }); } catch { /* Keep the evidence if cleanup fails. */ }
  }
  log({ shard, state: audit.state, exitStatus: code, expected: audit.expected,
    missingFiles: audit.missingFiles?.length, missingCases: audit.missingCases?.length,
    missingOutcomes: audit.missingOutcomes?.length, auditFile, manifestFile, receiptFile: audit.receiptFile, error: audit.error });
  return audit.state === "complete";
}

export async function openVitestLaneLedger({ lane, env, wsAbsDir, stderr }) {
  const passthrough = complete => ({ envForShard: () => env, settle: async () => complete });
  // Strict receipt consumers own their proof files. Ordinary CI capture must
  // leave the child's existing write budget in place.
  if (env.PAPERCUSP_TEST_RUN_SOURCE !== "ci" || !env.PAPERCUSP_TEST_RUN_GROUP?.trim()
    || env.PAPERCUSP_TEST_RUN_RECEIPT_FILE?.trim()) return passthrough(true);

  const log = details => stderr.write(`VITEST_${lane.toUpperCase()}_LANE_LEDGER ${JSON.stringify(details)}\n`);
  try {
    const reporter = await import("@papercusp/test-config/admin-test-runs-reporter");
    const directory = mkdtempSync(join(dirname(affectedTestRunLogPath(`${process.pid}-0`)), `${lane}-ledger-`));
    return {
      envForShard: shard => ({ ...env,
        [reporter.TEST_RUN_SHARD_MANIFEST_ENV]: join(directory, `${shard}.native.json`),
        [reporter.TEST_RUN_RECOVERY_ENV]: join(directory, `${shard}.receipts.jsonl`),
      }),
      settle: run => settleShardLedger({ ...run, directory, reporter, wsAbsDir, log }),
    };
  } catch (error) {
    log({ state: "incomplete", error: error.message });
    return passthrough(false);
  }
}
