// Durable, fail-closed checkpoints for a task that reached the parent watchdog
// before its complete test-file set finished. This is deliberately separate from
// passing-task reuse: a partial run is never a pass proof and never enters the
// passing-verdict cache.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { selectReusablePasses } from "./test-pass-reuse.mjs";

export const PARTIAL_TASK_CHECKPOINT_SCHEMA = 1;
export const PARTIAL_TASK_SKIP_LIST_SCHEMA = 1;

const normalizePath = (value, cwd) => {
  if (typeof value !== "string") return null;
  let file = value.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!file) return null;
  if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) {
    file = file.slice(1, -1);
  }
  const absolute = isAbsolute(file) ? file : resolve(cwd, file);
  const rel = relative(cwd, absolute).split(/[/\\]/).join("/").replace(/^\.\//, "");
  if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return null;
  return rel;
};

export function normalizePartialFiles(files, cwd) {
  return [...new Set((files ?? []).map((file) => normalizePath(file, cwd)).filter(Boolean))].sort();
}

function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function validFileList(files) {
  return Array.isArray(files) && files.every((file) => typeof file === "string" && file.length > 0);
}

export function partialTaskCheckpointPath(cacheDir, root, taskKey) {
  const scope = createHash("sha256").update(`${root}\0${taskKey}`).digest("hex").slice(0, 24);
  return `${cacheDir}/papercusp-affected-partial-v${PARTIAL_TASK_CHECKPOINT_SCHEMA}-${scope}.json`;
}

export function readPartialTaskCheckpoint(file, expected) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || parsed.schemaVersion !== PARTIAL_TASK_CHECKPOINT_SCHEMA) return null;
  if (parsed.continuation !== undefined) {
    const { checkpointIntegrity, ...body } = parsed;
    if (checkpointIntegrity?.schemaVersion !== 1 ||
        checkpointIntegrity.sha256 !== createHash("sha256").update(JSON.stringify(body)).digest("hex")) return null;
  }
  if (!validIdentity(parsed.root) || !validIdentity(parsed.taskKey) ||
      !validIdentity(parsed.sourceCommit) || !validIdentity(parsed.sourceDigest)) return null;
  if (!validFileList(parsed.selectedFiles) || !validFileList(parsed.passedFiles)) return null;
  if (parsed.state !== "partial" && parsed.state !== "complete") return null;
  if (expected && (parsed.root !== expected.root || parsed.taskKey !== expected.taskKey ||
      parsed.sourceCommit !== expected.sourceCommit || parsed.sourceDigest !== expected.sourceDigest)) {
    return null;
  }
  const selectedFiles = [...new Set(parsed.selectedFiles)].sort();
  const selected = new Set(selectedFiles);
  const passedFiles = [...new Set(parsed.passedFiles)].filter((file) => selected.has(file)).sort();
  return { ...parsed, selectedFiles, passedFiles };
}

