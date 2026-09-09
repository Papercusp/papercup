import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrgPg } from "@papercusp/db-org";
import { mapDreamRun } from "../../packages/operator-core/lib/dream/dream-run-store.ts";
import { STUDY_BLOCKS, validateStudyBlocks } from "./accounting.mts";
import { buildCalibrationBundle } from "./calibration.mts";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = "papercusp-workspace";
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blocks = await Promise.all(
  Object.values(STUDY_BLOCKS).map(async (b) =>
    JSON.parse(await readFile(resolve(here, b.file), "utf8")),
  ),
);
validateStudyBlocks(blocks);
const pins = blocks.map((b) => b.pin);
const { sql } = getOrgPg();
try {
  // An uncapped census over exactly the frozen study identities; no live/global backlog.
  const rows = await sql`
    SELECT * FROM harness_shared.dream_runs
    WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
      AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
    ORDER BY started_at, run_id`;
  const { blind, key } = buildCalibrationBundle(rows.map(mapDreamRun));
  // Immutable evidence: re-running may verify, never silently replace a frozen batch.
  for (const [file, value] of [
    ["calibration-blind.json", blind],
    ["calibration-key.json", key],
  ] as const) {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    const target = resolve(here, file);
    try {
      await writeFile(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(target, "utf8")) !== bytes)
        throw new Error("Frozen calibration batch changed: " + file);
    }
  }
  console.log(
    JSON.stringify({
      blindHash: key.blindHash,
      population: key.population,
      eligibleCandidates: key.eligibleCandidates,
      selected: blind.cases.length,
      excluded: key.excluded.length,
      strata: [...new Set(key.selected.map((c) => c.stratum))].length,
      independentLabels: key.independentLabels,
      providerCalls: 0,
      ledgerWrites: 0,
      source: "existing frozen dream_runs; original review unchanged",
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
