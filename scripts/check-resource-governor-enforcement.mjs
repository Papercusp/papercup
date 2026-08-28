#!/usr/bin/env node
/**
 * Canonical capless resource-governor policy guard (P-012).
 *
 * This replaces capacity-limit linting. A numeric maximum is not proof that work
 * is safe; the proof is a governed admission/queue/state lifecycle. The inventory
 * is deliberately subsystem-complete and records the migration item that turns
 * each pending lane on. Once a lane is active, every resource start in its paths
 * must carry writer evidence in source.
 */
import { readFileSync } from "node:fs";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { listTrackedFiles } from "./lib/tracked-files.mjs";
import { stripCommentsAndStrings } from "./lib/strip-comments-and-strings.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

export const RESOURCE_GOVERNOR_INVENTORY = Object.freeze([
  inventory(
    "agent-process-memory",
    "P-013",
    [
      "packages/operator-core/lib/agent-",
      "packages/operator-core/lib/fleet/",
      "apps/operator/scripts/psu-",
    ],
    ["cpu", "memory", "process", "pty"],
    "active",
  ),
  inventory(
    "mcp-http-operator-transport",
    "P-014",
    [
      "packages/operator-core/lib/endpoint-",
      "packages/operator-core/lib/agent-tools/",
      "apps/operator/bin/",
    ],
    ["cpu", "memory", "socket", "process"],
    "active",
  ),
  inventory(
    "inference-embedding-provider-batching",
    "P-015",
    [
      "packages/operator-core/lib/inference-",
      "packages/operator-core/lib/memory/",
      "packages/operator-core/lib/llm-",
    ],
    ["cpu", "memory", "gpu", "network"],
  ),
  inventory(
    "database-sidecar-checkpoint-dbos",
    "P-015",
    [
      "packages/operator-core/lib/db",
      "packages/operator-core/lib/derived-",
      "packages/operator-core/lib/harness/routines/",
    ],
    ["cpu", "memory", "database", "process"],
  ),
  inventory(
    "p2p-sync-index-cache-compaction",
    "P-016",
    [
      "packages/operator-core/lib/p2p/",
      "packages/operator-core/lib/sync/",
      "packages/operator-core/lib/search/",
    ],
    ["cpu", "memory", "network", "disk"],
  ),
  inventory(
    "ci-release-test-workers",
    "P-016",
    [
      "packages/operator-core/lib/release/",
      "apps/operator/lib/release/",
      "scripts/",
    ],
    ["cpu", "memory", "process", "disk"],
  ),
  inventory(
    "background-routines-watchdogs",
    "P-016",
    [
      "packages/operator-core/lib/system-health/",
      "packages/operator-core/lib/harness/routines/",
      "packages/operator-core/lib/events/",
    ],
    ["cpu", "memory", "database", "network"],
  ),
  {
    id: "governor-core",
    disposition: "govern",
    enforcement: "active",
    paths: ["packages/operator-core/lib/resource-governor/"],
    resourceDimensions: ["cpu", "memory", "process", "database", "network"],
    fanOut: "typed admissionClass plus child AdmissionContext lineage",
    durableSource: "work_items-backed durable queue receipts",
    telemetry:
      "governor health/admission/queue/resources/recovery state snapshot",
    contextAndRelease:
      "AdmissionContext propagated to exact Governor.release(actualDemand)",
    currentCaps: "none; desired windows are transient feedback state",
    writerEvidence:
      "Governor.admit + valid local lease + AdmissionContext + Governor.release + governor state writer",
  },
]);

