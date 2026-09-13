#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { resolveLaneInclude } from "@papercusp/test-config/lane-split";

/**
 * A non-isolated Vitest fork retains the transformed module graph for every file it runs.
 * The current suite died after about 1,295 completed files per two-worker fork. Keep the bound
 * materially below that measured ceiling and derive shard count from the live lane census, so
 * adding more tests creates more fresh forks instead of silently arming the same OOM again.
 */
export const PURE_LANE_MAX_FILES_PER_FRESH_FORK = 750;

const WORKER_ENV_KEYS = [
  "VITEST_MAX_WORKERS",
  "VITEST_MAX_FORKS",
  "VITEST_MAX_THREADS",
];

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Convert the existing global worker cap into sequential shards. The product of workers and
 * shards is at least PURE_LANE_TARGET_FRESH_FORKS, but concurrency never exceeds the caller's
 * cap: shards run one after another, each through the same admitted pc-heavy scope.
 */
export function resolvePureLaneShardCount(
  env = process.env,
  pureFileCount = 0,
) {
  if (!Number.isInteger(pureFileCount) || pureFileCount < 0) {
    throw new Error(`invalid pure-lane file count ${pureFileCount}`);
  }
  const caps = WORKER_ENV_KEYS.flatMap((key) => {
    const value = positiveInteger(env[key]);
    return value === null ? [] : [value];
  });
  // The shared Vitest config defaults to at least eight forks when no explicit cap exists.
  const workerCap = caps.length > 0 ? Math.min(...caps) : 8;
  const freshForksNeeded = Math.max(
    1,
    Math.ceil(pureFileCount / PURE_LANE_MAX_FILES_PER_FRESH_FORK),
  );
  return Math.max(1, Math.ceil(freshForksNeeded / workerCap));
}

export function buildPureLaneShardArgs(shard, shardCount, forwardedArgs = []) {
  if (
    !Number.isInteger(shard) ||
    shard < 1 ||
    shard > shardCount ||
    shardCount < 1
  ) {
    throw new Error(`invalid Vitest shard ${shard}/${shardCount}`);
  }
  if (
    forwardedArgs.some((arg) => arg === "--shard" || arg.startsWith("--shard="))
  ) {
    throw new Error(
      "test:lane-pure owns Vitest sharding; do not pass --shard explicitly",
    );
  }
  return [
    "run",
    "--passWithNoTests",
    ...forwardedArgs,
    ...(shardCount > 1 ? [`--shard=${shard}/${shardCount}`] : []),
  ];
}

export function runVitestProcess(args, { env = process.env } = {}) {
  const command = process.platform === "win32" ? "vitest.cmd" : "vitest";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        process.stderr.write(
          `VITEST_PURE_LANE_SHARD state=signaled signal=${signal}\n`,
        );
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/** Run every shard for complete failure inventory; return the first non-zero result. */
export async function runPureLaneShards({
  env = process.env,
  forwardedArgs = process.argv.slice(2),
  run = (args) => runVitestProcess(args, { env }),
  stderr = process.stderr,
} = {}) {
  const pureFileCount =
    resolveLaneInclude(process.cwd(), "pure").include?.length ?? 0;
  if (pureFileCount === 0) {
    throw new Error(
      `PC_TEST_LANE=pure found ZERO files under ${process.cwd()}`,
    );
  }
  const shardCount = resolvePureLaneShardCount(env, pureFileCount);
  const workerCaps = WORKER_ENV_KEYS.map((key) =>
    positiveInteger(env[key]),
  ).filter((value) => value !== null);
  const workerCap = workerCaps.length > 0 ? Math.min(...workerCaps) : "default";
  let result = 0;
  for (let shard = 1; shard <= shardCount; shard += 1) {
    const args = buildPureLaneShardArgs(shard, shardCount, forwardedArgs);
    stderr.write(
      `VITEST_PURE_LANE_SHARD state=started shard=${shard}/${shardCount} ` +
        `workerCap=${workerCap} pureFiles=${pureFileCount}\n`,
    );
    const code = await run(args);
    stderr.write(
      `VITEST_PURE_LANE_SHARD state=finished shard=${shard}/${shardCount} exitStatus=${code}\n`,
    );
    if (result === 0 && code !== 0) result = code;
  }
  return result;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await runPureLaneShards();
