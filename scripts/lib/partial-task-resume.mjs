// Durable, fail-closed checkpoints for a task that reached the parent watchdog
// before its complete test-file set finished. This is deliberately separate from
// passing-task reuse: a partial run is never a pass proof and never enters the
// passing-verdict cache.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { selectReusablePasses } from "./test-pass-reuse.mjs";
import { expandSelectionCommands } from "./related-tests.mjs";

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
      !/^[a-f0-9]{64}$/.test(value.environmentDigest)) return false;
  return validNativeSpecifications(value.selectedSpecifications);
}

function validNativeSpecifications(specifications) {
  if (!Array.isArray(specifications) || !specifications.length) return false;
  const files = new Set();
  for (const spec of specifications) {
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

/** Select one native producer without treating pending npm hooks as test-selection
 * gaps. Hooks remain independent command obligations; this grants no pass or custody.
 * Ordered multi-run scripts still require distinct native output channels.
 */
export function preparePartialNativeProducerSelection(selection, task, root) {
  const refused = reason => ({ status: "refused", reason, selectedSpecifications: null });
  if (selection?.schemaVersion !== 1 || selection.kind !== "full-gate" ||
      selection.phase !== "selection-preparation" || selection.executed !== false ||
      !Array.isArray(selection.tasks) || selection.tasks.length !== 1 ||
      !Array.isArray(selection.unenumerated) || !Array.isArray(selection.commandObligations) ||
      !Array.isArray(selection.overlaps) || selection.overlaps.length)
    return refused("native-producer-selection-unmeasured");
  const entry = selection.tasks[0];
  if (!validIdentity(task?.id) || entry?.id !== task.id || entry.dir !== task.dir ||
      entry.command !== task.command || entry.runner !== "vitest" ||
      !validNativeSpecifications(entry.selectedSpecifications) ||
      !Array.isArray(entry.files) || new Set(entry.files).size !== entry.files.length ||
      entry.selectedSpecifications.length !== entry.files.length ||
      entry.selectedSpecifications.some(spec => !entry.files.includes(spec.testFile)) ||
      !isDeepStrictEqual(selection.files, entry.files))
    return refused("native-producer-selection-mismatch");
  const hooks = entry.lifecycleCommands;
  const commands = entry.commandObligations ?? [];
  if (!Array.isArray(hooks) || !Array.isArray(commands) || commands.length !== hooks.length ||
      selection.commandObligations.some(value => !value || typeof value !== "object") ||
      !isDeepStrictEqual(commands, selection.commandObligations.map(({ task: id, ...command }) =>
        id === task.id ? command : null)) ||
      selection.unenumerated.some(value => value?.task !== task.id ||
        value.reason !== "unexecuted-lifecycle-command") ||
      (selection.unenumerated.length > 0 && hooks.length === 0))
    return refused("native-producer-command-population-unmeasured");
  for (const [index, command] of commands.entries()) {
    const inputs = command?.inputs, discovery = command?.discovery;
    const files = discovery?.repositoryFiles ?? discovery?.files;
    if (command?.kind !== "npm-lifecycle" || command.executed !== false ||
        command.script !== hooks[index]?.script || command.command !== hooks[index]?.command ||
        !validIdentity(command.script) || !validIdentity(command.command) ||
        !isAbsolute(root ?? "") || !Array.isArray(inputs) || !inputs.length ||
        new Set(inputs.map(input => input?.path)).size !== inputs.length ||
        inputs.some(input => !repoPath(input?.path) || !/^[a-f0-9]{64}$/.test(input.sha256)) ||
        discovery?.executed !== false || discovery.runtimeClosure !== "unmeasured" ||
        discovery.operationalAcceptance !== false || !isDeepStrictEqual(discovery.inputs, inputs) ||
        !Array.isArray(files) || new Set(files).size !== files.length ||
        files.some(file => !repoPath(file) || !inputs.some(input => input.path === file)))
      return refused("native-producer-command-inputs-unmeasured");
    try {
      if (inputs.some(input => createHash("sha256").update(readFileSync(resolve(root, input.path)))
        .digest("hex") !== input.sha256)) return refused("native-producer-command-inputs-changed");
    } catch { return refused("native-producer-command-inputs-unreadable"); }
  }
  return { status: "ready", reason: null, selectedSpecifications: structuredClone(entry.selectedSpecifications) };
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
  // A dead producer may contribute its acknowledged prefix, never a terminal
  // verdict. The host must establish dead custody and a later clean successor.
  // In particular onExit, failed terminal hooks and unknown/mixed tail fields
  // cannot be relabeled as an interrupted prefix.
  const terminalPassed = Number.isSafeInteger(native.finishedAtMs) && native.finishedAtMs >= native.startedAtMs &&
    native.reason === "passed" && native.unhandledErrorCount === 0 && native.modulePopulationMatched === true &&
    native.files.length === selectedPaths.size && native.gaps.length === 0;
  const interrupted = native.finishedAtMs === null && native.terminalHook === null && native.reason === null &&
    native.unhandledErrorCount === null && native.modulePopulationMatched === false &&
    native.gaps.length === 0 && native.files.length > 0;
  if (options.requireTerminal === true && !terminalPassed && !(options.allowInterrupted === true && interrupted))
    return refused("native-terminal-verdict-unmeasured");
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
    const runClean = interrupted || terminalPassed;
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
    terminal: terminalPassed ? "passed" : interrupted ? "interrupted" : "unmeasured",
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
 * Freeze the qualification population from the maintained selector and its original
 * task inventory, before any outcome is observed. Command guards remain obligations
 * even when they have no native test files. Post-suite selection is mandatory and
 * supplied independently by the gate; observed post-suite results cannot define it.
 * This is preparation only: it neither enrolls a producer nor authorizes execution.
 * @param {{tasks: any, selection: any, postSuite: any, exclusions?: any[], root?: string}} input
 */
export function preparePartialContinuationManifest({ tasks, selection, postSuite, exclusions = [], root }) {
  const refused = reason => ({ status: "refused", reason, manifest: null, operationalAcceptance: false });
  if (!Array.isArray(tasks) || !tasks.length || selection?.schemaVersion !== 1 ||
      selection.kind !== "full-gate" || selection.phase !== "selection-preparation" ||
      selection.executed !== false || !Array.isArray(selection.tasks) ||
      !Array.isArray(selection.unenumerated) || !Array.isArray(selection.commandObligations) ||
      [...selection.unenumerated, ...selection.commandObligations].some(value => !validIdentity(value?.task)))
    return refused("task-population-unmeasured");
  if (postSuite?.schemaVersion !== 1 || postSuite.coverage !== "complete" ||
      !Array.isArray(postSuite.units) || !postSuite.units.length)
    return refused("post-suite-population-unmeasured");
  const units = [], ids = new Set(), testPaths = new Set(), entries = new Map();
  for (const entry of selection.tasks) {
    if (!validIdentity(entry?.id) || entries.has(entry.id)) return refused("task-population-invalid");
    entries.set(entry.id, entry);
  }
  for (const task of tasks) {
    const id = task?.id;
    if (!validIdentity(id) || ids.has(id) || !validIdentity(task.command) ||
        typeof task.dir !== "string" || (task.dir !== "." && !repoPath(task.dir)))
      return refused("task-population-invalid");
    ids.add(id);
    const entry = entries.get(id);
    if (entry && (entry.command !== task.command || entry.dir !== task.dir))
      return refused("task-selection-mismatch");
    if (task.isInvariantGuard === true) {
      units.push({ id: `guard:${id}`, kind: "guard",
        path: task.dir === "." ? "package.json" : `${task.dir}/package.json` });
      continue;
    }
    if (entry?.runner === "command-chain") {
      // Reconstruct the ordered inventory from the actual npm scripts before
      // trusting the prepared leaves. A file union cannot reveal an omitted or
      // reordered hook. Keep a separate whole-chain execution obligation too:
      // individual leaf passes do not prove that npm ran the original chain.
      if (!isAbsolute(root ?? "") || !Array.isArray(entry.steps) || entry.steps.length < 2 ||
          entry.steps.some(step => !step || !validIdentity(step.script) || !validIdentity(step.command) ||
            !Array.isArray(step.files) || !Array.isArray(step.commandObligations) || !Array.isArray(step.unenumerated)) ||
          !validIdentity(entry.script) || !validIdentity(entry.workspace) ||
          id !== `${entry.workspace} :: ${entry.script}`)
        return refused("chain-population-unmeasured");
      let sourceSteps;
      try {
        const scripts = JSON.parse(readFileSync(resolve(root, task.dir, "package.json"), "utf8")).scripts;
        if (scripts?.[entry.script] !== task.command) return refused("chain-source-changed");
        sourceSteps = expandSelectionCommands(scripts, entry.script);
      } catch { return refused("chain-source-unmeasured"); }
      if (!isDeepStrictEqual(sourceSteps, entry.steps.map(step => ({ script: step?.script,
          command: step?.command, ...(step?.lifecycle === true ? { lifecycle: true } : {}) }))))
        return refused("chain-population-mismatch");
      const chainCommands = entry.steps.flatMap((step, index) =>
        (Array.isArray(step.commandObligations) ? step.commandObligations : [])
          .map(command => ({ ...command, step: index })));
      const declared = selection.commandObligations.filter(value => value.task === id)
        .map(({ task: _task, ...value }) => value);
      // Leaf selector envelopes carry their local task id. The top-level
      // envelope replaces it with the original chain id.
      if (!isDeepStrictEqual(chainCommands, entry.commandObligations) ||
          !isDeepStrictEqual(chainCommands.map(({ task: _task, ...command }) => command), declared))
        return refused("command-population-mismatch");
      const chainFiles = [], chainResidues = [];
      const leafUnits = [];
      for (const [index, step] of entry.steps.entries()) {
        if (!Array.isArray(step.files) || !Array.isArray(step.commandObligations) ||
            !Array.isArray(step.unenumerated)) return refused("chain-population-unmeasured");
        const leafId = `${id}:step:${index}`;
        let leaf;
        if (step.lifecycle === true) {
          if (step.files.length || step.commandObligations.length !== 1 ||
              step.commandObligations[0]?.kind !== "npm-lifecycle")
            return refused("chain-population-mismatch");
          leaf = { runner: "lifecycle-command", files: [],
            lifecycleCommands: [{ script: step.script, command: step.command }] };
        } else {
          if (!Array.isArray(step.discovery) || step.discovery.length !== 1 ||
              step.discovery[0]?.runner === "command-chain" ||
              step.discovery[0]?.command !== step.command ||
              !isDeepStrictEqual(step.discovery[0]?.files, step.files))
            return refused("chain-population-mismatch");
          leaf = step.discovery[0];
        }
        const commands = step.commandObligations.map(({ task: _task, ...command }) => command);
        if (!step.lifecycle && !isDeepStrictEqual(commands, leaf.commandObligations ?? []))
          return refused("command-population-mismatch");
        const residues = step.unenumerated.map(({ task: _task, ...value }) => value);
        chainResidues.push(...residues.map(value => ({ task: id, step: index,
          command: step.command, reason: value.reason })));
        const prepared = preparePartialContinuationManifest({ root, postSuite,
          tasks: [{ id: leafId, dir: task.dir, command: step.command }], selection: {
            schemaVersion: 1, kind: "full-gate", phase: "selection-preparation", executed: false,
            tasks: [{ ...leaf, id: leafId, dir: task.dir, command: step.command, commandObligations: commands }],
            commandObligations: commands.map(command => ({ ...command, task: leafId })),
            unenumerated: residues.map(value => ({ ...value, task: leafId })),
          } });
        if (prepared.status !== "ready") return refused(prepared.reason);
        leafUnits.push(...prepared.manifest.units.filter(unit => unit.kind !== "post-suite"));
        chainFiles.push(...step.files);
      }
      if (!Array.isArray(entry.files) ||
          !isDeepStrictEqual([...new Set(chainFiles)].sort(), entry.files.slice().sort()) ||
          !isDeepStrictEqual(chainResidues, selection.unenumerated.filter(value => value.task === id)))
        return refused("chain-population-mismatch");
      for (const unit of leafUnits) {
        if (unit.kind === "test") {
          if (testPaths.has(unit.path)) return refused("test-population-overlapping-or-invalid");
          testPaths.add(unit.path);
        }
        units.push(unit);
      }
      units.push({ id: `chain:${id}`, kind: "guard",
        path: task.dir === "." ? "package.json" : `${task.dir}/package.json` });
      continue;
    }
    if (!entry || !Array.isArray(entry.files) || (!entry.files.length &&
        !["command-check", "lifecycle-command"].includes(entry.runner)) ||
        !["vitest", "node-test", "astro-check", "command-check", "lifecycle-command"].includes(entry.runner) ||
        entry.files.some(file => !repoPath(file)) || new Set(entry.files).size !== entry.files.length)
      return refused("task-selection-unmeasured");
    // Discovery is not execution. Keep each explicit command as a separate required
    // guard, including lifecycle hooks around a native test task. Unknown commands,
    // missing input censuses and discovery that moved since selection still refuse.
    const commands = entry.commandObligations ?? [];
    if (!Array.isArray(commands) || commands.some(command => !command || typeof command !== "object"))
      return refused("command-population-invalid");
    const declared = selection.commandObligations.filter(value => value.task === id)
      .map(({ task: _task, ...value }) => value);
    if (!isDeepStrictEqual(commands, declared)) return refused("command-population-mismatch");
    const residues = selection.unenumerated.filter(value => value.task === id);
    if (residues.some(value =>
      !(value.reason === "unexecuted-command-obligations" && commands.some(command => command.kind === "command-check")) &&
      !(value.reason === "unexecuted-lifecycle-command" && commands.some(command => command.kind === "npm-lifecycle"))))
      return refused("task-selection-unmeasured");
    if (["astro-check", "command-check"].includes(entry.runner) &&
        !commands.some(command => command.kind === "command-check")) return refused("command-population-unmeasured");
    if (entry.runner === "lifecycle-command" && (commands.length !== 1 ||
        commands[0]?.kind !== "npm-lifecycle" || commands[0]?.command !== task.command))
      return refused("command-population-unmeasured");
    if (entry.lifecycleCommands !== undefined && (!Array.isArray(entry.lifecycleCommands) ||
        entry.lifecycleCommands.some(step => !step || commands.filter(command => command.kind === "npm-lifecycle" &&
          command.script === step.script && command.command === step.command).length !== 1)))
      return refused("command-population-unmeasured");
    for (const [index, command] of commands.entries()) {
      const discovery = command?.discovery;
      const discoveryFiles = discovery?.repositoryFiles ?? discovery?.files;
      if (!["command-check", "npm-lifecycle"].includes(command?.kind) || !validIdentity(command.command) ||
          command.executed !== false || !isAbsolute(root ?? "") ||
          !Array.isArray(command.inputs) || !command.inputs.length ||
          new Set(command.inputs.map(input => input?.path)).size !== command.inputs.length ||
          command.inputs.some(input => !repoPath(input?.path) || !/^[a-f0-9]{64}$/.test(input.sha256)) ||
          discovery?.executed !== false || discovery.runtimeClosure !== "unmeasured" ||
          discovery.operationalAcceptance !== false || !isDeepStrictEqual(discovery.inputs, command.inputs) ||
          !Array.isArray(discoveryFiles) || discoveryFiles.some(file => !repoPath(file)) ||
          new Set(discoveryFiles).size !== discoveryFiles.length ||
          discoveryFiles.some(file => !command.inputs.some(input => input.path === file)) ||
          (discovery.files !== undefined && discovery.repositoryFiles !== undefined &&
            !isDeepStrictEqual(discovery.files, discovery.repositoryFiles)))
        return refused("command-inputs-unmeasured");
      if (command.kind === "command-check" &&
          (command.command !== (entry.resolvedCommand ?? entry.command) ||
          !isDeepStrictEqual([...discoveryFiles].sort(), [...entry.files].sort())))
        return refused("command-selection-mismatch");
      if (command.kind === "npm-lifecycle" && (!Array.isArray(entry.lifecycleCommands) ||
          !entry.lifecycleCommands.some(step => step.script === command.script && step.command === command.command)))
        return refused("command-selection-mismatch");
      try {
        if (command.inputs.some(input => createHash("sha256").update(readFileSync(resolve(root, input.path)))
          .digest("hex") !== input.sha256)) return refused("command-inputs-changed");
      } catch { return refused("command-inputs-unreadable"); }
      units.push({ id: `command:${id}:${index}`, kind: "guard",
        path: task.dir === "." ? "package.json" : `${task.dir}/package.json` });
    }
    if (entry.runner === "vitest" && (!validNativeSpecifications(entry.selectedSpecifications) ||
        entry.selectedSpecifications.length !== entry.files.length ||
        new Set(entry.selectedSpecifications.map(value => value?.testFile)).size !== entry.files.length ||
        entry.selectedSpecifications.some(value => !entry.files.includes(value?.testFile))))
      return refused("native-specifications-unmeasured");
    // Astro's file census names check inputs. It must never become a population
    // of native tests or overlap a Vitest task that executes those same sources.
    for (const file of entry.runner === "astro-check" ? [] : entry.files) {
      if (!repoPath(file) || testPaths.has(file)) return refused("test-population-overlapping-or-invalid");
      testPaths.add(file);
      units.push({ id: `test:${file}`, kind: "test", path: file });
    }
  }
  if ([...entries.keys(), ...selection.unenumerated.map(value => value.task),
    ...selection.commandObligations.map(value => value.task)].some(id => !ids.has(id)))
    return refused("foreign-task-selection");
  for (const unit of postSuite.units) {
    if (!validIdentity(unit?.id) || !repoPath(unit.path) || unit.kind !== "post-suite" ||
        unit.exclusion !== undefined) return refused("post-suite-population-invalid");
    units.push({ id: unit.id, kind: "post-suite", path: unit.path });
  }
  if (!Array.isArray(exclusions)) return refused("exclusion-population-invalid");
  const excluded = new Set();
  for (const exclusion of exclusions) {
    const unit = units.find(value => value.id === exclusion?.unitId);
    if (!unit || excluded.has(unit.id) || !validIdentity(exclusion.reason) || !validIdentity(exclusion.policyRef))
      return refused("exclusion-population-invalid");
    excluded.add(unit.id);
    unit.exclusion = { reason: exclusion.reason, policyRef: exclusion.policyRef };
  }
  const manifest = continuationManifest({ schemaVersion: 1, units });
  if (!manifest) return refused("manifest-population-invalid");
  return { status: "ready", reason: null, manifest: { schemaVersion: 1, units: manifest }, operationalAcceptance: false };
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

/** Project eligible work onto the ORIGINAL task inventory. Rebuild the full manifest
 * before narrowing; neither saved outcomes nor the narrowed native producer selects
 * the required population. Atomic commands are never split into synthetic leaf runs.
 * This grants no custody, records no completion and cannot establish a green verdict.
 */
export function preparePartialRemainingSelection(checkpoint, expected, { selection, postSuite }, options = {}) {
  const refused = reason => ({ status: "refused", reason, tasks: [], omitted: [], evaluation: null });
  const prepared = preparePartialContinuationManifest({ root: expected.root,
    tasks: selection?.taskInventory, selection, postSuite,
    exclusions: expected.manifest?.units?.filter(unit => unit.exclusion)
      .map(unit => ({ unitId: unit.id, ...unit.exclusion })) });
  if (prepared.status !== "ready") return refused(`selection-${prepared.reason}`);
  if (!isDeepStrictEqual(prepared.manifest, expected.manifest)) return refused("selection-manifest-mismatch");
  const evaluation = evaluatePartialTaskContinuation(checkpoint, expected, options);
  if (evaluation.status !== "ready") return refused(`eligibility-${evaluation.reason}`);
  const run = new Set(evaluation.run);
  if ([...evaluation.retainedFailures, ...evaluation.infrastructure].some(id => !run.has(id)))
    return refused("retained-terminal-outcome");
  const tasks = [], omitted = [];
  for (const task of selection.taskInventory) {
    const entry = selection.tasks.find(entry => entry.id === task.id);
    const part = preparePartialContinuationManifest({ root: expected.root, tasks: [task], postSuite,
      selection: { ...selection, tasks: entry ? [entry] : [],
        unenumerated: selection.unenumerated.filter(row => row.task === task.id),
        commandObligations: selection.commandObligations.filter(row => row.task === task.id) } });
    if (part.status !== "ready") return refused(`task-${part.reason}`);
    const units = part.manifest.units.filter(unit => unit.kind !== "post-suite");
    const remaining = units.filter(unit => run.has(unit.id));
    if (!remaining.length) { omitted.push(task.id); continue; }
    if (entry?.runner === "vitest") {
      // npm hooks are inseparable from the original npm invocation. Never replay
      // a banked hook just to get to another file, or silently drop an owed hook.
      if (units.some(unit => unit.kind !== "test" && !run.has(unit.id)))
        return refused("atomic-command-partially-complete");
      const files = entry.files.filter(file => run.has(`test:${file}`));
      if (!files.length) return refused("native-empty-selection-with-command-work");
      const selectedSpecifications = entry.selectedSpecifications.filter(spec => files.includes(spec.testFile));
      tasks.push({ ...structuredClone(entry), files, selectedSpecifications });
    } else {
      if (remaining.length !== units.length) return refused("atomic-task-partially-complete");
      tasks.push(structuredClone(entry ?? { ...task, files: [] }));
    }
  }
  return { status: "ready", reason: null, tasks, omitted, evaluation };
}