/**
 * D-004's exemption registry: "Control, release, and non-resident work bypass
 * explicitly. The registry owns exemptions and lint enforces them; callers cannot
 * self-exempt."
 *
 * Two design constraints, both load-bearing:
 *
 *   1. THE REGISTRY OWNS IT, NOT THE CALL SITE. There is deliberately no inline
 *      pragma (`// governor-exempt`). An exemption a caller can write next to its
 *      own spawn is self-exemption, which D-004 forbids in as many words. Adding a
 *      row here is a reviewable diff in a file whose whole purpose is being read.
 *
 *   2. KEYED BY (path, findingCode), NOT BY PATH. A file-level exemption is too
 *      coarse: `capability/bash-jobs.ts` genuinely bypasses admission for a control
 *      kill, but that says nothing about whether it also parks an unbounded resident
 *      queue. Exempting the file would silently retire a check nobody judged — the
 *      decorative-allowlist failure documented at length in
 *      check-no-unenrolled-detached-spawn.mjs ("an allowlist is evidence of what a
 *      guard was ASKED to ignore, never evidence of what it can SEE").
 *
 * `disposition` reuses the inventory vocabulary. Use `bypass` for work that cannot
 * materially increase residency, `upstream` when a physical constraint is observed
 * rather than duplicated, `semantic` for a policy limit that is not a capacity cap.
 * `false-positive` does NOT belong here — a detector that misfires is a detector bug
 * to fix, and registering it would preserve the bug behind a row that reads as
 * judgement.
 *
 * Shrinking this list is the point. Every row states what the process actually does.
 */
