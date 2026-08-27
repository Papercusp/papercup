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
import { stripCommentsOnly } from "./lib/strip-comments-and-strings.mjs";

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

function inventory(id, migration, paths, resourceDimensions) {
  return Object.freeze({
    id,
    disposition: "govern",
    enforcement: `pending-${migration}`,
    paths,
    resourceDimensions,
    fanOut: "measured at each migrated writer; no configured ceiling",
    durableSource:
      "the source durable job/work-item/receipt; never an in-memory resident queue",
    telemetry: "bounded governor state with unknown/stale preserved",
    contextAndRelease:
      "AdmissionContext lineage and exact actual-cost release required at migration",
    currentCaps: `delete during ${migration} after focused validation`,
    writerEvidence: `required when ${migration} activates this lane`,
  });
}

const START =
  /(?:\b(?:spawn|spawnSync|fork|execFile|execFileSync)\s*\(|new\s+(?:Worker|Piscina)\s*\(|\.admit\s*\()/;
const GOVERNED =
  /\bGovernor\.admit\b|\bgovernor\.admit\s*\(|\bAdmissionContext\b|\bvalid(?:ated)?\s+local\s+lease\b/i;
const RELEASE = /\.release\s*\(|\bAdmissionRelease\b/;
const STATIC_CAP =
  /\b(?:maxConcurrent|maxWorkers|maxQueue|maxSimultaneous|capacityCeiling)\b\s*(?:[:=]|\?\?)\s*\d+/i;
const HIDDEN_SEMAPHORE = /\b(?:Semaphore|semaphore|p-limit|Bottleneck)\b/;
const DURABLE = /\b(?:work_items|durable|receipt|postgres|DBOS)\b/i;
const RESIDENT_QUEUE = /\b(?:queue|pending|backlog)\w*\.(?:push|set|add)\s*\(/i;
const RETRY_RECEIPT =
  /(?:receipt[\s\S]{0,180}(?:retry|again)|(?:retry|again)[\s\S]{0,180}receipt)/i;
const DISHONEST_METRIC =
  /\b(?:oldestAgeMs|arrivalRatePerSec|drainRatePerSec|confidence)\b[^\n]{0,80}\?\?\s*0\b/;

export function inspectGovernorSource(source) {
  const code = stripCommentsOnly(source, "fixture.ts");
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

export function validateInventory(rows = RESOURCE_GOVERNOR_INVENTORY) {
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
  ];
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

export function scanActiveInventory(files) {
  const active = RESOURCE_GOVERNOR_INVENTORY.filter(
    (row) => row.enforcement === "active",
  );
  const findings = [];
  for (const [path, source] of files) {
    if (
      !active.some((row) => row.paths.some((prefix) => path.startsWith(prefix)))
    )
      continue;
    for (const code of inspectGovernorSource(source))
      findings.push(`${path}:${code}`);
  }
  return findings;
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
    findings: [...validateInventory(), ...scanActiveInventory(sourceFiles)],
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
