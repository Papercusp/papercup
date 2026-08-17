/**
 * provisioner/unit-drift — detect a DEPLOYED systemd unit that no longer matches the config its
 * catalog entry claims (and, for a certified entry, the config that was actually certified).
 * Plan: on-demand-local-inference-lifecycle-2026-08-17 (P-010), decision D-007.
 *
 * WHY THIS EXISTS. `llama-ornith.service` ran `-np 3 -c 614400 --cache-type-k q4_0` for weeks
 * while its catalog entry said 2 / 180224 / q8_0 and carried a `status:'certified'` stamp earned
 * on the catalog's numbers. Nothing noticed, for two compounding reasons:
 *
 *   1. the unit is a hand-managed local file with NO repo source, so no diff ever showed it; and
 *   2. the one test that looked at unit rendering — `backend-config.test.ts` — asserted only
 *      host and port, and asserted them against `renderLlamaServerUnit`'s OWN output.
 *
 * Reason 2 is the trap worth naming, because it is the shape a guard naturally grows into: a
 * test that re-asserts the generator against a literal proves the GENERATOR IS STABLE. It cannot
 * observe the deployed file at all, so it stays green through exactly the failure it appears to
 * cover. This module therefore compares GENERATED against DEPLOYED, parsing both through the
 * same parser so a renderer bug and a hand-edit are both in range.
 *
 * WHAT IS DELIBERATELY NOT COMPARED: `-m <weightsPath>`, log paths, `Description`, ordering and
 * whitespace. Those are legitimately per-box (the catalog cannot know this machine's blob path),
 * and folding them in would make the guard cry wolf on every install until someone silenced it —
 * which is how a guard dies. The operative inference parameters are the ones that change what
 * the server actually does, and they are the ones that drifted.
 */
import type { CatalogEntry } from './catalog';
import { renderLlamaServerUnit } from './backend-config';

export interface LlamaServerUnitParams {
  host: string | null;
  port: number | null;
  parallelSlots: number | null;
  ctxTotal: number | null;
  kvCacheTypeK: string | null;
  kvCacheTypeV: string | null;
  flashAttn: boolean | null;
  alias: string | null;
}

/**
 * Pull the operative llama-server flags out of a systemd unit's `ExecStart`.
 *
 * Handles systemd's backslash line-continuations, which is the whole reason this is a parser and
 * not a regex over the file: every real unit here spreads ExecStart across seven lines, so a
 * naive per-line match sees `-np 2 -c 180224` and `--cache-type-k q8_0` as unrelated fragments.
 *
 * A field is `null` when the flag is absent — never a default. A guard that silently substitutes
 * a default for a missing flag reports agreement between a unit that sets a value and one that
 * does not, which is a drift.
 */
export function parseLlamaServerUnit(unitText: string): LlamaServerUnitParams {
  const lines = unitText.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('ExecStart='));
  const params: LlamaServerUnitParams = {
    host: null,
    port: null,
    parallelSlots: null,
    ctxTotal: null,
    kvCacheTypeK: null,
    kvCacheTypeV: null,
    flashAttn: null,
    alias: null,
  };
  if (start === -1) return params;

  // Re-join the continuation lines into one command before tokenising.
  const parts: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    const continued = raw.trimEnd().endsWith('\\');
    parts.push(continued ? raw.trimEnd().slice(0, -1) : raw);
    if (!continued) break;
  }
  const tokens = parts.join(' ').replace(/^\s*ExecStart=/, '').trim().split(/\s+/).filter(Boolean);

  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    switch (tokens[i]) {
      case '--host':
        params.host = tokens[i + 1] ?? null;
        break;
      case '--port':
        params.port = num(tokens[i + 1]);
        break;
      case '-np':
      case '--parallel':
        params.parallelSlots = num(tokens[i + 1]);
        break;
      case '-c':
      case '--ctx-size':
        params.ctxTotal = num(tokens[i + 1]);
        break;
      case '--cache-type-k':
        params.kvCacheTypeK = tokens[i + 1] ?? null;
        break;
      case '--cache-type-v':
        params.kvCacheTypeV = tokens[i + 1] ?? null;
        break;
      case '--flash-attn':
        // llama-server takes `--flash-attn on|off`; treat a bare flag as enabled.
        params.flashAttn = tokens[i + 1] === 'off' ? false : true;
        break;
      case '--alias':
        params.alias = tokens[i + 1] ?? null;
        break;
      default:
        break;
    }
  }
  return params;
}

export interface UnitDrift {
  param: keyof LlamaServerUnitParams;
  generated: string;
  deployed: string;
}

/** Compare two units' operative parameters. Empty ⇒ no drift. */
export function diffUnitParams(generated: LlamaServerUnitParams, deployed: LlamaServerUnitParams): UnitDrift[] {
  const drift: UnitDrift[] = [];
  for (const key of Object.keys(generated) as Array<keyof LlamaServerUnitParams>) {
    const g = generated[key];
    const d = deployed[key];
    if (g !== d) drift.push({ param: key, generated: String(g), deployed: String(d) });
  }
  return drift;
}

/**
 * The guard's main entry point: render the unit this catalog entry DESCRIBES, then compare it to
 * the unit actually deployed.
 *
 * `weightsPath`/`binPath`/`logPath` are irrelevant to the comparison (see the header) but the
 * renderer requires them, so they are filled from the deployed unit where possible and are never
 * compared.
 */
export function diffCatalogAgainstDeployedUnit(entry: CatalogEntry, deployedUnitText: string): UnitDrift[] {
  const generatedText = renderLlamaServerUnit({
    alias: entry.model.ollamaRef,
    weightsPath: 'IRRELEVANT-NOT-COMPARED',
    host: entry.serve.host,
    port: entry.serve.portDefault,
    parallelSlots: entry.serve.parallelSlots,
    ctxTotal: entry.serve.ctxTotal,
    kvCacheType: entry.serve.kvCacheType,
    flashAttn: entry.serve.flashAttn,
    jinja: entry.serve.jinja,
    reasoningBudget: entry.serve.reasoningBudget,
    logPath: 'IRRELEVANT-NOT-COMPARED',
  });
  // Both sides go through the SAME parser on purpose: that is what puts a renderer regression in
  // range of this guard, instead of only a hand-edit to the deployed file.
  return diffUnitParams(parseLlamaServerUnit(generatedText), parseLlamaServerUnit(deployedUnitText));
}

/** One-line human summary for a log or a test failure message. */
export function describeUnitDrift(drift: readonly UnitDrift[]): string {
  if (drift.length === 0) return 'no drift';
  return drift.map((d) => `${d.param}: catalog=${d.generated} deployed=${d.deployed}`).join(' · ');
}