export const BYPASS_REGISTRY = new Map([
  // ── cheap metadata reads: a git plumbing call that prints and exits ──────────
  // These are D-004's "cheap metadata operations that cannot materially increase
  // residency": single short-lived plumbing processes, awaited, no worker, no queue.
  // Governing them would add an admission round-trip per call to operations whose
  // whole cost is less than the admission record they would write.
  [
    'packages/operator-core/lib/agent-tools/plans/audit.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git rev-parse HEAD — cheap metadata read, awaited, exits immediately' },
  ],
  [
    'packages/operator-core/lib/agent-tools/plans/git-history.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git rev-parse --show-toplevel — cheap metadata read, awaited, exits immediately' },
  ],
  [
    'packages/operator-core/lib/agent-tools/plans/viewer-identity.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git config user.email — cheap metadata read, awaited, exits immediately' },
  ],
  [
    'packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git ls-tree — cheap metadata read over one commit, awaited, exits immediately' },
  ],
  [
    'apps/operator/bin/ascii-escape-bundle.mjs::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'node --check over one staged bundle — awaited syntax validation before atomic replacement, not resident runtime work' },
  ],
  // ── liveness/capability probes: ask the OS a question, start nothing ─────────
  [
    'apps/operator/bin/serve.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'ps -o command= -p <pid> — reads one process table row to identify a peer; starts no work' },
  ],
  [
    'packages/operator-core/lib/endpoint-route/routes/desktop/setup-pty-commands.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'which gh — binary-presence probe, exits immediately' },
  ],
  [
    'packages/operator-core/lib/agent-tools/computer/desktop-provisioner.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'xdpyinfo -display — X display liveness probe; the provisioning start it guards is governed separately' },
  ],
  [
    'packages/operator-core/lib/agent-tools/capability/exec-sandbox.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'bwrap /bin/true — one cached sandbox capability probe with a five-second timeout; starts no resident work' },
  ],
  [
    'packages/operator-core/lib/agent-tools/coordination/machine-capability-tags.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'docker info — one cached machine-capability probe with a 1.5-second timeout; starts no resident work' },
  ],
  // ── release / control path: D-004 names these explicitly ─────────────────────
  // Admission must never gate the path that RELEASES resources, or a saturated host
  // cannot recover: the kill that would free capacity would itself queue behind the
  // capacity it is trying to free. This is a deadlock, not an optimisation.
  [
    'packages/operator-core/lib/agent-tools/capability/bash-jobs.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'systemctl --user kill — cancellation/release of an already-admitted job; gating release on admission deadlocks recovery under saturation' },
  ],
  [
    'packages/operator-core/lib/agent-tools/dev/restart.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'delayed systemd restart — control/recovery path that releases the current operator and must remain runnable under saturation' },
  ],
  [
    'packages/operator-core/lib/endpoint-route/routes/harness/features.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git worktree remove + branch delete — feature teardown releases filesystem/process coordination state and must remain runnable under saturation' },
  ],
  // ── bounded benchmark/diagnostic work ───────────────────────────────────────
  // These paths either inspect metadata or drain a finite, caller-owned fixture.
  // They do not create resident service work and therefore do not need a second
  // durable admission receipt; keep the exemption explicit and reviewable.
  [
    'packages/operator-core/lib/dbos/bootstrap.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git rev-parse used only to locate the canonical checkout before arming a watchdog; no resident work starts' },
  ],
  [
    'packages/operator-core/lib/memory/audit-anchors.ts::resource-start-outside-admission',
    { disposition: 'bypass', reason: 'git ls-files builds a bounded read-only index of repository anchors; it starts no resident work' },
  ],
  [
    'packages/operator-core/lib/memory/bench/wi-6512-known-item-replay-cli.ts::unbounded-resident-queue',
    { disposition: 'semantic', reason: 'finite in-memory benchmark pair list is test workload enumeration, not a resident production queue; evidence required' },
  ],
  [
    'packages/operator-core/lib/memory/op-deadline.ts::unbounded-resident-queue',
    { disposition: 'semantic', reason: 'pending promise set tracks already-started memory operations until settlement; it is a lifecycle ledger, not queued work; evidence required' },
  ],
  [
    'packages/operator-core/lib/inference-gateway/stall-waker.ts::unbounded-resident-queue',
    { disposition: 'semantic', reason: 'pending map is a TTL-bounded stall observation set; it never queues resource starts; evidence required' },
  ],
  // ── P-013 agent-process-memory lane (D-026 remediation) ──────────────────────
  // The lane's governed seams are pty-bridge.ts:192 (beginGovernedExecution,
  // admissionClass 'process' -> spawn :247), resource-governor/spawn-execution.ts:46
  // (admissionClass 'agent'), and fleet/sidecar-exec-process.ts:96. The rows below are
  // the residue those seams deliberately do NOT cover: probes, release/control calls,
  // and correlation ledgers. Each states what its own process actually does.
  [
    'apps/operator/scripts/psu-launcher.mjs::resource-start-outside-admission',
    {
      disposition: 'bypass',
      reason:
        'launcher CLI, 9 detected starts, every one a bounded probe or an interactive install: curl operator-health (:225,:250,:4390,:8214), systemctl unit query (:241), gh auth token (:5136), ps -o tty= (:6722), which-bin probe (:11660), runInstallerInherit (:11739, awaited, stdio inherit, one backend install). ⚠ EVIDENCE OF WHAT THIS ROW DOES NOT COVER: the file ALSO starts the real resident agent wrapper at spawnInherit (:8342) via spawnImpl(wrapperBin, args, {detached:true}) (:8367), where `spawnImpl = spawn` is defaulted at :8347 — the START regex cannot match an aliased call, so that start is registered here by hand rather than detected. It is admitted upstream when operator-launched (capability/launch-agent.ts:1250 -> spawnGovernedAgentProcess -> beginGovernedExecution admissionClass "agent"); a human typing psu in a terminal is the operator entry path itself, not fleet-initiated fan-out. Detector gap tracked separately; evidence required',
    },
  ],
  [
    'apps/operator/scripts/psu-pty-host.mjs::resource-start-outside-admission',
    {
      disposition: 'bypass',
      reason:
        'pty.spawn (:3743) starts the launched agent\'s OWN child under the host that already represents it; admission happened upstream at capability/launch-agent.ts:1250 -> spawnGovernedAgentProcess -> beginGovernedExecution admissionClass "agent" (spawn-execution.ts:46). Re-admitting the same logical agent inside its own host would double-count it. The other two START hits are a detector coincidence, not starts: turnCoalescer.admit (:4820) and staleFireGuard.admit (:5041) are local fold/dedupe methods matched by the `.admit(` alternative; evidence required',
    },
  ],
  [
    'apps/operator/scripts/psu-pty-host.mjs::unbounded-resident-queue',
    {
      disposition: 'semantic',
      reason:
        'neither collection queues resource starts. :1726 pending.add(key) is a respawn re-poll DEDUPE set — an arriving duplicate returns "duplicate"/"superseded" instead of enqueuing, and the key is removed on delivery. :3002 pending.set(...) is makeTurnCoalescer folding repeat injects onto ONE waiter (newest-wins, folded++). Both are keyed by inject key and bounded by distinct in-flight injects, not by arrival rate; same lifecycle-ledger shape as memory/op-deadline.ts; evidence required',
    },
  ],
  [
    'packages/operator-core/lib/agent-auth-detect.ts::resource-start-outside-admission',
    {
      disposition: 'bypass',
      reason:
        'seven credential-presence probes, all spawnSync (awaited by construction) with explicit timeouts and no resident work: security find-generic-password (:42,:87), security dump-keychain (:100), a keychain read (:130), gh auth status (:312), git config --get-all credential.helper (:318). Same cheap-metadata class as agent-tools/plans/viewer-identity.ts; evidence required',
    },
  ],
  [
    'packages/operator-core/lib/agent-bin-detect.ts::resource-start-outside-admission',
    {
      disposition: 'bypass',
      reason:
        'spawnSync("which", [bin]) (:111) — single binary-presence probe, awaited, exits immediately. Identical to the already-registered setup-pty-commands.ts "which gh" row; evidence required',
    },
  ],
  [
    'packages/operator-core/lib/agent-state-divergence.ts::unbounded-resident-queue',
    {
      disposition: 'semantic',
      reason:
        'pending.push(c) (:704) appends to a LOCAL DivergenceCall[] that cuts an already-materialized call timeline into consecutive-failure episodes; it is reset to [] at every success and discarded when the loop ends. It is an analysis buffer over finite input, bounded by the timeline being read, and starts nothing; evidence required',
    },
  ],
  [
    'packages/operator-core/lib/fleet/spawner-ipc-client.ts::unbounded-resident-queue',
    {
      disposition: 'semantic',
      reason:
        'this.pending.set(id, {resolve, reject}) (:186) is an in-flight RPC CORRELATION map, not queued work: every entry is self-evicting via a 30s default timeout that deletes it (:176-178) and both settle paths delete it. Bounded by concurrently in-flight RPCs; the requests it correlates were already started. Same lifecycle-ledger shape as memory/op-deadline.ts; evidence required',
    },
  ],
  [
    'packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts::resource-start-outside-admission',
    {
      disposition: 'bypass',
      reason:
        'killOwnedScope (:62) execFileSync systemctl --user kill of the sidecar\'s OWN managed scope — a RELEASE/control call that frees residency. Synchronous on purpose: its call sites are a process-exit hook and a timer callback, neither of which has an async turn left. Gating release on admission deadlocks recovery under saturation, exactly as the registered bash-jobs.ts row states; evidence required',
    },
  ],
]);