export function writePartialTaskCheckpointAtomic(file, checkpoint) {
  const value = {
    schemaVersion: PARTIAL_TASK_CHECKPOINT_SCHEMA,
    root: checkpoint.root,
    taskKey: checkpoint.taskKey,
    sourceCommit: checkpoint.sourceCommit,
    sourceDigest: checkpoint.sourceDigest,
    selectedFiles: [...new Set(checkpoint.selectedFiles ?? [])].sort(),
    passedFiles: [...new Set(checkpoint.passedFiles ?? [])].sort(),
    state: checkpoint.state === "complete" ? "complete" : "partial",
    updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
    ...(checkpoint.continuation === undefined ? {} : { continuation: checkpoint.continuation }),
  };
  if (checkpoint.continuation !== undefined) {
    value.checkpointIntegrity = { schemaVersion: 1,
      sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
  }
  const body = JSON.stringify(value);
  mkdirSync(file.replace(/\/[^/]*$/, ""), { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temp, `${body}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function partialTaskSkipListPath(dir, checkpoint) {
  const body = JSON.stringify({
    schema: PARTIAL_TASK_SKIP_LIST_SCHEMA,
    taskKey: checkpoint.taskKey,
    sourceCommit: checkpoint.sourceCommit,
    sourceDigest: checkpoint.sourceDigest,
    files: [...new Set(checkpoint.passedFiles ?? [])].sort(),
  });
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/partial-skip-${digest}.json`;
  try {
    writeFileSync(file, `${body}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return { path: file, digest, count: checkpoint.passedFiles?.length ?? 0 };
}

const UNIT_KINDS = new Set(["test", "guard", "post-suite"]);
const repoPath = value => typeof value === "string" && value.length > 0 &&
  !isAbsolute(value) && !value.includes("\\") &&
  value.split("/").every(part => part !== "" && part !== "." && part !== "..");

function validNativeProducer(value) {
  if (value?.schemaVersion !== 1 || value.kind !== "qualification-native-producer" ||
      ![value.attemptId, value.runGroupId, value.root, value.taskKey, value.workspaceName,
        value.sourceCommit, value.outPath].every(validIdentity) || !isAbsolute(value.root) || !isAbsolute(value.outPath) ||
      !Number.isSafeInteger(value.registeredAtMs) || value.registeredAtMs <= 0 ||
      !isAbsolute(value.command?.cwd ?? "") || !validIdentity(value.command?.cmd) ||
      !Array.isArray(value.command?.argv) || !value.command.argv.every(arg => typeof arg === "string") ||
      !/^[a-f0-9]{64}$/.test(value.environmentDigest) ||
      !Array.isArray(value.selectedSpecifications) || !value.selectedSpecifications.length) return false;
  const files = new Set();
  for (const spec of value.selectedSpecifications) {
    if (!repoPath(spec?.testFile) || files.has(spec.testFile) || !validIdentity(spec.pool) ||
        (spec.projectName !== null && typeof spec.projectName !== "string") ||
        (spec.testNamePattern !== null && typeof spec.testNamePattern !== "string") ||
        ![spec.testIds, spec.testTagsFilter].every(list => list === null ||
          (Array.isArray(list) && list.every(item => typeof item === "string"))) ||
        !(spec.testLines === null || (Array.isArray(spec.testLines) && spec.testLines.every(Number.isSafeInteger)))) return false;
    files.add(spec.testFile);
  }
  return true;
}

/** Enroll the independent selection and actual command before its native child can start.
 * Extends the existing OUT artifact; the environment is stored only as a digest.
 * Enrollment is immutable and does not authorize reuse or establish runner custody.
 */
export function registerPartialNativeProducer(outPath, registration, environment) {
  const value = { schemaVersion: 1, kind: "qualification-native-producer", ...registration, outPath,
    environmentDigest: createHash("sha256").update(JSON.stringify(Object.entries(environment)
      .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
  if (!validNativeProducer(value)) throw new Error("native-producer-registration-invalid");
  const body = JSON.stringify(value);
  const path = `${outPath}.producer.json`;
  const sealed = JSON.stringify({ ...value, integrity: { schemaVersion: 1,
    sha256: createHash("sha256").update(body).digest("hex") } });
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${sealed}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // Unlike rename, link cannot replace another producer's enrollment.
    linkSync(temp, path);
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
    return { path, producer: value };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* a failed open created no temporary file */ }
  }
}

export function readPartialNativeProducer(path, expected) {
  try {
    const { integrity, ...value } = JSON.parse(readFileSync(path, "utf8"));
    if (!validNativeProducer(value) || integrity?.schemaVersion !== 1 ||
        integrity.sha256 !== createHash("sha256").update(JSON.stringify(value)).digest("hex")) return null;
    for (const key of ["attemptId", "runGroupId", "root", "taskKey", "workspaceName", "sourceCommit", "outPath", "environmentDigest"])
      if (expected?.[key] !== undefined && value[key] !== expected[key]) return null;
    if (expected?.command !== undefined && !isDeepStrictEqual(value.command, expected.command)) return null;
    return value;
  } catch { return null; }
}

/**
 * Read the reporter's existing atomic OUT channel, including a snapshot written before
 * onTestRunEnd. Selection comes from the caller, never from the observed result sample.
 * classifyReadPaths is the reporter's maintained tracked/untracked-input classifier;
 * absent classification keeps the outcome but cannot establish a reusable pass.
 */
export function readPartialNativeCompletion(file, expected, options = {}) {
  const refused = reason => ({ status: "refused", reason, receipts: [] });
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(file, "utf8")); }
  catch { return refused("snapshot-unreadable"); }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return refused("snapshot-invalid");
  const { completionIntegrity, ...body } = snapshot;
  if (completionIntegrity?.schemaVersion !== 1 ||
      completionIntegrity.sha256 !== createHash("sha256").update(JSON.stringify(body)).digest("hex"))
    return refused("snapshot-integrity-invalid");
  const context = snapshot.completionCheckpoint, native = snapshot.nativeRun;
  if (!validIdentity(expected?.attemptId) || context?.schemaVersion !== 1 ||
      context.qualificationAttemptId !== expected.attemptId ||
      snapshot.workspaceName !== expected.workspaceName || !validIdentity(expected.root) ||
      !validIdentity(snapshot.recordedSha) || !validIdentity(context.runContext) || !validIdentity(context.runnerIdentity))
    return refused("snapshot-identity-mismatch");
  if (expected.producerPath !== undefined) {
    const producer = readPartialNativeProducer(expected.producerPath, { ...expected,
      outPath: file, runGroupId: context.runGroupId, sourceCommit: snapshot.recordedSha });
    if (!producer || !Number.isSafeInteger(native?.startedAtMs) || native.startedAtMs < producer.registeredAtMs ||
        !isDeepStrictEqual(producer.selectedSpecifications, expected.selectedSpecifications))
      return refused("native-producer-mismatch");
  }
  if (native?.schemaVersion !== "native-vitest-run-v1" || !Array.isArray(native.files) ||
      !Array.isArray(native.gaps) || !Array.isArray(snapshot.rows)) return refused("native-population-unmeasured");
  const specifications = expected.selectedSpecifications;
  if (!Array.isArray(specifications) || !specifications.length ||
      !Array.isArray(native.selectedManifest?.specifications)) return refused("native-selection-unmeasured");
  const canonical = values => JSON.stringify([...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  // JSONB may reorder object keys in the independently frozen selection. Compare
  // values structurally, but check the native digest in its writer's own format.
  const byFile = values => [...values].sort((a, b) => String(a?.testFile).localeCompare(String(b?.testFile)));
  if (!isDeepStrictEqual(byFile(specifications), byFile(native.selectedManifest.specifications)) ||
      native.selectedManifest.sha256 !== createHash("sha256").update(canonical(native.selectedManifest.specifications)).digest("hex"))
    return refused("native-selection-mismatch");
  const units = continuationManifest(expected.manifest);
  if (!units) return refused("manifest-mismatch");
  const byPath = new Map();
  for (const unit of units.filter(unit => unit.kind === "test" && !unit.exclusion)) {
    if (byPath.has(unit.path)) return refused("ambiguous-test-path");
    byPath.set(unit.path, unit);
  }
  const selectedPaths = new Set();
  for (const spec of specifications) {
    if (!repoPath(spec?.testFile) || selectedPaths.has(spec.testFile) || !byPath.has(spec.testFile))
      return refused("native-selection-invalid");
    selectedPaths.add(spec.testFile);
  }
  const rows = new Map();
  for (const row of snapshot.rows) {
    if (!selectedPaths.has(row?.testFile) || rows.has(row.testFile)) return refused("native-proof-population-invalid");
    rows.set(row.testFile, row);
  }
  const seenFiles = new Set(), seenCompletions = new Set(), receipts = [];
  for (const file of native.files) {
    if (!selectedPaths.has(file?.testFile) || seenFiles.has(file.testFile) ||
        !validIdentity(file.completionId) || seenCompletions.has(file.completionId) ||
        !Number.isSafeInteger(file.observedAtMs) || file.observedAtMs <= 0 ||
        !["passed", "failed", "skipped", "pending", "error"].includes(file.state))
      return refused("native-receipt-population-invalid");
    seenFiles.add(file.testFile);
    seenCompletions.add(file.completionId);
    const row = rows.get(file.testFile);
    let classified;
    try { if (row) classified = options.classifyReadPaths?.(row.readPaths, expected.root); }
    catch { /* An unavailable tracked-input census never authorizes reuse. */ }
    const inputMeasured = Array.isArray(classified?.readPaths) && classified.readPaths.every(repoPath) &&
      Array.isArray(classified?.opaqueReasons) && classified.opaqueReasons.every(reason => typeof reason === "string");
    const source = file.proof?.sourceEvidence;
    const cleanSource = source?.schemaVersion === "vite-collected-source-evidence-v1" &&
      source.status === "stable" && Array.isArray(source.sources) && source.sources.length > 0 &&
      source.sources.every(value => repoPath(value.path) && /^[a-f0-9]{64}$/.test(value.sha256) && value.sha256 === value.currentSha256) &&
      Array.isArray(source.reasons) && source.reasons.length === 0;
    const cases = file.cases;
    const measuredCases = Array.isArray(cases) && cases.length > 0 && cases.every(value => value.status === "pass");
    const runClean = native.gaps.length === 0 && (native.finishedAtMs === null ||
      (native.reason === "passed" && native.unhandledErrorCount === 0 && native.modulePopulationMatched === true));
    const opaqueReasons = Array.isArray(row?.opaqueReasons) ? [...row.opaqueReasons] : ["proof-unmeasured"];
    if (!inputMeasured) opaqueReasons.push("input-classification-unmeasured");
    else opaqueReasons.push(...classified.opaqueReasons);
    if (!cleanSource) opaqueReasons.push("native-source-unmeasured");
    if (!measuredCases) opaqueReasons.push("native-cases-incomplete");
    if (!runClean) opaqueReasons.push("native-run-incomplete-or-errored");
    if (snapshot.configSources?.status !== "unchanged") opaqueReasons.push("config-source-unmeasured");
    const executedModules = row?.executedModules;
    if (!Array.isArray(executedModules) || !executedModules.length || !executedModules.every(repoPath))
      opaqueReasons.push("execution-closure-unmeasured");
    receipts.push({ unitId: byPath.get(file.testFile).id, completionId: file.completionId,
      observedAtMs: file.observedAtMs, state: file.state === "passed" ? "pass" : file.state === "failed" ? "fail" : "infra",
      worktreeDirty: snapshot.worktreeDirty !== false, firstAttemptVerdict: file.firstAttemptVerdict,
      observedCount: measuredCases ? cases.length : 0,
      proof: { recordedSha: snapshot.recordedSha, runContext: context.runContext,
        runnerIdentity: context.runnerIdentity, executedModules: executedModules ?? [],
        inputsCaptured: row?.inputsCaptured === true && inputMeasured,
        readPaths: inputMeasured ? classified.readPaths : [], opaqueReasons } });
  }
  return { status: "ready", reason: null, receipts, origin: {
    runGroupId: validIdentity(context.runGroupId) ? context.runGroupId : null,
    startedAtMs: Number.isSafeInteger(native.startedAtMs) && native.startedAtMs > 0 ? native.startedAtMs : null,
    sourceCommit: snapshot.recordedSha,
  } };
}

function continuationManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.units) || !manifest.units.length) return null;
  const seen = new Set();
  const units = [];
  for (const unit of manifest.units) {
    if (!validIdentity(unit?.id) || seen.has(unit.id) || !UNIT_KINDS.has(unit.kind) || !repoPath(unit.path)) return null;
    seen.add(unit.id);
    let exclusion;
    if (unit.exclusion !== undefined) {
      if (!validIdentity(unit.exclusion?.reason) || !validIdentity(unit.exclusion?.policyRef)) return null;
      exclusion = { reason: unit.exclusion.reason, policyRef: unit.exclusion.policyRef };
    }
    units.push({ id: unit.id, kind: unit.kind, path: unit.path, ...(exclusion ? { exclusion } : {}) });
  }
  return units.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Grade the existing checkpoint's full, independently selected population. The caller
 * must own the existing qualification runner before executing `run`; this pure read
 * neither acquires custody nor authorizes a stale runner to write a checkpoint.
 *
 * Native receipts are retained even when they cannot establish a reusable pass. Reuse
 * delegates to the maintained source/input/context/runner validator. A retained failure
 * is never silently retried: the qualification's explicit retry policy must admit it.
 */
export function evaluatePartialTaskContinuation(checkpoint, expected, options = {}) {
  const refused = reason => ({ status: "refused", reason, verdict: "incomplete", run: [], reused: [],
    excluded: [], retainedFailures: [], infrastructure: [], invalidated: [] });
  const stored = checkpoint?.continuation;
  if (stored?.schemaVersion !== 1) return refused("continuation-unmeasured");
  for (const key of ["attemptId", "candidate", "repairHead"]) {
    if ((key !== "repairHead" && !validIdentity(expected?.[key])) ||
        (key === "repairHead" && expected?.[key] !== null && !validIdentity(expected?.[key])) ||
        stored[key] !== expected[key]) return refused(`${key}-mismatch`);
  }
  if (checkpoint.root !== expected.root || checkpoint.taskKey !== expected.taskKey)
    return refused("task-identity-mismatch");
  if (![expected.sourceCommit, expected.runContext, expected.runnerIdentity].every(validIdentity))
    return refused("execution-identity-unmeasured");
  const units = continuationManifest(expected.manifest);
  const prior = continuationManifest(stored.manifest);
  if (!units || !prior || JSON.stringify(units) !== JSON.stringify(prior)) return refused("manifest-mismatch");
  if (!Array.isArray(stored.receipts)) return refused("receipts-unmeasured");
  const selected = new Map(units.map(unit => [unit.id, unit]));
  const receipts = new Map();
  const completionIds = new Set();
  for (const receipt of stored.receipts) {
    if (!selected.has(receipt?.unitId) || receipts.has(receipt.unitId) ||
        !validIdentity(receipt.completionId) || completionIds.has(receipt.completionId) ||
        !Number.isSafeInteger(receipt.observedAtMs) ||
        receipt.observedAtMs <= 0 || !["pass", "fail", "infra"].includes(receipt.state))
      return refused("receipt-population-invalid");
    receipts.set(receipt.unitId, receipt);
    completionIds.add(receipt.completionId);
  }
  const run = [], reused = [], excluded = [], retainedFailures = [], infrastructure = [], invalidated = [];
  if (expected.retryStates !== undefined && !Array.isArray(expected.retryStates)) return refused("retry-policy-invalid");
  const retries = new Set(expected.retryStates ?? []);
  if ([...retries].some(state => !["fail", "infra"].includes(state))) return refused("retry-policy-invalid");
  for (const unit of units) {
    if (unit.exclusion) { excluded.push(unit.id); continue; }
    const receipt = receipts.get(unit.id);
    if (!receipt) { run.push(unit.id); continue; }
    if (receipt.state !== "pass") {
      (receipt.state === "fail" ? retainedFailures : infrastructure).push(unit.id);
      if (retries.has(receipt.state)) run.push(unit.id);
      continue;
    }
    let selection;
    if (receipt.worktreeDirty === false && Number.isSafeInteger(receipt.observedCount) && receipt.observedCount > 0 &&
        (unit.kind !== "test" || receipt.firstAttemptVerdict === "pass")) {
      try {
        selection = selectReusablePasses({ ...options, auditRate: 0,
          candidates: [unit.path], proofs: new Map([[unit.path, receipt.proof]]),
          judgedSha: expected.sourceCommit, runContext: expected.runContext,
          runnerIdentity: expected.runnerIdentity });
      } catch { /* Missing drift/input evidence never permits a skip. */ }
    }
    if (selection?.skip.includes(unit.path)) reused.push(unit.id);
    else {
      run.push(unit.id);
      invalidated.push({ id: unit.id, reason: "pass-proof-invalid-or-unmeasured" });
    }
  }
  const required = units.length - excluded.length;
  const verdict = retainedFailures.length ? "red" :
    required > 0 && reused.length === required ? "green" : "incomplete";
  return { status: "ready", reason: null, verdict, run, reused, excluded,
    retainedFailures, infrastructure, invalidated,
    counts: { selected: units.length, required, excluded: excluded.length,
      passed: reused.length, failed: retainedFailures.length, infrastructure: infrastructure.length,
      pending: run.filter(id => !retainedFailures.includes(id) && !infrastructure.includes(id)).length } };
}
