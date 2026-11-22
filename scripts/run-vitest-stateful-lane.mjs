#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants } from "node:os";

import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { openVitestLaneLedger } from "./lib/vitest-lane-ledger.mjs";

function runVitest(args, { env, stderr }) {
  const command = process.platform === "win32" ? "vitest.cmd" : "vitest";
  const { status, signal, error } = spawnSync(command, args, { env, stdio: "inherit" });
  if (error) {
    stderr.write(`stateful Vitest launcher failed: ${error.message}\n`);
    if (error.code === "ENOENT") return 127;
    if (error.code === "EACCES") return 126;
  }
  return status ?? (signal ? 128 + constants.signals[signal] : 1);
}

export async function runStatefulLane({
  env = process.env,
  forwardedArgs = process.argv.slice(2),
  run = runVitest,
  stderr = process.stderr,
  wsAbsDir = process.cwd(),
} = {}) {
  const ledger = await openVitestLaneLedger({ lane: "stateful", env, wsAbsDir, stderr });
  const argv = ["run", "--passWithNoTests", ...forwardedArgs];
  const shard = 1;
  const childEnv = ledger.envForShard(shard);
  const code = await run(argv, { env: childEnv, stderr });
  const ledgerComplete = await ledger.settle({ env: childEnv, argv, code, shard });
  return code || (ledgerComplete ? 0 : 2);
}

if (isCliEntry(import.meta.url)) {
  runStatefulLane().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