function registryKey(path, code) {
  return `${path}::${code}`;
}

/**
 * Build one inventory row. Every descriptive field is REQUIRED and none has a
 * default — deliberately.
 *
 * The previous signature defaulted fanOut/durableSource/telemetry/contextAndRelease/
 * currentCaps/writerEvidence to five shared constants, so every lane inherited
 * identical prose and `validateInventory`'s presence check passed while the
 * inventory described nothing (auditSeq 9, D-026). Removing the defaults is what
 * makes that regression structurally impossible rather than merely detected: a new
 * lane cannot be decorative by omission, because omission no longer compiles into
 * boilerplate — it produces `undefined` and trips `inventory-missing`.
 */
function inventory(row) {
  return Object.freeze({
    disposition: "govern",
    ...row,
    enforcement: row.enforcement ?? `pending-${row.migration}`,
    sites: Object.freeze((row.sites ?? []).map((s) => Object.freeze(s))),
  });
}

const START =
  /(?:\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(|new\s+(?:Worker|Piscina)\s*\(|\.admit\s*\()/;
const GOVERNED =
  /\bGovernor\.admit\b|\bgovernor\.admit\s*\(|\bbeginGovernedExecution\s*\(|\bwithGovernedExecution\s*\(|\brunGovernedOperation\s*\(|\brunGovernedTestProcess\s*\(|\bAdmissionContext\b|\bvalid(?:ated)?\s+local\s+lease\b/i;
const RELEASE = /\.release\s*\(|\bAdmissionRelease\b/;
const STATIC_CAP =
  /\b(?:maxConcurrent|maxWorkers|maxQueue|maxSimultaneous|capacityCeiling)\b\s*(?:[:=]|\?\?)\s*\d+/i;
const HIDDEN_SEMAPHORE = /\b(?:Semaphore|semaphore|p-limit|Bottleneck)\b/;
const DURABLE = /\b(?:work_items|durable|receipt|postgres|DBOS)\b/i;
// Match collections whose identifier says they are a queue/backlog.  The old
// `(?:queue|pending|backlog)\w*` prefix also matched diagnostic Sets such as
// `pendingGradingAuditTargetIds.add(...)`: that is an ID accumulator, not a
// resident work queue, and made the active P-014 lane fail on its own gate
// bookkeeping.  Keep the exact `pending` spelling for the small conventional
// case, while requiring a Queue/Backlog suffix for compound names so pending
// IDs, tokens, and targets do not look like resident work.
const RESIDENT_QUEUE =
  /\b(?:queue|backlog|pending|[A-Za-z_$][\w$]*(?:Queue|Backlog))\.(?:push|set|add)\s*\(/;
const RETRY_RECEIPT =
  /(?:receipt[\s\S]{0,180}(?:retry|again)|(?:retry|again)[\s\S]{0,180}receipt)/i;
const DISHONEST_METRIC =
  /\b(?:oldestAgeMs|arrivalRatePerSec|drainRatePerSec|confidence)\b[^\n]{0,80}\?\?\s*0\b/;

export function inspectGovernorSource(source) {
  const code = stripCommentsAndStrings(source, "fixture.ts");
  const findings = [];
  if (START.test(code) && !GOVERNED.test(code))
    findings.push("resource-start-outside-admission");
  if (
    (STATIC_CAP.test(code) || HIDDEN_SEMAPHORE.test(code)) &&
    !/transient feedback state|physical upstream constraint/i.test(code)
  ) {
    findings.push("hidden-or-static-capacity");
  }
  if (RESIDENT_QUEUE.test(code) && !DURABLE.test(code))
    findings.push("unbounded-resident-queue");
  if (RETRY_RECEIPT.test(code)) findings.push("retry-around-receipt");
  if (
    /\bgovernor\.admit\s*\(/.test(code) &&
    (!/\bAdmissionContext\b/.test(code) || !RELEASE.test(code))
  ) {
    findings.push("missing-admission-context-or-release");
  }
  if (DISHONEST_METRIC.test(code))
    findings.push("undefined-partial-or-stale-metric-coerced-to-zero");
  return findings;
}

/**
 * P-001 acceptance is that each admission SITE names its own resource dimensions,
 * fan-out, durable source, telemetry, context/release path and the cap to delete.
 *
 * A PRESENCE check cannot enforce that, and the audit (auditSeq 9) proved it: the
 * seven lanes shared five identical boilerplate constants, satisfied `required`
 * completely, and carried no per-site information whatsoever. A field that every
 * row can satisfy with the SAME string is not describing anything — it is a check
 * that cannot fail. So presence is necessary and no longer sufficient:
 *
 *   1. NO SHARED BOILERPLATE. If two rows give byte-identical prose for a
 *      descriptive field, neither row is describing itself. Duplicate ⇒ finding.
 *   2. SITES ARE NAMED, NOT IMPLIED. Every governed lane enumerates the concrete
 *      admission sites it owns; a lane that names none is a path prefix, not an
 *      inventory.
 *   3. NAMED SITES MUST EXIST. `pathExists` (injected by scanTree, omitted by pure
 *      callers) resolves each site against the tree, so the inventory cannot drift
 *      into citing files that were renamed or deleted — the decorative-inventory
 *      failure one level up from the decorative-allowlist one.
 */
const DESCRIPTIVE_FIELDS = [
  "fanOut",
  "durableSource",
  "telemetry",
  "contextAndRelease",
  "currentCaps",
  "writerEvidence",
];

export function validateInventory(
  rows = RESOURCE_GOVERNOR_INVENTORY,
  { pathExists = null } = {},
) {
  const findings = [];
  const ids = new Set();
  const required = [
    "id",
    "disposition",
    "enforcement",
    "paths",
    "resourceDimensions",
    "fanOut",
    "durableSource",
    "telemetry",
    "contextAndRelease",
    "currentCaps",
    "writerEvidence",
    "sites",
  ];
  // (1) shared boilerplate across rows — the exact defect auditSeq 9 found.
  for (const field of DESCRIPTIVE_FIELDS) {
    const seen = new Map();
    for (const row of rows) {
      const value = row[field];
      if (typeof value !== "string" || value === "") continue;
      const norm = value.trim().replace(/\s+/g, " ");
      if (!seen.has(norm)) seen.set(norm, []);
      seen.get(norm).push(row.id);
    }
    for (const [, sharers] of seen) {
      if (sharers.length > 1)
        findings.push(
          `inventory-boilerplate:${field}:${sharers.sort().join("+")}`,
        );
    }
  }
  for (const row of rows) {
    if (ids.has(row.id)) findings.push(`duplicate-inventory:${row.id}`);
    ids.add(row.id);
    for (const field of required) {
      const value = row[field];
      if (
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      )
        findings.push(`inventory-missing:${row.id}:${field}`);
    }
    // (2)+(3) named sites, and they must resolve against the tree.
    for (const site of row.sites ?? []) {
      if (!site?.path || !site?.start)
        findings.push(`inventory-site-incomplete:${row.id}`);
      else if (pathExists && !pathExists(site.path))
        findings.push(`inventory-site-missing:${row.id}:${site.path}`);
    }
    if (
      !["govern", "bypass", "semantic", "upstream", "false-positive"].includes(
        row.disposition,
      )
    )
      findings.push(`inventory-disposition:${row.id}`);
    if (
      ["bypass", "semantic", "upstream"].includes(row.disposition) &&
      !/evidence|required|constraint|registry/i.test(row.writerEvidence ?? "")
    ) {
      findings.push(`inventory-writer-evidence:${row.id}`);
    }
  }
  return findings;
}

export function scanInventory(
  files,
  { migrations = [], validateRegistry = false } = {},
) {
  const selected = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) =>
      row.enforcement === "active" ||
      migrations.some((migration) => row.enforcement === `pending-${migration}`),
  );
  const findings = [];
  const scannedPaths = new Set();
  const observedRegistryKeys = new Set();
  for (const [path, source] of files) {
    if (
      !selected.some((row) => row.paths.some((prefix) => path.startsWith(prefix)))
    )
      continue;
    scannedPaths.add(path);
    for (const code of inspectGovernorSource(source)) {
      const key = registryKey(path, code);
      observedRegistryKeys.add(key);
      if (!BYPASS_REGISTRY.has(key))
        findings.push(`${path}:${code}`);
    }
  }
  if (validateRegistry) {
    for (const key of BYPASS_REGISTRY.keys()) {
      const separator = key.lastIndexOf("::");
      const path = key.slice(0, separator);
      const selectedPath = selected.some((row) =>
        row.paths.some((prefix) => path.startsWith(prefix)),
      );
      if (!selectedPath) continue;
      if (!scannedPaths.has(path)) {
        if (validateRegistry === "strict")
          findings.push(`stale-bypass-registry:${key}:path-not-scanned`);
        continue;
      }
      if (!observedRegistryKeys.has(key))
        findings.push(`stale-bypass-registry:${key}:finding-absent`);
    }
  }
  return findings;
}

export function scanActiveInventory(files, options = {}) {
  return scanInventory(files, options);
}

function scanTree() {
  const { files, unscanned } = listTrackedFiles(ROOT);
  const sourceFiles = [];
  for (const path of files) {
    if (
      !/\.(?:ts|tsx|mts|mjs)$/.test(path) ||
      /\.(?:test|spec)\./.test(path) ||
      path.includes("/_retired/")
    )
      continue;
    try {
      sourceFiles.push([path, readFileSync(`${ROOT}${path}`, "utf8")]);
    } catch {
      /* concurrent deletion */
    }
  }
  return {
    findings: [
      ...validateInventory(),
      ...scanActiveInventory(sourceFiles, { validateRegistry: "strict" }),
    ],
    unscanned,
  };
}

function main() {
  const { findings, unscanned } = scanTree();
  if (findings.length === 0) {
    console.log(
      `[resource-governor-enforcement] OK — ${RESOURCE_GOVERNOR_INVENTORY.length} subsystem lanes inventoried; active writer evidence clean${unscanned.length ? `; ${unscanned.length} unscanned submodule(s)` : ""}.`,
    );
    return;
  }
  console.error(
    "[resource-governor-enforcement] FAIL — capless admission/queue/state policy violations:",
  );
  for (const finding of findings) console.error(`  ${finding}`);
  console.error(
    "\nDo not add a new cap. Route the start through Governor.admit or a registered valid lease, preserve its durable receipt and AdmissionContext, release exact actual cost, and publish honest unknown/stale state. Semantic/policy/upstream constraints require explicit writer evidence.",
  );
  process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) main();
